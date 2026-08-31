import { describe, expect, it } from "vitest";

import {
  REDACTION_RULESET_VERSION,
  redactText,
  type RedactionManifestEntry
} from "./index.js";

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

const OPENAI_KEY = "sk-proj-SYNTHETIC0123456789abcdefghijklmnopqrstuv";
const ANTHROPIC_KEY = "sk-ant-api03-SYNTHETIC0123456789abcdefghijklmnop";
const AWS_ACCESS_KEY_ID = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const AWS_SECRET = ["AbCdEfGhIjKlMnOpQrSt", "UvWxYz0123456789+/XY"].join("");
const GCP_PRIVATE_KEY_ID = "0123456789abcdef0123456789abcdef01234567";
const AZURE_ACCOUNT_KEY = "QWxwaGFCcmF2b0NoYXJsaWVEZWx0YUVjaG9Gb3h0cm90MTIzNDU2Nzg5MA==";
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzeW50aGV0aWMtdGVzdCJ9.SYNTHETIC_signature-0123456789abcdef";

function expectSinglePattern(
  input: string,
  secret: string,
  ruleId: string,
  location = "/adapter_event"
): void {
  const result = redactText(input, { location });

  expect(result.value).not.toContain(secret);
  expect(result.value).toContain(`[REDACTED:${ruleId}:${utf8Length(secret)}]`);
  expect(result.manifest).toEqual({
    rulesetVersion: REDACTION_RULESET_VERSION,
    redactionCount: 1,
    matchCounts: { [ruleId]: 1 },
    applied: [
      {
        ruleId,
        location,
        byteLength: utf8Length(secret),
        count: 1
      }
    ] satisfies RedactionManifestEntry[]
  });
}

