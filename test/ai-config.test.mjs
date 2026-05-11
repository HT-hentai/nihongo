import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  normalizeProviderId,
  providerDefaults,
  providerLabel,
} from "../src/ai-config.mjs";

test("provider defaults stay stable for the UI and server", () => {
  assert.equal(DEFAULT_AI_PROVIDER, "deepseek");
  assert.deepEqual(Object.keys(AI_PROVIDERS).sort(), ["deepseek", "minimax"]);
  assert.equal(providerLabel("deepseek"), "DeepSeek");
  assert.equal(providerLabel("minimax"), "MiniMax");
  assert.equal(providerDefaults("deepseek").defaultModel, "deepseek-v4-flash");
  assert.equal(providerDefaults("minimax").defaultModel, "MiniMax-M2.7-highspeed");
});

test("unknown providers fall back to DeepSeek", () => {
  assert.equal(normalizeProviderId("minimax"), "minimax");
  assert.equal(normalizeProviderId("MINIMAX"), "minimax");
  assert.equal(normalizeProviderId("unknown"), "deepseek");
  assert.equal(providerDefaults("unknown").defaultBaseUrl, "https://api.deepseek.com");
});
