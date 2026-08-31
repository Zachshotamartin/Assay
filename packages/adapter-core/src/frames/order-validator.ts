import type { AdapterDescriptor, AdapterEvent } from "../types.js";

interface RequestState {
  response: boolean;
  usage: boolean;
}

export interface AdapterOrderFinalState {
  readonly terminal: Extract<AdapterEvent, { type: "run_completed" | "run_failed" }> | null;
  readonly postTerminal: boolean;
  readonly incompleteReasons: readonly string[];
}

export class AdapterEventOrderValidator {
  readonly #tier: AdapterDescriptor["tier"];
  readonly #requests = new Map<string, RequestState>();
  readonly #calls = new Map<string, boolean>();
  #seenSession = false;
  #lastTurn = -1;
  #terminal: Extract<AdapterEvent, { type: "run_completed" | "run_failed" }> | null = null;
  #postTerminal = false;

  constructor(tier: AdapterDescriptor["tier"]) {
    this.#tier = tier;
  }

  accept(event: AdapterEvent): string | null {
    if (this.#terminal !== null) {
      this.#postTerminal = true;
      return "frame followed terminal frame";
    }

    if (!this.#seenSession) {
      if (event.type !== "session_started") {
        return "session_started must be the first event after the handshake";
      }
      this.#seenSession = true;
      return null;
    }
    if (event.type === "session_started") {
      return "session_started must appear exactly once";
    }

    switch (event.type) {
      case "model_request":
        if (this.#requests.has(event.requestId)) {
          return "model_request request_id must be unique";
        }
        if (event.turn < this.#lastTurn) {
          return "model_request turn must be monotonically nondecreasing";
        }
        this.#lastTurn = event.turn;
        this.#requests.set(event.requestId, { response: false, usage: false });
        return null;
      case "model_response": {
        const request = this.#requests.get(event.requestId);
        if (request === undefined || request.response) {
          return "model_response must match one open model_request";
        }
        request.response = true;
        return null;
      }
      case "usage": {
        const request = this.#requests.get(event.usage.requestId);
        if (request === undefined || request.usage) {
          return "usage must match one open model_request";
        }
        request.usage = true;
        return null;
      }
      case "tool_call": {
        if (this.#calls.has(event.callId)) {
          return "tool_call call_id must be unique";
        }
        const request = this.#requests.get(event.requestId);
        if (request === undefined || !request.response) {
          return "tool_call request_id must match a settled model response";
        }
        this.#calls.set(event.callId, false);
        return null;
      }
      case "tool_result": {
        const closed = this.#calls.get(event.callId);
        if (closed === undefined || closed) {
          return "tool_result must match one open tool_call";
        }
        this.#calls.set(event.callId, true);
        return null;
      }
      case "run_completed":
      case "run_failed":
        this.#terminal = event;
        return null;
      case "text_output":
      case "log":
        return null;
    }
  }

  finish(): AdapterOrderFinalState {
    const incompleteReasons: string[] = [];
    if (!this.#seenSession) incompleteReasons.push("missing session_started");
    for (const [requestId, state] of this.#requests) {
      if (!state.response) incompleteReasons.push(`request ${requestId} has no model_response`);
      if (this.#tier === "full" && !state.usage) {
        incompleteReasons.push(`request ${requestId} has no usage`);
      }
    }
    for (const [callId, closed] of this.#calls) {
      if (!closed) incompleteReasons.push(`tool call ${callId} has no tool_result`);
    }
    return {
      terminal: this.#terminal,
      postTerminal: this.#postTerminal,
      incompleteReasons
    };
  }
}
