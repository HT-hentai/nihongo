import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER as CONFIG_DEFAULT_AI_PROVIDER,
  normalizeProviderId,
  providerDefaults,
  providerLabel as configuredProviderLabel,
} from "./src/ai-config.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 5173);
const DEFAULT_AI_PROVIDER = process.env.AI_PROVIDER || CONFIG_DEFAULT_AI_PROVIDER;
const PROVIDER_CONFIG = {
  deepseek: {
    ...AI_PROVIDERS.deepseek,
    defaultModel: process.env.DEEPSEEK_MODEL || AI_PROVIDERS.deepseek.defaultModel,
    defaultBaseUrl: process.env.DEEPSEEK_BASE_URL || AI_PROVIDERS.deepseek.defaultBaseUrl,
  },
  minimax: {
    ...AI_PROVIDERS.minimax,
    defaultModel: process.env.MINIMAX_MODEL || AI_PROVIDERS.minimax.defaultModel,
    defaultBaseUrl: process.env.MINIMAX_BASE_URL || AI_PROVIDERS.minimax.defaultBaseUrl,
  },
};

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        defaultProvider: normalizeProvider(DEFAULT_AI_PROVIDER),
        providers: {
          deepseek: {
            label: providerLabel("deepseek"),
            defaultModel: providerModel("deepseek"),
            defaultBaseUrl: providerBaseUrl("deepseek"),
          },
          minimax: {
            label: providerLabel("minimax"),
            defaultModel: providerModel("minimax"),
            defaultBaseUrl: providerBaseUrl("minimax"),
          },
        },
      });
      return;
    }

    if (request.method === "POST" && request.url === "/api/grammar-ai") {
      await handleGrammarAi(request, response);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }

    serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: "Server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Bluebook agent running at http://localhost:${PORT}/`);
});

