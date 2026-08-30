import { AssayError } from "@assay/contracts";

import { ADAPTER_CONTRACT_VERSION } from "./types.js";

const CONTRACT_PATTERN = /^assay-adapter\/(0|[1-9][0-9]*)$/u;

export function assertSupportedAdapterContract(contract: string): typeof ADAPTER_CONTRACT_VERSION {
  const match = CONTRACT_PATTERN.exec(contract);
  if (match === null) {
    throw new AssayError(
      "adapter_protocol_error",
      "adapter_protocol_error: handshake contract must match assay-adapter/<major>"
    );
  }
  if (match[1] !== "1") {
    throw new AssayError(
      "adapter_nonconformant",
      `adapter_nonconformant: unsupported adapter contract major ${match[1]}; supported major is 1`
    );
  }
  return ADAPTER_CONTRACT_VERSION;
}
