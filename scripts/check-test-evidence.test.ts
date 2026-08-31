import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  inspectTestEvidence,
  validateTestEvidenceSnapshot,
  type TestEvidenceManifest
} from "./check-test-evidence.js";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

const validManifest: TestEvidenceManifest = {
  schemaVersion: 1,
  lanes: {
    unit: ["packages/example/src/index.test.ts"],
    property: ["packages/example/src/index.property.test.ts"],
    integration: ["packages/example/test/integration/index.test.ts"],
    "e2e-simulated": ["tests/e2e/example.test.ts"]
  },
  packagedE2e: ["tests/e2e/example.test.ts"],
  regressions: [{
    file: "packages/example/src/index.test.ts",
    title: "keeps the fixed behavior [FR-RUN-003]",
    requirementId: "FR-RUN-003"
  }]
};

const validSources = new Map([
  ["packages/example/src/index.test.ts", 'it("keeps the fixed behavior [FR-RUN-003]", () => {});'],
  ["packages/example/src/index.property.test.ts", "fc.assert(fc.property(value, check), { seed: 42 });"],
  ["packages/example/test/integration/index.test.ts", 'it("uses a real boundary", () => {});'],
  ["tests/e2e/example.test.ts", 'it("runs the package", () => {});']
]);

describe("Ops 8.5 test evidence conventions", () => {
  it("accepts one disjoint, complete, path-conformant snapshot", () => {
    expect(validateTestEvidenceSnapshot(validManifest, validSources)).toEqual([]);
  });

  it("fails closed on unclassified and multiply classified test files", () => {
    const sources = new Map(validSources);
    sources.set("packages/example/src/missing.test.ts", 'it("missing", () => {});');
    const duplicated: TestEvidenceManifest = {
      ...validManifest,
      lanes: {
        ...validManifest.lanes,
        integration: [
          ...validManifest.lanes.integration,
          "packages/example/src/index.test.ts"
        ]
      }
    };

    expect(validateTestEvidenceSnapshot(duplicated, sources)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "test-unclassified" }),
        expect.objectContaining({ code: "test-lane-overlap" })
      ])
    );
  });

  it.each([
    ["unit", "packages/example/test/unit/index.test.ts", "unit-test-location"],
    ["property", "packages/example/src/index.test.ts", "property-test-location"],
    ["integration", "packages/example/src/integration.test.ts", "integration-test-location"],
    ["e2e-simulated", "apps/example/src/example.e2e.test.ts", "packaged-e2e-location"]
  ] as const)("rejects a misplaced %s test", (lane, file, code) => {
    const manifest: TestEvidenceManifest = {
      schemaVersion: 1,
      lanes: {
        unit: lane === "unit" ? [file] : [],
        property: lane === "property" ? [file] : [],
        integration: lane === "integration" ? [file] : [],
        "e2e-simulated": lane === "e2e-simulated" ? [file] : []
      },
      packagedE2e: lane === "e2e-simulated" ? [file] : [],
      regressions: []
    };
    const source = lane === "property"
      ? "fc.assert(fc.property(value, check), { seed: 42 });"
      : 'it("case", () => {});';
    expect(validateTestEvidenceSnapshot(manifest, new Map([[file, source]])))
      .toContainEqual(expect.objectContaining({ code }));
  });

  it("requires seeded fast-check properties so failures print replay evidence", () => {
    const sources = new Map(validSources);
    sources.set(
      "packages/example/src/index.property.test.ts",
      "fc.assert(fc.property(value, check));"
    );
    expect(validateTestEvidenceSnapshot(validManifest, sources)).toContainEqual(
      expect.objectContaining({ code: "property-seed-missing" })
    );
  });

  it("requires every tracked regression title to contain its PRODUCT requirement or issue ID", () => {
    const sources = new Map(validSources);
    sources.set(
      "packages/example/src/index.test.ts",
      'it("keeps the fixed behavior", () => {});'
    );
    expect(validateTestEvidenceSnapshot(validManifest, sources)).toContainEqual(
      expect.objectContaining({ code: "regression-id-missing" })
    );
  });

  it("accepts the complete real R1 test evidence manifest", async () => {
    await expect(inspectTestEvidence(repositoryRoot)).resolves.toEqual([]);
  });
});
