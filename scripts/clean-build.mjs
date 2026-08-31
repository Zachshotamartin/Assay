import { rm } from "node:fs/promises";

const generatedDirectories = [
  new URL("../apps/cli/dist/", import.meta.url),
  new URL("../packages/contracts/dist/", import.meta.url),
  new URL("../dist/scripts/", import.meta.url)
];

await Promise.all(
  generatedDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
);
