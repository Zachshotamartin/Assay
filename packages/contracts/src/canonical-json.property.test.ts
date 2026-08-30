import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";

describe("canonical JSON properties", () => {
  it("is byte-stable across insertion-order permutations", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.tuple(fc.string({ maxLength: 20 }), fc.integer()), {
          selector: ([key]) => key,
          maxLength: 30
        }),
        (entries) => {
          const forward = Object.fromEntries(entries);
          const reverse = Object.fromEntries([...entries].reverse());

          expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
        }
      ),
      { numRuns: 500, seed: 20_260_830 }
    );
  });
});

