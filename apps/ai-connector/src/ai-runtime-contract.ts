import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CapabilityState =
  | "implemented"
  | "implemented_experimental_protocol"
  | "implemented_by_spellbook"
  | "implemented_and_runtime_verified"
  | "available_not_needed"
  | "available_in_native_cli"
  | "available_via_stream_json"
  | "connectable_only_in_user_direct_runtime"
  | "connectable_by_process_control"
  | "connectable_via_stream_json_input"
  | "connectable_via_mcp"
  | "connectable_via_permission_prompt_tool"
  | "connectable_by_spellbook_mcp_loop"
  | "provider_managed_not_normalized"
  | "no_verified_native_equivalent";

interface ProviderRuntimeContract {
  displayName: string;
  runtime: string;
  version: string | null;
  integrationStatus: string;
  subscriptionConnection: string;
  credentialBoundary: string;
  capabilities: Record<string, CapabilityState>;
}

interface AiRuntimeContract {
  version: string;
  reviewedAt: string;
  activeProvider: string;
  productContract: {
    requiredCapabilities: string[];
    allowedModelTools: string[];
    genericCapabilitiesDisabledByDefault: string[];
  };
  providers: Record<string, ProviderRuntimeContract>;
}

const contractsDirectory =
  process.env.SPELLBOOK_CONTRACTS_DIR ??
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../contracts",
  );

const imageModels = JSON.parse(
  readFileSync(
    path.join(contractsDirectory, "image-generation-models.json"),
    "utf8",
  ),
) as { provider: string; modelIds: string[] };
if (
  imageModels.provider !== "codex" ||
  !Array.isArray(imageModels.modelIds) ||
  imageModels.modelIds.some(
    (model) => typeof model !== "string" || !model,
  )
)
  throw new Error("Invalid image generation model contract.");
export const imageGenerationModelIds = new Set(imageModels.modelIds);

export const aiRuntimeContract = JSON.parse(
  readFileSync(
    path.join(contractsDirectory, "ai-runtime-capabilities.json"),
    "utf8",
  ),
) as AiRuntimeContract;

const activeProvider =
  aiRuntimeContract.providers[aiRuntimeContract.activeProvider];
const implementedStates = new Set<CapabilityState>([
  "implemented",
  "implemented_experimental_protocol",
  "implemented_by_spellbook",
  "implemented_and_runtime_verified",
]);

if (
  !activeProvider ||
  activeProvider.integrationStatus !== "implemented" ||
  aiRuntimeContract.productContract.requiredCapabilities.some(
    (capability) =>
      !implementedStates.has(activeProvider.capabilities[capability]),
  )
) {
  throw new Error("Active AI runtime does not satisfy the Spellbook contract.");
}

export const activeAiRuntime = {
  provider: aiRuntimeContract.activeProvider,
  displayName: activeProvider.displayName,
  runtime: activeProvider.runtime,
  version: activeProvider.version!,
  subscriptionConnection: activeProvider.subscriptionConnection,
  capabilities: Object.fromEntries(
    Object.entries(activeProvider.capabilities).filter(([, state]) =>
      implementedStates.has(state),
    ),
  ),
};
