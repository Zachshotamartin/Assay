import type { InternalMatch } from "./types.js";

const MINIMUM_CANDIDATE_LENGTH = 20;
const BASE64_ENTROPY_THRESHOLD = 4.0;
const HEX_ENTROPY_THRESHOLD = 3.0;

const ENTROPY_CANDIDATE =
  /(?<![A-Za-z0-9_+\/-])[A-Za-z0-9_+\/-]{18,}={0,2}(?![A-Za-z0-9_+\/=\-])/dgu;
const HEXADECIMAL = /^[A-Fa-f0-9]+$/u;

export function shannonEntropyBitsPerCharacter(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

export function findEntropyMatches(
  text: string,
  knownHashes: ReadonlySet<string>
): readonly InternalMatch[] {
  const matches: InternalMatch[] = [];
  ENTROPY_CANDIDATE.lastIndex = 0;

  for (let match = ENTROPY_CANDIDATE.exec(text); match !== null; match = ENTROPY_CANDIDATE.exec(text)) {
    const candidate = match[0];
    if (candidate.length < MINIMUM_CANDIDATE_LENGTH || knownHashes.has(candidate)) {
      continue;
    }

    const unpadded = candidate.replace(/={1,2}$/u, "");
    const threshold = HEXADECIMAL.test(unpadded)
      ? HEX_ENTROPY_THRESHOLD
      : BASE64_ENTROPY_THRESHOLD;

    if (shannonEntropyBitsPerCharacter(unpadded) < threshold) {
      continue;
    }

    matches.push({
      start: match.index,
      end: match.index + candidate.length,
      ruleId: "entropy",
      classification: "entropy",
      priority: Number.MAX_SAFE_INTEGER
    });
  }

  return matches;
}
