import { fileURLToPath } from "node:url";

import { register } from "tsx/esm/api";

register({
  tsconfig: fileURLToPath(new URL("../tsconfig.runtime.json", import.meta.url))
});

await import("./bin.ts");
