import {
  ADAPTER_CONTRACT_VERSION,
  type AdapterDescriptor
} from "@assay/adapter-core";

export const SIMULATED_ADAPTER_DESCRIPTOR: AdapterDescriptor = {
  id: "adapter-simulated",
  version: "1.0.0",
  contractVersion: ADAPTER_CONTRACT_VERSION,
  tier: "full",
  model: {
    provider: "synthetic",
    model: "scripted-v1",
    family: "synthetic"
  },
  toolCatalog: [
    { name: "read_file", semanticClass: "read" },
    { name: "write_file", semanticClass: "write" },
    { name: "run_command", semanticClass: "execute" }
  ],
  capabilities: {
    usage_reporting: true,
    cost_reporting: false,
    streaming_text: true
  }
};

export const SIMULATED_ADAPTER_HANDSHAKE_FRAME = `${JSON.stringify({
  type: "handshake",
  seq: 1,
  contract: SIMULATED_ADAPTER_DESCRIPTOR.contractVersion,
  adapter: {
    id: SIMULATED_ADAPTER_DESCRIPTOR.id,
    version: SIMULATED_ADAPTER_DESCRIPTOR.version
  },
  tier: SIMULATED_ADAPTER_DESCRIPTOR.tier,
  model: SIMULATED_ADAPTER_DESCRIPTOR.model,
  tool_catalog: SIMULATED_ADAPTER_DESCRIPTOR.toolCatalog.map((entry) => ({
    name: entry.name,
    semantic_class: entry.semanticClass
  })),
  capabilities: SIMULATED_ADAPTER_DESCRIPTOR.capabilities
})}\n`;
