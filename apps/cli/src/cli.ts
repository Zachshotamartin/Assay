export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const VERSION = "0.0.0";
const HELP =
  "Usage: assay [--help] [--version]\n\n" +
  "Assay implementation bootstrap; product commands are not available yet.\n";

export function executeCli(argv: readonly string[], io: CliIo): number {
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) {
    io.stdout(`assay ${VERSION}\n`);
    return 0;
  }

  if (argv.length === 0 || (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h"))) {
    io.stdout(HELP);
    return 0;
  }

  io.stderr("assay: product commands are not available yet (invalid_invocation)\n");
  return 4;
}
