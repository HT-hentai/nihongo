export const DEFAULT_AI_PROVIDER = "deepseek";

export const AI_PROVIDERS = {
  deepseek: {
    id: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  minimax: {
    id: "minimax",
    label: "MiniMax",
    defaultModel: "MiniMax-M2.7-highspeed",
    defaultBaseUrl: "https://api.minimax.io/v1",
  },
};

export function normalizeProviderId(provider) {
  return String(provider || "").toLowerCase() === "minimax" ? "minimax" : DEFAULT_AI_PROVIDER;
}

export function providerDefaults(provider) {
  return AI_PROVIDERS[normalizeProviderId(provider)];
}

export function providerLabel(provider) {
  return providerDefaults(provider).label;
}
