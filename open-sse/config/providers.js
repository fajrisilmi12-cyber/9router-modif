// Barrel: PROVIDERS now built from providers/registry (transport co-located with models)
import { PROVIDERS } from "../providers/index.js";
export { PROVIDERS, PROVIDER_OAUTH } from "../providers/index.js";

export const OLLAMA_LOCAL_DEFAULT_HOST = "http://localhost:11434";

export function resolveOllamaLocalHost(credentials) {
  const raw = credentials?.providerSpecificData?.baseUrl?.trim();
  return (raw || OLLAMA_LOCAL_DEFAULT_HOST).replace(/\/$/, "");
}
"doubao-web": {
  id: "doubao-web",
  baseUrl: "https://www.dola.com/chat/completion",
  // models: ["dola-speed", "dola-pro", "dola-deep-think"]  // sesuaikan dgn format entry provider lain di file ini
},
// Region URLs single-source from registry xiaomi-tokenplan.transport
export const XIAOMI_TOKENPLAN_REGIONS = PROVIDERS["xiaomi-tokenplan"]?.regions || {};
export const XIAOMI_TOKENPLAN_DEFAULT_REGION = PROVIDERS["xiaomi-tokenplan"]?.defaultRegion;

export function resolveXiaomiTokenplanBaseUrl(credentials) {
  const region = credentials?.providerSpecificData?.region;
  return XIAOMI_TOKENPLAN_REGIONS[region] || XIAOMI_TOKENPLAN_REGIONS[XIAOMI_TOKENPLAN_DEFAULT_REGION];
}
