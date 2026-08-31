import type { InternalMatch } from "./types.js";

interface PatternCandidate extends InternalMatch {
  readonly priority: number;
}

type MatchCollector = (text: string, priority: number) => readonly PatternCandidate[];

function indexedSpan(match: RegExpExecArray, group: number): readonly [number, number] | undefined {
  const span = match.indices?.[group];
  if (span === undefined || span[0] < 0 || span[1] < 0) {
    return undefined;
  }
  return span;
}

function collectRegex(
  text: string,
  expression: RegExp,
  ruleId: string,
  priority: number,
  group = 0,
  validate: ((match: RegExpExecArray) => boolean) | undefined = undefined
): readonly PatternCandidate[] {
  const candidates: PatternCandidate[] = [];
  expression.lastIndex = 0;

  for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
    if (validate !== undefined && !validate(match)) {
      continue;
    }
    const span = indexedSpan(match, group);
    if (span === undefined || span[0] === span[1]) {
      throw new Error("Pattern rule produced an invalid capture span");
    }
    candidates.push({
      start: span[0],
      end: span[1],
      ruleId,
      classification: ruleId,
      priority
    });
  }
  return candidates;
}

const collectPem: MatchCollector = (text, priority) => {
  const expression =
    /-----BEGIN ((?:(?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY)|CERTIFICATE)-----[\s\S]*?-----END \1-----/dgu;
  const candidates: PatternCandidate[] = [];

  for (let match = expression.exec(text); match !== null; match = expression.exec(text)) {
    const span = indexedSpan(match, 0);
    const kind = match[1];
    if (span === undefined || kind === undefined) {
      throw new Error("PEM rule produced an invalid capture span");
    }
    const ruleId = kind === "CERTIFICATE" ? "pem-certificate" : "pem-private-key";
    candidates.push({
      start: span[0],
      end: span[1],
      ruleId,
      classification: ruleId,
      priority
    });
  }
  return candidates;
};

const collectUrlUserinfo: MatchCollector = (text, priority) => [
  ...collectRegex(
    text,
    /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s?#@]+)@/dgu,
    "url-userinfo",
    priority,
    1
  ),
  ...collectRegex(
    text,
    /[A-Za-z][A-Za-z0-9+.-]*:(?:\\\/){2}([^\\/\s?#@]+)@/dgu,
    "url-userinfo",
    priority,
    1
  )
];

const collectAnthropic: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /(?<![A-Za-z0-9_-])sk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/dgu,
    "provider-anthropic",
    priority
  );

const collectOpenAi: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /(?<![A-Za-z0-9_-])sk-(?!ant-)(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/dgu,
    "provider-openai",
    priority
  );

function hasDecodableJsonHeader(match: RegExpExecArray): boolean {
  const encodedHeader = match[1];
  if (encodedHeader === undefined || encodedHeader.length % 4 === 1) {
    return false;
  }

  try {
    const decoded = Buffer.from(encodedHeader, "base64url");
    if (decoded.toString("base64url") !== encodedHeader) {
      return false;
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    const header: unknown = JSON.parse(json);
    return header !== null && typeof header === "object" && !Array.isArray(header);
  } catch {
    return false;
  }
}

const collectJwt: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{2,})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/dgu,
    "jwt",
    priority,
    0,
    hasDecodableJsonHeader
  );

const collectAwsAccessKeyId: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16}\b/dgu,
    "aws-access-key-id",
    priority
  );

const collectAwsSecret: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /["']?\b(?:(?:AWS[_-]?)?SECRET[_-]?ACCESS[_-]?KEY)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?=["'\s;}]|$)/dgiu,
    "aws-secret-access-key",
    priority,
    1
  );

const collectGcpServiceAccount: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /["']type["']\s*:\s*["'](service_account)["']/dgu,
    "gcp-service-account",
    priority,
    1
  );

