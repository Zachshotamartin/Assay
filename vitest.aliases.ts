import { fileURLToPath } from "node:url";

const packageSourceRoot = fileURLToPath(new URL("./packages/", import.meta.url));

export interface WorkspaceAlias {
  readonly find: RegExp;
  readonly replacement: string;
}

/** Resolve private workspace imports to source so tests never depend on ignored build output. */
export const assayWorkspaceAliases: readonly WorkspaceAlias[] = [
  {
    find: /^@assay\/([^/]+)$/u,
    replacement: `${packageSourceRoot}$1/src/index.ts`
  }
];