async function handleGrammarAi(request, response) {
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendApiError(response, 400, {
      code: "invalid_request",
      error: "请求内容不是有效 JSON。",
      advice: "请从本地页面重新触发 AI 分析；如果你在手动调用接口，请确认 Content-Type 和 JSON 语法正确。",
    });
    return;
  }
  const provider = normalizeProvider(payload.provider || process.env.AI_PROVIDER || DEFAULT_AI_PROVIDER);
  const apiKey = String(payload.apiKey || providerApiKey(provider) || "").trim();
  if (!apiKey) {
    sendApiError(response, 400, {
      code: "missing_api_key",
      provider,
      error: `请在用户中心粘贴 ${providerLabel(provider)} API Key，或设置 ${providerEnvKey(provider)}。`,
      advice: "静态 Python 服务只能使用非 AI 功能；AI 拆解需要用 node server.mjs 同源启动。",
    });
    return;
  }

  const examples = Array.isArray(payload.examples)
    ? payload.examples.map((item) => String(item.japanese || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  if (!payload.title || !examples.length) {
    sendApiError(response, 400, {
      code: "invalid_request",
      provider,
      error: "缺少句型标题或日文例句。",
      advice: "请重新打开蓝宝书卡片，确认这一条已经从 PDF 提取到例句后再分析。",
    });
    return;
  }
  const selectionType = payload.selectionType === "word" ? "word" : "sentence";
  const selectedText = String(payload.selectedText || examples[0]).trim();
  const tokens = Array.isArray(payload.tokens) ? payload.tokens.map((token) => String(token || "")).filter(Boolean) : [];
  const tokenIndex = Number.isInteger(payload.tokenIndex) ? payload.tokenIndex : null;
  const beforeText = String(payload.beforeText || "");
  const afterText = String(payload.afterText || "");
  const candidateSpan = String(payload.candidateSpan || selectedText);
  const analysisMode = payload.analysisMode === "sentence-cache" ? "sentence-cache" : "selection";
  const model = String(payload.model || providerModel(provider)).trim();
  const baseUrl = String(payload.baseUrl || providerBaseUrl(provider)).trim();

  const requestBody = {
    model,
    messages: [
      {
        role: "system",
        content: grammarSystemPrompt(analysisMode),
      },
      {
        role: "user",
        content: JSON.stringify({
          analysisMode,
          level: payload.level || "",
          grammarTitle: `${payload.number || ""}. ${payload.title}`,
          outputLanguage: "zh-CN",
          outputRules: analysisMode === "sentence-cache"
            ? [
              "sentenceSummary、summary、meaning、role、explanation、memoryTip 必须是简体中文",
              "sentence、text、spanText 可以保留日文",
              "tokenAnalyses 尽量覆盖 tokenList 中每个非空、非标点 token；tokenIndex 必须使用 tokenList.index",
              "dependsOn 只放与该 token 必须一起理解的后文 tokenIndex，例如补助动词、助词组合、活用尾、固定搭配",
            ]
            : [
              "summary、points、breakdown、memoryTip 必须是简体中文",
              "sentence 字段可以保留日文例句",
              "不要输出 selectedText/tokenIndex/candidateSpan 等字段名本身",
            ],
          selectionType,
          selectedText,
          tokenIndex,
          tokens,
          tokenList: tokens.map((text, index) => ({ index, text })),
          beforeText,
          afterText,
          candidateSpan,
          examples,
        }, null, 2),
      },
    ],
    temperature: 0.1,
    max_tokens: analysisMode === "sentence-cache" ? 1300 : 560,
    response_format: { type: "json_object" },
  };
  if (provider === "deepseek") {
    requestBody.thinking = { type: "disabled" };
  }

  const result = await requestAiProvider({
    provider,
    apiKey,
    baseUrl,
    body: requestBody,
  });
  if (!result.ok) {
    sendApiError(response, result.httpStatus || result.status || 502, result);
    return;
  }

  const text = responseText(result.data);
  try {
    const parsed = parseModelJson(text);
    sendJson(response, 200, analysisMode === "sentence-cache"
      ? normalizeSentenceCacheResult(parsed, { examples, tokens })
      : normalizeAiResult(parsed));
  } catch {
    const summary = finalAnswerText(text);
    if (summary) {
      sendJson(response, 200, {
        summary,
        points: [],
        examples: [],
      });
      return;
    }
    sendApiError(response, 502, {
      code: "invalid_model_json",
      provider,
      error: "AI 返回内容不是可用的教学 JSON。",
      advice: "请点击“重新分析”；如果反复出现，请切换快速模型、降低自定义 Base URL 风险，或稍后重试。",
    });
  }
}

async function requestAiProvider({ provider, apiKey, baseUrl, body }) {
  const urls = completionUrlsFor(provider, baseUrl);
  const retryableStatuses = new Set([404, 405]);
  const errors = [];

  for (const url of urls) {
    let apiResponse;
    try {
      apiResponse = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      return providerNetworkError(provider, url, error);
    }

    const { data, text } = await readApiPayload(apiResponse);
    if (apiResponse.ok) return { ok: true, data };

    const error = providerErrorPayload(provider, apiResponse, data, text, url);
    errors.push(error);
    if (!retryableStatuses.has(apiResponse.status)) {
      return { ok: false, httpStatus: apiResponse.status, ...error };
    }
  }

  const last = errors[errors.length - 1] || {
    code: "provider_unavailable",
    provider,
    status: 502,
    endpoint: null,
    error: `${providerLabel(provider)} 请求失败。`,
    advice: adviceForAiError("provider_unavailable", provider),
  };
  return {
    ok: false,
    httpStatus: 502,
    ...last,
    error: errors.map((item) => item.error).join("；") || last.error,
  };
}

function completionUrlsFor(provider, baseUrl) {
  const value = String(baseUrl || providerBaseUrl(provider)).trim().replace(/\/+$/, "");
  if (/\/(chat\/completions|text\/chatcompletion_v2)$/i.test(value)) return [value];

  const urls = [`${value}/chat/completions`];
  const isMiniMaxHost = /^https?:\/\/api\.minimax(i)?\.com\b/i.test(value);
  if (isMiniMaxHost) urls.push(`${value}/text/chatcompletion_v2`);
  return urls;
}

function normalizeProvider(provider) {
  return normalizeProviderId(provider);
}

function providerLabel(provider) {
  return configuredProviderLabel(provider);
}

function providerApiKey(provider) {
  return provider === "minimax" ? process.env.MINIMAX_API_KEY : process.env.DEEPSEEK_API_KEY;
}

function providerEnvKey(provider) {
  return provider === "minimax" ? "MINIMAX_API_KEY" : "DEEPSEEK_API_KEY";
}

function providerModel(provider) {
  return providerRuntimeConfig(provider).defaultModel;
}

function providerBaseUrl(provider) {
  return providerRuntimeConfig(provider).defaultBaseUrl;
}

function providerRuntimeConfig(provider) {
  const id = normalizeProvider(provider);
  return PROVIDER_CONFIG[id] || providerDefaults(id);
}

async function readApiPayload(response) {
  const text = await response.text();
  if (!text) return { data: {}, text: "" };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: {}, text };
  }
}

