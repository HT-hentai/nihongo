import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("server exposes health, static shell, and structured AI errors", async (t) => {
  const port = await getFreePort();
  const server = spawn(process.execPath, ["server.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      AI_PROVIDER: "",
      DEEPSEEK_API_KEY: "",
      MINIMAX_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (!server.killed) server.kill();
  });

  await waitForServer(port, server);
  const baseUrl = `http://localhost:${port}`;

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

async function getFreePort() {
  const server = createServer();
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
