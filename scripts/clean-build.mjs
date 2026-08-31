import { readdir, rm } from "node:fs/promises";

const workspaceParents = [
  new URL("../apps/", import.meta.url),
  new URL("../packages/", import.meta.url)
];

const generatedDirectories = [new URL("../dist/scripts/", import.meta.url)];
for (const parent of workspaceParents) {
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      generatedDirectories.push(new URL(`./${entry.name}/dist/`, parent));
    }
  }
}

await Promise.all(
  generatedDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
);
