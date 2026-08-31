import { AssayError, exitCodeForCategory, type ExitCode } from "@assay/contracts";
import type { CliRuntime } from "./runtime.js";

export type { CliRuntime } from "./runtime.js";

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type CliInvocation =
  | { readonly command: "help" }
  | { readonly command: "version" }
  | { readonly command: "validate"; readonly paths: readonly string[] }
  | {
      readonly command: "run";
      readonly suitePath: string;
      readonly variant: string;
      readonly runsPerTask?: number;
      readonly adapter?: string;
      readonly seed?: number;
      readonly dryRun?: true;
      readonly unsafeHostExec?: true;
    };

const VERSION = "0.0.0";
const HELP =
  "Usage:\n" +
  "  assay validate [paths]\n" +
  "  assay run <suite> --variant <name> [-n N] [--adapter X] [--seed S] [--dry-run] [--unsafe-host-exec]\n" +
  "  assay --help\n" +
  "  assay --version\n";

function invalidInvocation(detail: string): never {
  throw new AssayError(
    "invalid_invocation",
    `invalid_invocation: ${detail}; nothing ran; inspect assay --help and correct the invocation`
  );
}

function parseUnsignedInteger(value: string, flag: string, maximum: number): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return invalidInvocation(`${flag} requires an integer value`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    return invalidInvocation(`${flag} is outside its supported range`);
  }
  return parsed;
}