const collectGcpPrivateKeyId: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /["']private_key_id["']\s*:\s*["']([^"']{8,})["']/dgu,
    "gcp-private-key-id",
    priority,
    1
  );

const collectGcpClientSecret: MatchCollector = (text, priority) =>
  collectRegex(
    text,
    /["']client_secret["']\s*:\s*["']([^"']{8,})["']/dgu,
    "gcp-client-secret",
    priority,
    1
  );

const collectAzureConnectionString: MatchCollector = (text, priority) => [
  ...collectRegex(
    text,
    /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|AccessKey|Secret|Password|Pwd)\s*=\s*"([^"]+)"/dgiu,
    "azure-connection-string",
    priority,
    1
  ),
  ...collectRegex(
    text,
    /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|AccessKey|Secret|Password|Pwd)\s*=\s*'([^']+)'/dgiu,
    "azure-connection-string",
    priority,
    1
  ),
  ...collectRegex(
    text,
    /\b(?:AccountKey|SharedAccessKey|SharedAccessSignature|AccessKey|Secret|Password|Pwd)\s*=\s*([^;\s"']+)/dgiu,
    "azure-connection-string",
    priority,
    1
  )
];

const PATTERN_COLLECTORS: readonly MatchCollector[] = [
  collectPem,
  collectUrlUserinfo,
  collectAnthropic,
  collectOpenAi,
  collectJwt,
  collectAwsAccessKeyId,
  collectAwsSecret,
  collectGcpServiceAccount,
  collectGcpPrivateKeyId,
  collectGcpClientSecret,
  collectAzureConnectionString
];

export function findStructuredFieldMatches(
  text: string,
  contextKey: string
): readonly InternalMatch[] {
  const normalizedKey = contextKey.replace(/[_-]/gu, "").toLowerCase();
  let ruleId: string | undefined;
  let priority = Number.MAX_SAFE_INTEGER;

  if (
    (normalizedKey === "secretaccesskey" || normalizedKey === "awssecretaccesskey") &&
    /^[A-Za-z0-9/+=]{40}$/u.test(text)
  ) {
    ruleId = "aws-secret-access-key";
    priority = 6;
  } else if (normalizedKey === "type" && text === "service_account") {
    ruleId = "gcp-service-account";
    priority = 7;
  } else if (normalizedKey === "privatekeyid" && text.length >= 8) {
    ruleId = "gcp-private-key-id";
    priority = 8;
  } else if (normalizedKey === "clientsecret" && text.length >= 8) {
    ruleId = "gcp-client-secret";
    priority = 9;
  } else if (normalizedKey === "privatekey" && text.length > 0) {
    ruleId = "gcp-private-key";
    priority = 9;
  } else if (
    [
      "accountkey",
      "sharedaccesskey",
      "sharedaccesssignature",
      "accesskey",
      "secret",
      "password",
      "pwd"
    ].includes(normalizedKey) &&
    text.length > 0
  ) {
    ruleId = "azure-connection-string";
    priority = 10;
  }

  if (ruleId === undefined) {
    return [];
  }
  return [{
    start: 0,
    end: text.length,
    ruleId,
    classification: ruleId,
    priority
  }];
}

function overlaps(left: InternalMatch, right: InternalMatch): boolean {
  return left.start < right.end && right.start < left.end;
}

function insertionIndex(matches: readonly InternalMatch[], start: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (matches[middle]!.start < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

export function findPatternMatches(
  text: string,
  contextKey?: string | undefined
): readonly InternalMatch[] {
  const candidates = [
    ...PATTERN_COLLECTORS.flatMap((collect, priority) => collect(text, priority)),
    ...(contextKey === undefined ? [] : findStructuredFieldMatches(text, contextKey))
  ].sort((left, right) =>
    left.priority - right.priority || left.start - right.start || right.end - left.end
  );

  const selected: PatternCandidate[] = [];
  for (const candidate of candidates) {
    const index = insertionIndex(selected, candidate.start);
    const previous = selected[index - 1];
    const next = selected[index];
    if (
      (previous !== undefined && overlaps(previous, candidate)) ||
      (next !== undefined && overlaps(next, candidate))
    ) {
      continue;
    }
    selected.splice(index, 0, candidate);
  }

  return selected
    .map(({ start, end, ruleId, classification, priority }) => ({
      start,
      end,
      ruleId,
      classification,
      priority
    }));
}
