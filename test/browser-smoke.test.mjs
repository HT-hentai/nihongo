import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("browser smoke covers onboarding, PDF extraction, grammar card, AI errors, and import/export", { timeout: 90000 }, async (t) => {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    t.skip("Google Chrome executable was not found on this machine.");
    return;
  }

  const providerModes = [];
  const mockProvider = await startMockProvider(t, async (_request, response, body) => {
    const userMessage = JSON.parse(body.messages?.[1]?.content || "{}");
    providerModes.push(userMessage.analysisMode || "selection");
    if (userMessage.analysisMode === "sentence-cache") {
      sendProviderJson(response, 200, {
        choices: [{ message: { content: "I need to inspect tokenIndex before answering." } }],
      });
      return;
    }
    sendProviderJson(response, 200, {
      choices: [{
        message: {
          content: JSON.stringify({
            summary: "测试用解释：该词在句中表示能力。",
            points: ["前项说明可以做到的动作。"],
            examples: [{ sentence: userMessage.examples?.[0] || "", breakdown: "できる 表示能力或完成。" }],
            memoryTip: "看到 できる 先判断能力还是完成。",
          }),
        },
      }],
    });
  });
  const unusedProviderPort = await getFreePort();
  const { baseUrl } = await startAppServer(t, { AI_REQUEST_TIMEOUT_MS: "400" });
  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
  });
  t.after(() => browser.close());

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "生成计划" }).click();

  await waitForSavedState(page, (state) => state.catalog?.length === 739, 20000);
  await waitForSavedState(page, (state) => Object.keys(state.grammarContent || {}).length === 739 && state.extraction?.status === "done", 60000);
  await waitForBodyText(page, "已缓存 739 条", 10000);
  assert.match(await bodyText(page), /今日计划|计划/);
  assert.match(await bodyText(page), /蓝宝书语法学习/);
  let text = await bodyText(page);
  assert.match(text, /查漏/);
  assert.doesNotMatch(text, /今天没有语法学习内容/);

  await page.getByRole("button", { name: "开始学习" }).click();
  await waitForBodyText(page, "查漏", 10000);
  await page.getByRole("button", { name: "已完成" }).click();
  await waitForSavedState(page, (state) => Object.keys(state.grammarProgress || {}).length === 1, 10000);
  await page.getByRole("button", { name: "今日计划" }).click();
  await page.getByRole("button", { name: "用户中心" }).click();
  await page.getByRole("button", { name: "重新配置备考目标" }).click();
  await page.locator('[data-onboarding-field="targetLevel"]').selectOption("N1");
  await page.getByRole("button", { name: "保存配置" }).click();
  await waitForBodyText(page, "蓝宝书语法学习", 10000);
  text = await bodyText(page);
  assert.match(text, /查漏/);
  assert.doesNotMatch(text, /今天没有语法学习内容/);
  await waitForSavedState(page, (state) => state.onboarding?.targetLevel === "N1" && Object.keys(state.grammarProgress || {}).length === 1, 10000);

  await page.getByRole("button", { name: "搜索" }).click();
  await page.locator("[data-search-query]").fill("ず");
  await page.locator('[data-action="open-grammar-card"]').first().click();
  await waitForBodyText(page, "未配置", 10000);
  assert.match(await bodyText(page), /AI 拆解/);

  await page.getByRole("button", { name: "用户中心" }).click();
  await page.locator('[data-secret-field="apiKey"]').fill("fake-key");
  await page.locator('[data-secret-field="baseUrl"]').fill(mockProvider.baseUrl);
  await page.getByRole("button", { name: "保存设置" }).click();
  await waitForBodyText(page, "已保存 DeepSeek API 设置", 10000);
  await page.getByRole("button", { name: "搜索" }).click();
  await page.locator(".grammar-example [data-action=\"select-grammar-example\"]").first().click();
  await waitForBodyText(page, "测试用解释", 10000);
  assert.ok(providerModes.includes("sentence-cache"), "expected sentence-cache preheat request");
  assert.ok(providerModes.includes("selection"), "expected focused selection fallback request");

  await page.locator('[data-action="nav"][data-view="catalog"]').dispatchEvent("click");
  await waitForBodyText(page, "目录校对", 10000);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 JSON" }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "jlpt-bluebook-agent-progress.json");
  const exportedPath = await download.path();
  const exportedState = JSON.parse(readFileSync(exportedPath, "utf8"));
  assert.equal(exportedState.catalog.length, 739);

  await page.locator("#importBox").waitFor();
  await page.locator("#importBox").fill(JSON.stringify({ catalog: exportedState.catalog.filter((entry) => entry.level === "N2").slice(0, 3) }));
  await page.locator('[data-action="import-state"]').dispatchEvent("click");
  await waitForSavedState(page, (state) => state.catalog?.length === 3, 10000);
  await page.getByRole("button", { name: "用户中心" }).click();
  await page.getByRole("button", { name: "重新配置备考目标" }).click();
  await page.getByRole("button", { name: "保存配置" }).click();
  await waitForSavedState(page, (state) => state.catalog?.length === 739, 20000);

  await page.getByRole("button", { name: "用户中心" }).click();
  await page.locator('[data-secret-field="apiKey"]').fill("fake-key");
  await page.locator('[data-secret-field="baseUrl"]').fill(`http://127.0.0.1:${unusedProviderPort}`);
  await page.getByRole("button", { name: "测试连接" }).click();
  await waitForCondition(page, () => /网络请求失败|请求超时|网络连接失败或请求超时/.test(document.body.innerText), 10000);

  assert.deepEqual(pageErrors, []);
});

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

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

async function getFreePort() {
  const server = createNetServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
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

async function bodyText(page) {
  return page.locator("body").innerText();
}

async function waitForBodyText(page, text, timeout) {
  await waitForCondition(page, (expected) => document.body.innerText.includes(expected), timeout, text);
}

async function waitForSavedState(page, predicate, timeout) {
  await waitForCondition(page, (predicateText) => {
    const state = JSON.parse(localStorage.getItem("bluebook-n2-agent-state-v1") || "{}");
    return Function("state", `return (${predicateText})(state);`)(state);
  }, timeout, predicate.toString());
}

async function waitForCondition(page, predicate, timeout, arg = undefined) {
  await page.waitForFunction(predicate, arg, { timeout });
}
