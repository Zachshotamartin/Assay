import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(`${root}/${path}`, "utf8")) as Record<string, unknown>;
}

describe("R0 package and license metadata", () => {
  it("keeps every package private and explicitly implementation-stage", async () => {
    for (const path of ["package.json", "apps/cli/package.json", "packages/contracts/package.json"]) {
      const value = await json(path);
      expect(value["private"], path).toBe(true);
      expect(value["version"], path).toBe("0.0.0");
      expect(value["license"], path).toBe("MIT");
      expect(value["description"], path).toMatch(/(?:implementation|planned)/iu);
    }
  });

  it("records the canonical repository identity in every package", async () => {
    for (const path of ["package.json", "apps/cli/package.json", "packages/contracts/package.json"]) {
      await expect(json(path)).resolves.toMatchObject({
        repository: {
          type: "git",
          url: "git+https://github.com/Zachshotamartin/Assay.git"
        }
      });
    }
  });

  it("ships only runtime output and the public event schema from workspace packages", async () => {
    await expect(json("apps/cli/package.json")).resolves.toMatchObject({ files: ["dist"] });
    await expect(json("packages/contracts/package.json")).resolves.toMatchObject({
      files: ["dist", "schemas"]
    });
  });

  it("contains the complete MIT license", async () => {
    const license = await readFile(`${root}/LICENSE`, "utf8");
    expect(license).toContain("MIT License");
    expect(license).toContain("Copyright (c) 2026 Zachary Martin");
    expect(license).toContain("THE SOFTWARE IS PROVIDED \"AS IS\"");
  });
});
