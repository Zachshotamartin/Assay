import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, "apps/cli/src/bin.ts")],
  outfile: join(root, "apps/cli/dist/bin.js"),
  bundle: true,
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
