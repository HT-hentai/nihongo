import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("server exposes health, static shell, and structured AI errors", async (t) => {
  const { baseUrl } = await startAppServer(t);

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), {
    ok: true,
    defaultProvider: "deepseek",
    providers: {
      deepseek: {
        label: "DeepSeek",
        defaultModel: "deepseek-v4-flash",
        defaultBaseUrl: "https://api.deepseek.com",
      },
      minimax: {
        label: "MiniMax",
        defaultModel: "MiniMax-M2.7-highspeed",
        defaultBaseUrl: "https://api.minimax.io/v1",
      },
    },
  });

  const shellResponse = await fetch(`${baseUrl}/`);
  assert.equal(shellResponse.status, 200);
  assert.match(await shellResponse.text(), /<title>JLPT 蓝宝书备考 Agent<\/title>/);

  const missingKeyResponse = await fetch(`${baseUrl}/api/grammar-ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "deepseek",
      title: "～ず（に）",
      examples: [{ japanese: "何も食べずに働いた。" }],
    }),
  });
  assert.equal(missingKeyResponse.status, 400);
  assert.deepEqual(await missingKeyResponse.json(), {
    error: "请在用户中心粘贴 DeepSeek API Key，或设置 DEEPSEEK_API_KEY。",
    code: "missing_api_key",
    advice: "静态 Python 服务只能使用非 AI 功能；AI 拆解需要用 node server.mjs 同源启动。",
    provider: "deepseek",
    status: 400,
    endpoint: null,
  });

  const invalidJsonResponse = await fetch(`${baseUrl}/api/grammar-ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad json",
  });
  assert.equal(invalidJsonResponse.status, 400);
  assert.deepEqual(await invalidJsonResponse.json(), {
    error: "请求内容不是有效 JSON。",
    code: "invalid_request",
    advice: "请从本地页面重新触发 AI 分析；如果你在手动调用接口，请确认 Content-Type 和 JSON 语法正确。",
    provider: null,
    status: 400,
    endpoint: null,
  });
});

test("MiniMax requests fall back to the native endpoint after 404 and omit PDF translations", async (t) => {
  const providerRequests = [];
  const provider = await startMockProvider(t, async (request, response, body) => {
    providerRequests.push({ url: request.url, body });
    if (request.url === "/chat/completions") {
      sendProviderJson(response, 404, { error: { message: "not here" } });
      return;
    }
    assert.equal(request.url, "/text/chatcompletion_v2");
    const userMessage = JSON.parse(body.messages[1].content);
    assert.deepEqual(userMessage.examples, ["何も食べずに働いた。"]);
    assert.doesNotMatch(body.messages[1].content, /昨天太忙/);
    sendProviderJson(response, 200, {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "整句是否定动作。",
            sentence: "何も食べずに働いた。",
            sentenceSummary: "什么都没吃就工作了。",
            tokenAnalyses: [{ tokenIndex: 2, text: "食べ", meaning: "吃", role: "动词词干" }],
            examples: [{ sentence: "何も食べずに働いた。", breakdown: "食べずに表示不吃就做后项。" }],
          }),
        },
      }],
    });
  });
  const { baseUrl } = await startAppServer(t);

  const response = await postGrammarAi(baseUrl, {
    provider: "minimax",
    apiKey: "fake-key",
    baseUrl: provider.baseUrl,
    analysisMode: "sentence-cache",
    title: "～ず（に）",
    selectedText: "何も食べずに働いた。",
    tokens: ["何", "も", "食べ", "ずに", "働いた", "。"],
    examples: [{ japanese: "何も食べずに働いた。", translation: "昨天太忙了。" }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.analysisMode, "sentence-cache");
  assert.equal(payload.sentenceSummary, "什么都没吃就工作了。");
  assert.deepEqual(providerRequests.map((item) => item.url), ["/chat/completions", "/text/chatcompletion_v2"]);
});