describe("versioned pattern rules", () => {
  it("uses the architecture and configuration ruleset version", () => {
    expect(REDACTION_RULESET_VERSION).toBe("2026.08");
  });

  it("redacts OpenAI and Anthropic provider-key shapes", () => {
    expectSinglePattern(`authorization=${OPENAI_KEY}`, OPENAI_KEY, "provider-openai");
    expectSinglePattern(`authorization=${ANTHROPIC_KEY}`, ANTHROPIC_KEY, "provider-anthropic");
  });

  it("redacts the entire provider token when an allowed punctuation character ends it", () => {
    const keyEndingInHyphen = `${OPENAI_KEY}-`;
    expectSinglePattern(keyEndingInHyphen, keyEndingInHyphen, "provider-openai");
  });

  it("redacts PEM private-key and certificate blocks", () => {
    const privateKey = [
      "-----BEGIN PRIVATE KEY-----",
      "SYNTHETICPRIVATEKEYBODY0123456789+/=",
      "-----END PRIVATE KEY-----"
    ].join("\n");
    const certificate = [
      "-----BEGIN CERTIFICATE-----",
      "SYNTHETICCERTIFICATEBODY0123456789+/=",
      "-----END CERTIFICATE-----"
    ].join("\n");

    expectSinglePattern(privateKey, privateKey, "pem-private-key");
    expectSinglePattern(certificate, certificate, "pem-certificate");

    const encryptedPrivateKey = [
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "SYNTHETICENCRYPTEDPRIVATEKEYBODY0123456789+/=",
      "-----END ENCRYPTED PRIVATE KEY-----"
    ].join("\n");
    expectSinglePattern(encryptedPrivateKey, encryptedPrivateKey, "pem-private-key");
  });

  it("redacts a JWT only when its header is decodable JSON", () => {
    expectSinglePattern(`bearer ${JWT}`, JWT, "jwt");

    const invalidHeader = "not_json.not_a_sensitive_payload.not_a_signature";
    const result = redactText(invalidHeader);
    expect(result.value).toBe(invalidHeader);
    expect(result.manifest.redactionCount).toBe(0);
  });

  it("redacts AWS access-key IDs and contextual secret access keys", () => {
    expectSinglePattern(`key_id=${AWS_ACCESS_KEY_ID}`, AWS_ACCESS_KEY_ID, "aws-access-key-id");
    expectSinglePattern(
      `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`,
      AWS_SECRET,
      "aws-secret-access-key"
    );
    expectSinglePattern(
      `{"aws_secret_access_key":"${AWS_SECRET}"}`,
      AWS_SECRET,
      "aws-secret-access-key"
    );
    const lowEntropySecret = "A".repeat(40);
    expectSinglePattern(
      `{"SecretAccessKey":"${lowEntropySecret}"}`,
      lowEntropySecret,
      "aws-secret-access-key"
    );
  });

  it("redacts GCP service-account markers and credential fields", () => {
    expectSinglePattern('"type": "service_account"', "service_account", "gcp-service-account");
    expectSinglePattern(
      `"private_key_id":"${GCP_PRIVATE_KEY_ID}"`,
      GCP_PRIVATE_KEY_ID,
      "gcp-private-key-id"
    );
  });

  it("redacts Azure connection-string secrets", () => {
    expectSinglePattern(
      `DefaultEndpointsProtocol=https;AccountName=synthetic;AccountKey=${AZURE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`,
      AZURE_ACCOUNT_KEY,
      "azure-connection-string"
    );
    expectSinglePattern(
      "Endpoint=https://synthetic.azconfig.io;Id=synthetic;Secret=low-entropy-secret",
      "low-entropy-secret",
      "azure-connection-string"
    );
    expectSinglePattern(
      "Server=tcp:synthetic.database.windows.net;User ID=test;Password=plain-password",
      "plain-password",
      "azure-connection-string"
    );
    expectSinglePattern(
      'Server=tcp:synthetic.database.windows.net;Password="plain password;with separator"',
      "plain password;with separator",
      "azure-connection-string"
    );
  });

  it("redacts the complete URL userinfo component", () => {
    const userinfo = "synthetic-user:p%40ssword";
    expectSinglePattern(
      `request https://${userinfo}@example.test/private`,
      userinfo,
      "url-userinfo"
    );
  });

  it("redacts URL userinfo inside JSON-escaped text", () => {
    const userinfo = "synthetic-user:plain-password";
    expectSinglePattern(
      `{"url":"https:\\/\\/${userinfo}@example.test/private"}`,
      userinfo,
      "url-userinfo"
    );
  });

  it("applies pattern rules before entropy and never records overlapping matches", () => {
    const userinfo = `${OPENAI_KEY}:synthetic-password`;
    const result = redactText(`https://${userinfo}@example.test`);

    expect(result.value).toBe(
      `https://[REDACTED:url-userinfo:${utf8Length(userinfo)}]@example.test`
    );
    expect(result.manifest.redactionCount).toBe(1);
    expect(result.manifest.matchCounts).toEqual({ "url-userinfo": 1 });
  });

  it("reports deterministic per-rule match counts without retaining matched text", () => {
    const result = redactText(`${OPENAI_KEY}\n${OPENAI_KEY}`, { location: "/diagnostic" });

    expect(result.manifest.redactionCount).toBe(2);
    expect(result.manifest.matchCounts).toEqual({ "provider-openai": 2 });
    expect(result.manifest.applied).toHaveLength(2);
    expect(JSON.stringify(result.manifest)).not.toContain(OPENAI_KEY);
  });
});

describe("capture surfaces", () => {
  it.each([
    ["adapter event", "/adapter_event"],
    ["tool output", "/tool/output"],
    ["diagnostic", "/diagnostic"]
  ])("removes a planted provider key from %s text", (_surface, location) => {
    const result = redactText(`planted=${OPENAI_KEY}`, { location });

    expect(result.value).not.toContain(OPENAI_KEY);
    expect(result.manifest.applied[0]?.location).toBe(location);
  });

  it("redacts a base64-wrapped planted secret through entropy detection", () => {
    const wrapped = Buffer.from(`planted:${OPENAI_KEY}`, "utf8").toString("base64");
    const result = redactText(`tool_result=${wrapped}`, { location: "/tool/output" });

    expect(result.value).not.toContain(wrapped);
    expect(result.manifest.matchCounts).toEqual({ entropy: 1 });
  });
});
