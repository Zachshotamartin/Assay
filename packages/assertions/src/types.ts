import type { AssertionResult, Clock } from "@assay/contracts";

export type { AssertionResult } from "@assay/contracts";

export type AssertionVerdict = "pass" | "fail" | "error";
export type DeterministicAssertionType =
  | "exit_code"
  | "tests_pass"
  | "file_exists"
  | "file_absent"
  | "file_contains"
  | "json_schema"
  | "diff_matches"
  | "command_output";

interface NamedAssertionSpec {
  readonly name?: string;
}

export interface ExitCodeAssertionSpec extends NamedAssertionSpec {
  readonly type: "exit_code";
  readonly equals?: number;
}

export interface TestsPassAssertionSpec extends NamedAssertionSpec {
  readonly type: "tests_pass";
  readonly command: readonly string[];
  readonly cwd?: string;
  readonly timeout_ms?: number;
}

export interface FileExistsAssertionSpec extends NamedAssertionSpec {
  readonly type: "file_exists";
  readonly path: string;
  readonly kind?: "file" | "dir" | "any";
}

export interface FileAbsentAssertionSpec extends NamedAssertionSpec {
  readonly type: "file_absent";
  readonly path: string;
}

interface FileContainsAssertionBase extends NamedAssertionSpec {
  readonly type: "file_contains";
  readonly path: string;
  readonly min_count?: number;
  readonly max_bytes?: number;
}

export type FileContainsAssertionSpec =
  | (FileContainsAssertionBase & { readonly literal: string; readonly regex?: never })
  | (FileContainsAssertionBase & { readonly literal?: never; readonly regex: string });

export interface JsonSchemaAssertionSpec extends NamedAssertionSpec {
  readonly type: "json_schema";
  readonly path: string;
  readonly schema: string;
}

export interface DiffMatchesAssertionSpec extends NamedAssertionSpec {
  readonly type: "diff_matches";
  readonly expected: string;
  readonly ignore_whitespace?: "none" | "trailing" | "all";
  readonly paths?: readonly string[];
}

interface CommandOutputAssertionBase extends NamedAssertionSpec {
  readonly type: "command_output";
  readonly command: readonly string[];
  readonly stream?: "stdout" | "stderr" | "both";
  readonly cwd?: string;
  readonly timeout_ms?: number;
}

export type CommandOutputAssertionSpec =
  | (CommandOutputAssertionBase & {
      readonly equals: string;
      readonly contains?: never;
      readonly regex?: never;
    })
  | (CommandOutputAssertionBase & {
      readonly equals?: never;
      readonly contains: string;
      readonly regex?: never;
    })
  | (CommandOutputAssertionBase & {
      readonly equals?: never;
      readonly contains?: never;
      readonly regex: string;
    });

export type DeterministicAssertionSpec =
  | ExitCodeAssertionSpec
  | TestsPassAssertionSpec
  | FileExistsAssertionSpec
  | FileAbsentAssertionSpec
  | FileContainsAssertionSpec
  | JsonSchemaAssertionSpec
  | DiffMatchesAssertionSpec
  | CommandOutputAssertionSpec;

export interface CommandExecutionRequest {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export type CommandExecutionResult =
  | {
      readonly status: "completed";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    }
  | {
      readonly status: "spawn_error";
      readonly message: string;
    }
  | {
      readonly status: "timeout";
      readonly timeoutMs: number;
    }
  | {
      readonly status: "output_limit";
      readonly stream: "stdout" | "stderr";
      readonly limitBytes: number;
    };

export interface AssertionCommandRunner {
  run(request: CommandExecutionRequest, signal: AbortSignal): Promise<CommandExecutionResult>;
}

export interface DeadlineHandle {
  cancel(): void;
}

export interface DeadlineScheduler {
  schedule(delayMs: number, callback: () => void): DeadlineHandle;
}

export interface AssertionExecutionContext {
  readonly workspaceRoot: string;
  readonly fixtureRoot: string;
  readonly projectRoot: string;
  readonly sandboxWorkdir?: string;
  readonly agentExitCode: number | null;
  readonly clock: Clock;
  readonly commandRunner: AssertionCommandRunner;
}

export type DeterministicAssertionResult = AssertionResult & {
  readonly type: DeterministicAssertionType;
};

export interface CheckerAssertionSpec {
  readonly type: "checker";
  readonly name?: string;
  readonly module: string;
  readonly timeout_ms?: number;
  readonly memory_mb?: number;
}

export interface CheckerTaskDefinition {
  readonly formatVersion: "1.0";
  readonly id: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly fixture: unknown;
  readonly prompt: string;
  readonly toolset: unknown;
  readonly sandbox: unknown;
  readonly assertions: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface WorkspaceReader {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  list(path?: string): Promise<readonly string[]>;
}

export interface TrajectoryReader {
  events(): readonly unknown[];
}

export interface CheckerContext {
  readonly task: CheckerTaskDefinition;
  readonly workspace: WorkspaceReader;
  readonly trajectory: TrajectoryReader;
  readonly log: (message: string) => void;
}

export interface CheckerVerdict {
  readonly verdict: "pass" | "fail";
  readonly observed: string;
  readonly expectation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CheckerExecutionContext {
  readonly projectRoot: string;
  readonly workspaceRoot: string;
  readonly task: CheckerTaskDefinition;
  readonly trajectory: readonly unknown[];
  readonly clock: Clock;
  readonly deadlineScheduler: DeadlineScheduler;
}

export type CheckerAssertionResult = AssertionResult & {
  readonly type: "checker";
  readonly details?: Readonly<Record<string, unknown>>;
  readonly logs: readonly string[];
};

export interface ValidatedCheckerModule {
  readonly modulePath: string;
  readonly checkerRoot: string;
  readonly sourceFiles: readonly string[];
}