function parseRun(args: readonly string[]): Extract<CliInvocation, { readonly command: "run" }> {
  const suitePath = args[0];
  if (suitePath === undefined || suitePath.startsWith("-")) {
    return invalidInvocation("assay run requires exactly one suite path before its flags");
  }

  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flag === "--dry-run" || flag === "--unsafe-host-exec") {
      if (switches.has(flag)) {
        return invalidInvocation(`duplicate flag ${flag}`);
      }
      switches.add(flag);
      continue;
    }
    if (flag !== "--variant" && flag !== "-n" && flag !== "--adapter" && flag !== "--seed") {
      return invalidInvocation(
        flag.startsWith("-") ? `unknown flag ${flag}` : `unexpected positional argument ${flag}`
      );
    }
    if (values.has(flag)) {
      return invalidInvocation(`duplicate flag ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("-")) {
      return invalidInvocation(`${flag} requires a value`);
    }
    values.set(flag, value);
    index += 1;
  }

  const variant = values.get("--variant");
  if (variant === undefined || variant.length === 0) {
    return invalidInvocation("assay run requires --variant <name>");
  }

  const runsPerTaskRaw = values.get("-n");
  const runsPerTask = runsPerTaskRaw === undefined
    ? undefined
    : parseUnsignedInteger(runsPerTaskRaw, "-n", Number.MAX_SAFE_INTEGER);
  if (runsPerTask !== undefined && runsPerTask < 1) {
    return invalidInvocation("-n must be at least 1");
  }
  const seedRaw = values.get("--seed");
  const seed = seedRaw === undefined
    ? undefined
    : parseUnsignedInteger(seedRaw, "--seed", 0xffff_ffff);

  return {
    command: "run",
    suitePath,
    variant,
    ...(runsPerTask === undefined ? {} : { runsPerTask }),
    ...(values.get("--adapter") === undefined ? {} : { adapter: values.get("--adapter")! }),
    ...(seed === undefined ? {} : { seed }),
    ...(switches.has("--dry-run") ? { dryRun: true as const } : {}),
    ...(switches.has("--unsafe-host-exec") ? { unsafeHostExec: true as const } : {})
  };
}

export function parseCliInvocation(argv: readonly string[]): CliInvocation {
  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
    return { command: "help" };
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    return { command: "version" };
  }
  if (argv[0] === "validate") {
    const paths = argv.slice(1);
    const unexpectedFlag = paths.find((path) => path.startsWith("-"));
    if (unexpectedFlag !== undefined) {
      return invalidInvocation(`unknown validate flag ${unexpectedFlag}`);
    }
    return { command: "validate", paths };
  }
  if (argv[0] === "run") {
    return parseRun(argv.slice(1));
  }
  return invalidInvocation(`unknown command or top-level flag ${argv[0]}`);
}

export async function executeCli(
  argv: readonly string[],
  io: CliIo,
  providedRuntime?: CliRuntime
): Promise<ExitCode> {
  let ownedRuntime: { readonly runtime: CliRuntime; readonly dispose: () => void } | undefined;
  try {
    const invocation = parseCliInvocation(argv);
    if (invocation.command === "version") {
      io.stdout(`assay ${VERSION}\n`);
      return 0;
    }
    if (invocation.command === "help") {
      io.stdout(HELP);
      return 0;
    }
    if (providedRuntime === undefined) {
      const [{ createProcessRuntime }, { simulatedAdapterCommand }] = await Promise.all([
        import("./runtime.js"),
        import("@assay/adapter-simulated")
      ]);
      ownedRuntime = createProcessRuntime(process.cwd(), (adapterId) => {
        if (adapterId !== "adapter-simulated") {
          throw new AssayError(
            "adapter_unavailable",
            `adapter_unavailable: adapter ${JSON.stringify(adapterId)} is not installed`
          );
        }
        return simulatedAdapterCommand();
      });
    }
    const runtime = providedRuntime ?? ownedRuntime!.runtime;
    const {
      loadConfigInput,
      loadPreparedSuite,
      resolveRuntimeConfig
    } = await import("./project.js");
    const configInput = await loadConfigInput(runtime.projectRoot);
    resolveRuntimeConfig(runtime, configInput);
    if (invocation.command === "validate") {
      const validation = await import("./validation.js");
      let summary: Awaited<ReturnType<typeof validation.validateProjectInputs>>;
      try {
        summary = await validation.validateProjectInputs(runtime, invocation.paths);
      } catch (error) {
        if (error instanceof validation.ValidationDiagnosticsError) {
          const rendered = validation.renderValidationDiagnostics(error);
          io.stderr(`assay: ${rendered}\n`);
          return exitCodeForCategory(error.category);
        }
        throw error;
      }
      io.stdout(
        `Validated ${summary.suites} ${summary.suites === 1 ? "suite" : "suites"}, ` +
        `${summary.tasks} ${summary.tasks === 1 ? "task" : "tasks"}, ` +
        `${summary.matrices} ${summary.matrices === 1 ? "matrix" : "matrices"}, ` +
        `${summary.checkers} ${summary.checkers === 1 ? "checker" : "checkers"}, and ` +
        `${summary.rubrics} ${summary.rubrics === 1 ? "rubric" : "rubrics"}.\n`
      );
      return 0;
    }
    const suite = await loadPreparedSuite(runtime.projectRoot, invocation.suitePath);
    const { executeRunCommand } = await import("./run-command.js");
    return await executeRunCommand(invocation, suite, configInput, runtime, io);
  } catch (error) {
    let classified = error instanceof AssayError
      ? error
      : error instanceof DOMException && error.name === "AbortError"
        ? new AssayError(
            "cancelled",
            "cancelled: the operation was interrupted; owned work was settled; rerun the command when ready",
            { cause: error }
          )
        : new AssayError("internal_invariant", "internal_invariant: unexpected CLI failure", { cause: error });
    let rendered: string;
    try {
      const { redactText } = await import("@assay/redaction");
      rendered = redactText(classified.message, { location: "/diagnostic" }).value;
    } catch (cause) {
      classified = new AssayError(
        "redaction_failed",
        "redaction_failed: the diagnostic could not be rendered safely; no unredacted diagnostic was emitted; inspect the local redaction engine",
        { cause }
      );
      rendered = classified.message;
    }
    io.stderr(`assay: ${rendered}\n`);
    if (classified.category === "invalid_invocation") {
      io.stderr(HELP);
    }
    return exitCodeForCategory(classified.category);
  } finally {
    ownedRuntime?.dispose();
  }
}