test("server maps provider failures and unusable model output to structured AI errors", async (t) => {
  const throttledProvider = await startMockProvider(t, async (_request, response) => {
    sendProviderJson(response, 429, { error: { message: "slow down" } });
  });
  const reasoningProvider = await startMockProvider(t, async (_request, response) => {
    sendProviderJson(response, 200, {
      choices: [{ message: { content: "I need to inspect tokenIndex before answering." } }],
    });
  });
  const { baseUrl } = await startAppServer(t);

  const throttled = await postGrammarAi(baseUrl, {
    provider: "deepseek",
    apiKey: "fake-key",
    baseUrl: throttledProvider.baseUrl,
    title: "～ず（に）",
    examples: [{ japanese: "何も食べずに働いた。" }],
  });
  assert.equal(throttled.status, 429);
  assert.deepEqual(await throttled.json(), {
    error: `DeepSeek 请求失败（429，127.0.0.1:${throttledProvider.port}/chat/completions）：slow down`,
    code: "rate_limited",
    advice: "DeepSeek 返回限流。请稍后重试，或临时切换服务商/模型。",
    provider: "deepseek",
    status: 429,
    endpoint: `127.0.0.1:${throttledProvider.port}/chat/completions`,
  });

  const unusable = await postGrammarAi(baseUrl, {
    provider: "deepseek",
    apiKey: "fake-key",
    baseUrl: reasoningProvider.baseUrl,
    title: "～ず（に）",
    examples: [{ japanese: "何も食べずに働いた。" }],
  });
  assert.equal(unusable.status, 502);
  assert.deepEqual(await unusable.json(), {
    error: "AI 返回内容不是可用的教学 JSON。",
    code: "invalid_model_json",
    advice: "请点击“重新分析”；如果反复出现，请切换快速模型、降低自定义 Base URL 风险，或稍后重试。",
    provider: "deepseek",
    status: 502,
    endpoint: null,
  });
});

test("server reports provider network errors with endpoint detail", async (t) => {
  const unusedPort = await getFreePort();
  const { baseUrl } = await startAppServer(t, { AI_REQUEST_TIMEOUT_MS: "300" });
  const response = await postGrammarAi(baseUrl, {
    provider: "deepseek",
    apiKey: "fake-key",
    baseUrl: `http://127.0.0.1:${unusedPort}`,
    title: "～ず（に）",
    examples: [{ japanese: "何も食べずに働いた。" }],
  });
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.code, "network_error");
  assert.equal(payload.provider, "deepseek");
  assert.equal(payload.status, 502);
  assert.equal(payload.endpoint, `127.0.0.1:${unusedPort}/chat/completions`);
  assert.match(payload.error, /DeepSeek 网络请求失败|DeepSeek 请求超时/);
  assert.match(payload.advice, /网络连接失败或请求超时/);
});

async function startAppServer(t, env = {}) {
  const port = await getFreePort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AI_PROVIDER: "",
      DEEPSEEK_API_KEY: "",
      MINIMAX_API_KEY: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!server.killed) server.kill();
  });

  await waitForServer(port, server);
  return { server, port, baseUrl: `http://localhost:${port}` };
}

async function startMockProvider(t, handler) {
  const server = createHttpServer(async (request, response) => {
    let payload = "";
    for await (const chunk of request) payload += chunk;
    let body = {};
    try {
      body = payload ? JSON.parse(payload) : {};
    } catch {}
    await handler(request, response, body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  t.after(() => server.close());
  return { port, baseUrl: `http://127.0.0.1:${port}` };
}

function sendProviderJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function postGrammarAi(baseUrl, payload) {
  return fetch(`${baseUrl}/api/grammar-ai`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForServer(port, processHandle) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (processHandle.exitCode !== null) {
      throw new Error(`server exited early with code ${processHandle.exitCode}`);
    }
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready within 5s");
}
