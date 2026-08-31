import { executeCli } from "./cli.js";

process.exitCode = await executeCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
