import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type {
  AssertionCommandRunner,
  CommandExecutionRequest,
  CommandExecutionResult
} from "./types.js";

export interface HostCommandRunnerOptions {
  readonly workspaceRoot: string;
  readonly environment: Readonly<Record<string, string>>;
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function abortError(): DOMException {
  return new DOMException("The assertion command was cancelled", "AbortError");
}

function stopProcessGroup(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited; close/error still settles the promise.
    }
  }
}

class HostCommandRunner implements AssertionCommandRunner {
  readonly #workspaceRoot: string;
  readonly #environment: Readonly<Record<string, string>>;

  constructor(workspaceRoot: string, environment: Readonly<Record<string, string>>) {
    this.#workspaceRoot = workspaceRoot;
    this.#environment = Object.freeze({ ...environment });
  }

  async run(
    request: CommandExecutionRequest,
    signal: AbortSignal
  ): Promise<CommandExecutionResult> {
    if (signal.aborted) {
      throw abortError();
    }
    if (request.argv.length === 0 || request.argv[0] === undefined || request.argv[0].length === 0) {
      return { status: "spawn_error", message: "command argv is empty" };
    }
    const cwd = await realpath(resolve(request.cwd));
    if (!contained(this.#workspaceRoot, cwd)) {
      return { status: "spawn_error", message: "command cwd escapes the fresh workspace" };
    }

    return new Promise<CommandExecutionResult>((resolveResult, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.argv[0] as string, request.argv.slice(1), {
          cwd,
          env: { ...this.#environment },
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"]
        });
      } catch (error) {
        resolveResult({
          status: "spawn_error",
          message: error instanceof Error ? error.message : "command spawn failed"
        });
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminal: CommandExecutionResult | undefined;
      let aborted = false;
      let settled = false;
      child.stdin.end();

      const settle = (result: CommandExecutionResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        resolveResult(result);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        reject(error);
      };
      const exceed = (stream: "stdout" | "stderr"): void => {
        if (terminal === undefined) {
          terminal = { status: "output_limit", stream, limitBytes: request.maxOutputBytes };
          stopProcessGroup(child);
        }
      };
      const onAbort = (): void => {
        aborted = true;
        stopProcessGroup(child);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > request.maxOutputBytes) {
          exceed("stdout");
        } else {
          stdout.push(Buffer.from(chunk));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > request.maxOutputBytes) {
          exceed("stderr");
        } else {
          stderr.push(Buffer.from(chunk));
        }
      });
      child.once("error", (error) => {
        terminal ??= { status: "spawn_error", message: error.message };
      });
      child.once("close", (code) => {
        if (aborted) {
          fail(abortError());
          return;
        }
        if (terminal !== undefined) {
          settle(terminal);
          return;
        }
        settle({
          status: "completed",
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8")
        });
      });

      const timeout = setTimeout(() => {
        terminal ??= { status: "timeout", timeoutMs: request.timeoutMs };
        stopProcessGroup(child);
      }, request.timeoutMs);
      timeout.unref();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export async function createHostCommandRunner(
  options: HostCommandRunnerOptions
): Promise<AssertionCommandRunner> {
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  return new HostCommandRunner(workspaceRoot, options.environment);
}
