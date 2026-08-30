import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packagedCli = join(repositoryRoot, "apps", "cli", "dist", "bin.js");
const roots: string[] = [];

interface ProcessResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunningCli {
  readonly child: ChildProcess;
  readonly result: Promise<ProcessResult>;
}

beforeAll(async () => {
  await executeFile("npm", ["run", "build"], {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024
  });
  await stat(packagedCli);
}, 120_000);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "assay-packaged-cli-"));
  roots.push(root);
  return root;
}

async function writeValidProject(
  root: string,
  assertion: Readonly<Record<string, unknown>> = { type: "file_exists", path: "README.md" }
): Promise<void> {
  await mkdir(join(root, "fixtures", "repo"), { recursive: true });
  await writeFile(join(root, "fixtures", "repo", "README.md"), "packaged fixture\n", "utf8");
  await writeFile(join(root, "packaged.task.yaml"), JSON.stringify({
    format_version: "1.0",
    id: "packaged-task",
    title: "Packaged CLI task",
    fixture: { path: "fixtures/repo" },
    prompt: "Complete the deterministic packaged CLI task.",
    toolset: { catalog: "simulated/1" },
    sandbox: {
      image: `synthetic@sha256:${"0".repeat(64)}`,
      network: "none",
      timeout_ms: 20_000
    },
    assertions: [assertion]
  }), "utf8");
  await writeFile(join(root, "packaged.suite.yaml"), JSON.stringify({
    format_version: "1.0",
    id: "packaged-suite",
    title: "Packaged CLI suite",
    include: ["packaged.task.yaml"],
    variants: {
      baseline: { adapter: "simulated", model: "synthetic/scripted-v1" }
    }
  }), "utf8");
}

function startCli(
  root: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {}
): RunningCli {
  const child = spawn(process.execPath, [packagedCli, ...args], {
    cwd: root,
    env: { ...process.env, ...environment },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const result = new Promise<ProcessResult>((resolveResult, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout!.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr!.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === null) {
        reject(new Error(`packaged CLI exited by unexpected signal ${String(signal)}`));
        return;
      }
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
  });
  return { child, result };
}

async function runCli(
  root: string,
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {}
): Promise<ProcessResult> {
  return startCli(root, args, environment).result;
}

async function waitForPath(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("R1 packaged CLI process contract", () => {
  it("reaches documented process exit 0", async () => {
    const root = await temporaryProject();
    await writeValidProject(root);

    const result = await runCli(root, [
      "run", "packaged.suite.yaml", "--variant", "baseline", "-n", "1", "--seed", "1"
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/1 passed, 0 failed, 0 errors/u);
  });

  it("reaches documented process exit 1", async () => {
    const root = await temporaryProject();
    await writeValidProject(root, { type: "file_absent", path: "README.md" });

    const result = await runCli(root, [
      "run", "packaged.suite.yaml", "--variant", "baseline", "-n", "1"
    ]);

    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toMatch(/0 passed, 1 failed, 0 errors/u);
  });

  it("reaches documented process exit 4 through validation", async () => {
    const root = await temporaryProject();
    await writeFile(join(root, "invalid.task.yaml"), JSON.stringify({
      format_version: "2.0",
      id: "invalid-task",
      title: "Invalid task"
    }), "utf8");

    const result = await runCli(root, ["validate", "invalid.task.yaml"]);

    expect(result.code, result.stderr).toBe(4);
    expect(result.stderr).toContain("task_invalid");
  });

  it("reaches documented process exit 5 before provider or store activity", async () => {
    const root = await temporaryProject();
    await writeValidProject(root);

    const result = await runCli(root, [
      "run", "packaged.suite.yaml", "--variant", "baseline", "--adapter", "missing"
    ]);

    expect(result.code, result.stderr).toBe(5);
    expect(result.stderr).toContain("adapter_unavailable");
    await expect(stat(join(root, ".assay"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reaches documented process exit 6 and durably settles SIGINT", async () => {
    const root = await temporaryProject();
    const marker = join(root, "assertion-started");
    await writeValidProject(root, {
      type: "tests_pass",
      command: [
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'started'); setInterval(() => {}, 1000)",
        marker
      ],
      timeout_ms: 60_000
    });
    const running = startCli(root, [
      "run", "packaged.suite.yaml", "--variant", "baseline", "-n", "1", "--unsafe-host-exec"
    ]);

    await waitForPath(marker);
    expect(running.child.kill("SIGINT")).toBe(true);
    const result = await running.result;

    expect(result.code, result.stderr).toBe(6);
    const database = new DatabaseSync(join(root, ".assay", "assay.db"));
    const row = database.prepare("SELECT record_json FROM runs").get() as { readonly record_json: string };
    database.close();
    expect(JSON.parse(row.record_json)).toMatchObject({ status: "cancelled" });
  }, 30_000);

  it("observes zero provider egress with BYOK variables pointed at a sentinel", async () => {
    const root = await temporaryProject();
    await writeValidProject(root);
    const loadedMarker = join(root, "sentinel-loaded");
    const egressMarker = join(root, "provider-egress-observed");
    const preload = join(root, "network-sentinel.cjs");
    await writeFile(preload, `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(loadedMarker)}, "loaded");
const observe = () => {
  fs.writeFileSync(${JSON.stringify(egressMarker)}, "network API invoked");
  throw new Error("required Assay check attempted network egress");
};
for (const name of ["node:net", "node:http", "node:https"]) {
  const module = require(name);
  for (const key of ["connect", "createConnection", "request", "get"]) {
    if (typeof module[key] === "function") module[key] = observe;
  }
}
globalThis.fetch = observe;
`, "utf8");

    const result = await runCli(root, [
      "run", "packaged.suite.yaml", "--variant", "baseline", "-n", "1"
    ], {
      NODE_OPTIONS: `--require=${preload}`,
      OPENAI_API_KEY: "sk-proj-SYNTHETIC0123456789abcdefghijklmnop",
      OPENAI_BASE_URL: "https://provider.invalid",
      ANTHROPIC_API_KEY: "sk-ant-api03-SYNTHETIC0123456789abcdefghijklmnop",
      ANTHROPIC_BASE_URL: "https://provider.invalid",
      GOOGLE_GENERATIVE_AI_BASE_URL: "https://provider.invalid"
    });
    expect(result.code, result.stderr).toBe(0);
    await expect(stat(loadedMarker)).resolves.toBeDefined();
    await expect(stat(egressMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