function providerNetworkError(provider, url, error) {
  const endpoint = safeEndpointLabel(url);
  return {
    ok: false,
    httpStatus: 502,
    code: "network_error",
    provider,
    status: 502,
    endpoint,
    error: `${providerLabel(provider)} 网络请求失败（${endpoint}）：${error.message || "无法连接服务商"}`,
    advice: adviceForAiError("network_error", provider, endpoint),
  };
}

function providerErrorPayload(provider, response, data, text, url) {
  const endpoint = safeEndpointLabel(url);
  const code = codeForProviderStatus(response.status);
  const detail = data.error?.message
    || data.base_resp?.status_msg
    || data.error_msg
    || data.message
    || text.slice(0, 240)
    || response.statusText
    || `${providerLabel(provider)} request failed`;
  return {
    code,
    provider,
    status: response.status,
    endpoint,
    error: `${providerLabel(provider)} 请求失败（${response.status}，${endpoint}）：${detail}`,
    advice: adviceForAiError(code, provider, endpoint),
  };
}

function codeForProviderStatus(status) {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 405) return "endpoint_not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

function adviceForAiError(code, provider, endpoint = null) {
  const label = provider ? providerLabel(provider) : "AI";
  const endpointHint = endpoint ? `当前接口：${endpoint}。` : "";
  return {
    missing_api_key: `在用户中心粘贴 ${label} API Key，或设置对应环境变量后用 node server.mjs 启动。`,
    invalid_request: "请重新打开卡片再试；如果你改过模型或 Base URL，请先用用户中心的“测试连接”确认请求格式。",
    auth_failed: `请检查 ${label} API Key 是否正确、是否属于当前服务商，以及账号是否仍可用。`,
    rate_limited: `${label} 返回限流。请稍后重试，或临时切换服务商/模型。`,
    provider_unavailable: `${label} 服务暂时不可用。请稍后重试，或切换服务商。${endpointHint}`,
    endpoint_not_found: `${endpointHint}请检查 Base URL 是否正确；MiniMax 可在用户中心切换“国际接口 / 中国区接口 / 原生接口”。`,
    network_error: `${label} 网络连接失败。请检查本机网络、代理设置和 Base URL；AI 功能必须通过 node server.mjs 同源访问。`,
    invalid_model_json: "模型没有按要求输出 JSON。请点击“重新分析”；如果反复出现，换用默认快速模型后再试。",
  }[code] || "请稍后重试；如果问题持续，请检查 API Key、模型名和 Base URL。";
}

