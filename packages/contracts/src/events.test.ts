import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./canonical-json.js";
import {
  ASSAY_EVENT_TYPES,
  MAX_ASSAY_EVENT_BYTES,
  parseAssayEvent,
  type AssayEvent
} from "./events.js";

const fixturesDirectory = fileURLToPath(
  new URL("../../../fixtures/contract-events/events/", import.meta.url)
);

async function fixtures(): Promise<readonly { readonly file: string; readonly source: string }[]> {
  const files = (await readdir(fixturesDirectory)).filter((file) => file.endsWith(".json")).sort();
  return Promise.all(
    files.map(async (file) => ({ file, source: await readFile(`${fixturesDirectory}/${file}`, "utf8") }))
  );
}

async function firstFixtureSource(): Promise<string> {
  const first = (await fixtures())[0];
  if (first === undefined) {
    throw new Error("event fixtures are missing");
  }
  return first.source;
}

describe("AssayEvent v1", () => {
  it("has exactly one accepting fixture for every fixed event name", async () => {
    const loaded = await fixtures();
    const parsed = loaded.map(({ source }) => parseAssayEvent(source));

    expect(parsed.map((event) => event.type).sort()).toEqual([...ASSAY_EVENT_TYPES].sort());
    expect(loaded).toHaveLength(20);
  });

  it("canonical-round-trips every event fixture", async () => {
    for (const { source } of await fixtures()) {
      const first = parseAssayEvent(source);
      const second = parseAssayEvent(canonicalJson(first));
      expect(second).toEqual(first);
    }
  });

  it("gives every event fixture at least one rejecting mutation", async () => {
    for (const { source } of await fixtures()) {
      const event = JSON.parse(source) as Record<string, unknown>;
      delete event["run_id"];
      expect(() => parseAssayEvent(JSON.stringify(event))).toThrowError(/adapter_protocol_error/u);
    }
  });

  it("rejects unknown event types, versions, fields, and invalid timestamps", async () => {
    const source = await firstFixtureSource();
    const event = JSON.parse(source) as Record<string, unknown>;

    expect(() => parseAssayEvent(JSON.stringify({ ...event, type: "UnknownEvent" }))).toThrowError(
      /adapter_protocol_error/u
    );
    expect(() => parseAssayEvent(JSON.stringify({ ...event, schema_version: 2 }))).toThrowError(
      /adapter_protocol_error/u
    );
    expect(() => parseAssayEvent(JSON.stringify({ ...event, unexpected: true }))).toThrowError(
      /adapter_protocol_error/u
    );
    expect(() =>
      parseAssayEvent(JSON.stringify({ ...event, timestamp: "2026-08-30T12:00:00Z" }))
    ).toThrowError(/adapter_protocol_error/u);
  });

  it("rejects malformed JSON, invalid UTF-8, and oversized payloads", async () => {
    const source = await firstFixtureSource();
    const event = JSON.parse(source) as Record<string, unknown>;

    expect(() => parseAssayEvent("{")).toThrowError(/adapter_protocol_error/u);
    expect(() => parseAssayEvent(Uint8Array.from([0xc3, 0x28]))).toThrowError(
      /adapter_protocol_error/u
    );
    expect(() =>
      parseAssayEvent(
        JSON.stringify({ ...event, payload: { value: "x".repeat(MAX_ASSAY_EVENT_BYTES) } })
      )
    ).toThrowError(/adapter_protocol_error/u);
  });

  it("returns the discriminated public union", async () => {
    const source = await firstFixtureSource();
    const event: AssayEvent = parseAssayEvent(source);
    expect(ASSAY_EVENT_TYPES).toContain(event.type);
  });
});
