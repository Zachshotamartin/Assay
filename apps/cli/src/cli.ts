import { AssayError, exitCodeForCategory, type ExitCode } from "@assay/contracts";

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

export async function executeCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
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
    throw new AssayError(
      "internal_invariant",
      `internal_invariant: ${invocation.command} dispatch is not wired`
    );
  } catch (error) {
    const classified = error instanceof AssayError
      ? error
      : new AssayError("internal_invariant", "internal_invariant: unexpected CLI failure", { cause: error });
    io.stderr(`assay: ${classified.message}\n`);
    if (classified.category === "invalid_invocation") {
      io.stderr(HELP);
    }
    return exitCodeForCategory(classified.category);
  }
}
