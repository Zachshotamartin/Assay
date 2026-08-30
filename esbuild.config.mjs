import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: { bin: join(root, "apps/cli/src/bin.ts") },
  outdir: join(root, "apps/cli/dist"),
  bundle: true,
  splitting: true,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  // Workspace packages own subprocess/worker assets resolved relative to their
  // own import.meta.url. Keeping packages external preserves those package
  // roots in the installed monorepo instead of rebasing them onto this bundle.
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" }
});