function safeEndpointLabel(value) {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname}`;
  } catch {
    return "未知接口";
  }
}

function grammarSystemPrompt(analysisMode = "selection") {
  const base = [
    "你是给中文母语学习者使用的日语 JLPT 语法老师。只分析用户提供的句型名、日文例句和选择上下文。",
    "所有解释、summary、points、breakdown、memoryTip 必须使用简体中文。除非引用原日文例句或选中片段，不要用日语写说明。",
    "不要声称看过原书中文说明；不要改写、总结或引用原书中文解释。",
    "不要输出推理过程、分析草稿、token 调试过程、英文思考、日语说明或 markdown。只输出最终教学 JSON。",
    "不要把 JSON 当字符串输出；不要转义整段 JSON；最外层必须是 JSON object。",
  ];
  if (analysisMode === "sentence-cache") {
    return [
      ...base,
      "这次任务是句子级预分析：一次性拆解整句，并为 tokenList 中的可学习 token 建立短解释缓存。",
      "tokenAnalyses 中每个对象必须对应 tokenList 的一个 tokenIndex；不要重新分词，不要改变 tokenIndex。",
      "对助词、活用尾、补助动词、接续表达、固定搭配和句型相关 token，要在 dependsOn 写出必须一起看的后文 tokenIndex。",
      "spanText 应写该 token 实际需要一起看的日文片段；如果只需看单个 token，spanText 等于 text。",
      "meaning、role、explanation、memoryTip 都要短，适合点击后立刻显示；不要长篇讲义。",
      "必须只输出 JSON。JSON 形状：{\"summary\":\"简体中文总括\",\"sentence\":\"日文例句\",\"sentenceSummary\":\"简体中文整句拆解\",\"tokenAnalyses\":[{\"tokenIndex\":0,\"text\":\"日文token\",\"spanText\":\"日文片段\",\"meaning\":\"简体中文句中意思\",\"role\":\"简体中文成分\",\"dependsOn\":[1],\"explanation\":\"简体中文短解释\",\"memoryTip\":\"简体中文提醒\"}],\"examples\":[{\"sentence\":\"日文例句\",\"breakdown\":\"简体中文整句结构\",\"memoryTip\":\"简体中文提醒\"}]}",
    ].join("\n");
  }
  return [
    ...base,
    "用户单击词语时，不要只解释孤立词义。你必须先判断该词是否和后文 token 组成语法单位、固定搭配、接续表达、助词组合、补助动词、活用结构或惯用句。",
    "如果 candidateSpan 或 afterText 显示选中词应与后文一起理解，请以整个片段为分析对象，并说明为什么后文必须一起看。",
    "如果 selectionType 是 word，输出该词/片段在句中的意思、句法成分、形态/活用、关联后文片段、自然中文理解和记忆提醒。",
    "如果 selectionType 是 sentence，输出整句结构、句型作用、语气和记忆提醒。",
    "必须只输出 JSON，不要输出 markdown。JSON 形状：{\"summary\":\"用简体中文概括\",\"points\":[\"简体中文要点\"],\"examples\":[{\"sentence\":\"日文例句\",\"breakdown\":\"简体中文拆解\",\"memoryTip\":\"简体中文记忆提醒\"}]}",
  ].join("\n");
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  const requestedPath = safePath === "/" ? "/index.html" : safePath;
  const filePath = resolve(join(ROOT, requestedPath));
  if (!filePath.startsWith(ROOT) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function responseText(data) {
  const message = data?.choices?.[0]?.message;
  if (message?.content) {
    return stripThinking(contentText(message.content));
  }
  if (typeof data.reply === "string") return stripThinking(data.reply);
  if (typeof data.output_text === "string") return stripThinking(data.output_text);
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((content) => content.type === "output_text" || content.type === "text")
    .map((content) => content.text || "")
    .join("\n")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function stripThinking(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => item.text || item.content || "")
      .filter(Boolean)
      .join("\n");
  }
  return String(content || "");
}

function finalAnswerText(text) {
  const value = stripThinking(text);
  if (!value) return "";
  try {
    const parsed = normalizeAiResult(parseModelJson(value));
    return parsed.summary || parsed.points.join("；");
  } catch {}
  const finalMarker = value.match(/(?:final answer|final|最终答案|答案)\s*[:：]/i);
  const candidate = finalMarker
    ? value.slice((finalMarker.index || 0) + finalMarker[0].length).trim()
    : value;
  if (looksLikeReasoningLeak(candidate)) return "";
  return candidate;
}

function looksLikeReasoningLeak(text) {
  return /\b(Let me|I need to|Looking at|tokenIndex|candidateSpan|reasoning|thinking|tokens?\[|Wait,|Actually)\b/i.test(text);
}

function normalizeAiResult(result) {
  if (typeof result === "string") {
    return normalizeAiResult(parseModelJson(result));
  }
  if (result?.summary && looksLikeJsonString(result.summary)) {
    try {
      return normalizeAiResult(parseModelJson(result.summary));
    } catch {}
  }
  return {
    summary: cleanAiText(result?.summary),
    points: Array.isArray(result?.points)
      ? result.points.map(cleanAiText).filter(Boolean)
      : [],
    examples: Array.isArray(result?.examples)
      ? result.examples.map((example) => ({
        sentence: cleanAiText(example?.sentence),
        breakdown: cleanAiText(example?.breakdown),
        memoryTip: cleanAiText(example?.memoryTip),
      })).filter((example) => example.sentence || example.breakdown || example.memoryTip)
      : [],
  };
}

function normalizeSentenceCacheResult(result, context = {}) {
  if (typeof result === "string") {
    return normalizeSentenceCacheResult(parseModelJson(result), context);
  }
  if (result?.summary && looksLikeJsonString(result.summary)) {
    try {
      return normalizeSentenceCacheResult(parseModelJson(result.summary), context);
    } catch {}
  }
  const examples = context.examples || [];
  const tokens = context.tokens || [];
  const tokenAnalyses = Array.isArray(result?.tokenAnalyses)
    ? result.tokenAnalyses.map((item) => ({
      tokenIndex: Number.isInteger(item?.tokenIndex) ? item.tokenIndex : Number(item?.tokenIndex),
      text: cleanAiText(item?.text),
      spanText: cleanAiText(item?.spanText),
      meaning: cleanAiText(item?.meaning),
      role: cleanAiText(item?.role),
      dependsOn: normalizeIndexList(item?.dependsOn, tokens.length),
      explanation: cleanAiText(item?.explanation),
      memoryTip: cleanAiText(item?.memoryTip),
    })).filter((item) => Number.isInteger(item.tokenIndex) && item.tokenIndex >= 0 && (!tokens.length || item.tokenIndex < tokens.length))
    : [];
  return {
    analysisMode: "sentence-cache",
    summary: cleanAiText(result?.summary),
    sentence: cleanAiText(result?.sentence) || examples[0] || "",
    sentenceSummary: cleanAiText(result?.sentenceSummary) || cleanAiText(result?.summary),
    tokenAnalyses,
    examples: Array.isArray(result?.examples)
      ? result.examples.map((example) => ({
        sentence: cleanAiText(example?.sentence) || examples[0] || "",
        breakdown: cleanAiText(example?.breakdown),
        memoryTip: cleanAiText(example?.memoryTip),
      })).filter((example) => example.sentence || example.breakdown || example.memoryTip)
      : [],
  };
}

function normalizeIndexList(value, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && (!maxLength || item < maxLength));
}

function parseModelJson(text) {
  return parseJsonLike(stripThinking(text), 0);
}

function parseJsonLike(text, depth) {
  if (depth > 3) throw new Error("Too many JSON decoding layers");
  const cleaned = String(text || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const attempts = jsonCandidates(cleaned);
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === "string" && looksLikeJsonString(parsed)
        ? parseJsonLike(parsed, depth + 1)
        : parsed;
    } catch {}
  }
  throw new Error("Cannot parse model JSON");
}

function jsonCandidates(text) {
  const candidates = [text];
  const objectSlice = sliceJsonObject(text);
  if (objectSlice && objectSlice !== text) candidates.push(objectSlice);
  if (text.includes('\\"')) {
    const unescaped = text
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
    candidates.push(unescaped);
    const unescapedObjectSlice = sliceJsonObject(unescaped);
    if (unescapedObjectSlice && unescapedObjectSlice !== unescaped) candidates.push(unescapedObjectSlice);
  }
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function sliceJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function looksLikeJsonString(text) {
  const value = String(text || "").trim();
  return value.startsWith("{") || value.startsWith('\\"{') || value.includes('\\"summary\\"') || value.includes('"summary"');
}

function cleanAiText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
}

function sendApiError(response, httpStatus, details = {}) {
  sendJson(response, httpStatus, {
    error: details.error || "AI 请求失败。",
    code: details.code || "provider_unavailable",
    advice: details.advice || adviceForAiError(details.code || "provider_unavailable", details.provider),
    provider: details.provider ? normalizeProvider(details.provider) : null,
    status: Number(details.status || httpStatus),
    endpoint: details.endpoint || null,
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}
