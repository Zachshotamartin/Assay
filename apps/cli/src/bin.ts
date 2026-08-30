import { executeCli } from "./cli.js";

process.exitCode = executeCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
