import { lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { generateReferenceFixtureFiles } from "./r1-reproducibility.js";

interface FixtureDirectoryGenerator {
  readonly relativeDirectory: string;
  readonly generate: typeof generateReferenceFixtureFiles;
}

const FIXTURE_GENERATORS: readonly FixtureDirectoryGenerator[] = [
  {
    relativeDirectory: "fixtures/goldens/r1",
    generate: generateReferenceFixtureFiles
  }
];

let temporaryFileCounter = 0;

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function selectFixtureDirectories(
  repositoryRootInput: string,
  requestedPath: string
): readonly string[] {
  const repositoryRoot = resolve(repositoryRootInput);
  const requested = resolve(repositoryRoot, requestedPath);
  if (!isWithin(repositoryRoot, requested)) {
    throw new Error(`fixture regeneration path must stay inside the repository: ${requestedPath}`);
  }
  const selected = FIXTURE_GENERATORS
    .map(({ relativeDirectory }) => resolve(repositoryRoot, relativeDirectory))
    .filter((directory) => isWithin(requested, directory) || requested === directory)
    .sort();
  if (selected.length === 0) {
    throw new Error(`path is not a registered generated fixture: ${requestedPath}`);
  }
  return selected;
}

async function rejectSymlinkedDestination(repositoryRoot: string, destination: string): Promise<void> {
  const repository = resolve(repositoryRoot);
  const segments = relative(repository, destination).split(sep).filter((segment) => segment !== "");
  let current = repository;
  for (const segment of segments) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`generated fixture destination contains a symbolic link: ${current}`);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
      throw cause;
    }
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  temporaryFileCounter += 1;
  const temporary = resolve(
    dirname(path),
    `.${path.split(sep).at(-1)!}.tmp-${process.pid}-${temporaryFileCounter}`
  );
  await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
  try {
    await rename(temporary, path);
  } catch (cause) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        `fixture write and temporary-file cleanup both failed for ${path}`
      );
    }
    throw cause;
  }
}

export async function regenerateFixtures(
  repositoryRootInput: string,
  requestedPath: string
): Promise<readonly string[]> {
  const repositoryRoot = resolve(repositoryRootInput);
  const selected = selectFixtureDirectories(repositoryRoot, requestedPath);
  const written: string[] = [];
  for (const directory of selected) {
    const generator = FIXTURE_GENERATORS.find(
      ({ relativeDirectory }) => resolve(repositoryRoot, relativeDirectory) === directory
    );
    if (generator === undefined) {
      throw new Error(`registered fixture generator disappeared for ${directory}`);
    }
    await rejectSymlinkedDestination(repositoryRoot, directory);
    const files = await generator.generate(repositoryRoot);
    await mkdir(directory, { recursive: true });
    for (const file of files) {
      const destination = resolve(directory, file.relativePath);
      if (!isWithin(directory, destination) || destination === directory) {
        throw new Error(`fixture generator returned an escaping path: ${file.relativePath}`);
      }
      await rejectSymlinkedDestination(repositoryRoot, destination);
      await atomicWrite(destination, file.bytes);
      written.push(relative(repositoryRoot, destination).split(sep).join("/"));
    }
  }
  return written.sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined) {
    throw new Error("usage: npm run fixtures:regen -- <registered fixture path>");
  }
  const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
  const written = await regenerateFixtures(repositoryRoot, args[0]);
  process.stdout.write(
    `regenerated ${written.length} governed fixture files; semantic review is required:\n` +
    `${written.map((path) => `- ${path}`).join("\n")}\n`
  );
}

const invoked = process.argv[1];
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  }
}
