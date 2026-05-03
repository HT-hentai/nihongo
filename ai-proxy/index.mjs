import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

loadDotEnv();

const PORT = Number(process.env.PORT || 8788);
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, "");
const BODY_LIMIT = Number(process.env.BODY_LIMIT || 512 * 1024);

const server = createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") return empty(res, 204);
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, model: DEEPSEEK_MODEL, hasKey: Boolean(DEEPSEEK_API_KEY) });
    }

    if (!url.pathname.startsWith("/api/deepseek/")) {
      return json(res, 404, { error: "not_found", message: "接口不存在" });
    }
    if (!DEEPSEEK_API_KEY) {
      return json(res, 503, { error: "missing_api_key", message: "请先设置 DEEPSEEK_API_KEY 再启动 AI 代理" });
    }

    const body = await readJson(req);
    if (req.method === "POST" && url.pathname === "/api/deepseek/explain") {
      return json(res, 200, await explain(body));
    }
    if (req.method === "POST" && url.pathname === "/api/deepseek/refine-selection") {
      return json(res, 200, await refineSelection(body));
    }
    if (req.method === "POST" && url.pathname === "/api/deepseek/quiz") {
      return json(res, 200, await quiz(body));
    }
    if (req.method === "POST" && url.pathname === "/api/deepseek/grade-sentence") {
      return json(res, 200, await gradeSentence(body));
    }
    return json(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: "internal_error", message: error.message || "AI 代理内部错误" });
  }
});

function loadDotEnv() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

server.listen(PORT, () => {
  console.log(`DeepSeek AI proxy listening on http://localhost:${PORT}`);
});

async function explain(body) {
  const system = [
    "你是日语 JLPT N2/N3/N4 语法老师。",
    "必须输出 JSON 对象，不要输出 Markdown。",
    "只解释用户提供的文本和上下文；不确定时明确写出 uncertainty。",
  ].join("\n");
  const user = {
    task: "explain_selection",
    output_json_shape: {
      original: "日文原文",
      reading: "假名读音或空字符串",
      meaning: "句中含义中文解释",
      partOfSpeech: "词性或表达类型",
      grammarPoints: [{ name: "语法名", explanation: "用法", level: "N2/N3/N4/unknown" }],
      sentenceBreakdown: [{ text: "片段", role: "句中作用", meaning: "中文" }],
      confusion: ["易混点"],
      examples: [{ ja: "例句", zh: "中文" }],
      reviewSuggestion: "如何复习",
      uncertainty: "不确定之处或空字符串",
    },
    selectedText: truncate(body.selectedText, 1200),
    mode: body.mode || "analyze",
    currentEntry: body.currentEntry || null,
    entryContext: truncate(body.entryContext, 12000),
    pageText: truncate(body.pageText, 5000),
    nearbyContext: truncate(body.nearbyContext, 5000),
  };
  const result = await deepseekJson(system, user, 2400);
  return { explanation: result, usage: result.__usage };
}

async function refineSelection(body) {
  const system = [
    "你是日语分词和 JLPT 语法块识别助手。",
    "必须输出 JSON 对象，不要输出 Markdown。",
    "startOffset/endOffset 必须是相对 sentenceText 的 JavaScript 字符串索引，endOffset 为开区间。",
    "优先返回自然单词、固定表达或完整语法块；不要扩到整句，除非局部本身就是整句表达。",
  ].join("\n");
  const user = {
    task: "refine_pdf_text_selection",
    output_json_shape: {
      text: "修正后的日文选区",
      startOffset: 0,
      endOffset: 0,
      kind: "word|phrase|grammar|expression",
      confidence: 0.0,
      reason: "中文说明，说明为什么扩成这个范围",
    },
    sentenceText: truncate(body.sentenceText, 1200),
    anchorOffset: Number(body.anchorOffset || 0),
    localSelectedText: truncate(body.localSelectedText, 200),
    currentEntry: body.currentEntry || null,
    entryContext: truncate(body.entryContext, 800),
    requirements: [
      "anchorOffset 是用户点击位置在 sentenceText 内的索引。",
      "返回范围必须覆盖 anchorOffset。",
      "如果 localSelectedText 已经正确，只返回同样范围。",
      "如果点击在语法表达中，返回完整语法块，例如 なくてはならない、にしたがって、ということだ。",
    ],
  };
  const result = await deepseekJson(system, user, 1200);
  return { selection: normalizeSelection(result, body.sentenceText || ""), usage: result.__usage };
}

async function quiz(body) {
  const system = [
    "你是 JLPT N2 备考出题老师。",
    "必须输出 JSON 对象，不要输出 Markdown。",
    "题目要检测语法理解，不要抄整段教材正文。",
  ].join("\n");
  const user = {
    task: "generate_mixed_quiz",
    output_json_shape: {
      title: "小测标题",
      questions: [
        {
          id: "q1",
          type: "choice|blank|sentence",
          prompt: "题干",
          choices: ["A", "B", "C", "D"],
          answer: "正确答案或参考表达",
          explanation: "解析",
          grammarRef: "N2-1",
        },
      ],
    },
    date: body.date,
    taskLabel: body.taskLabel,
    entries: body.entries || [],
    entryContext: truncate(body.entryContext, 18000),
    requirements: "生成 6 题：3 道选择题、2 道填空题、1 道造句题。choice 必须有 4 个选项。",
  };
  const result = await deepseekJson(system, user, 3600);
  return { quiz: normalizeQuiz(result), usage: result.__usage };
}

async function gradeSentence(body) {
  const system = [
    "你是严格但鼓励人的日语作文批改老师。",
    "必须输出 JSON 对象，不要输出 Markdown。",
  ].join("\n");
  const user = {
    task: "grade_sentence",
    output_json_shape: {
      score: 0,
      maxScore: 100,
      corrected: "改正后的句子",
      feedback: "中文反馈",
      grammarNotes: ["语法说明"],
      shouldReview: true,
    },
    prompt: body.prompt,
    answer: body.answer,
    expectedGrammar: body.grammarRef || "",
    entryContext: truncate(body.entryContext, 8000),
  };
  const result = await deepseekJson(system, user, 1800);
  return { grade: result, usage: result.__usage };
}

async function deepseekJson(system, user, maxTokens) {
  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `请按要求输出 json。\n${JSON.stringify(user, null, 2)}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: maxTokens,
      temperature: 0.4,
    }),
  });
  const payload = await response.json().catch(async () => ({ error: await response.text() }));
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.message || `DeepSeek ${response.status}`);
  }
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek 返回为空");
  const parsed = JSON.parse(content);
  parsed.__usage = payload.usage || null;
  return parsed;
}

function normalizeQuiz(value) {
  const questions = Array.isArray(value.questions) ? value.questions : [];
  return {
    title: value.title || "蓝宝书文法小测",
    questions: questions.map((question, index) => ({
      id: question.id || `q${index + 1}`,
      type: ["choice", "blank", "sentence"].includes(question.type) ? question.type : "choice",
      prompt: String(question.prompt || ""),
      choices: Array.isArray(question.choices) ? question.choices.slice(0, 4).map(String) : [],
      answer: String(question.answer || ""),
      explanation: String(question.explanation || ""),
      grammarRef: String(question.grammarRef || ""),
    })).filter((question) => question.prompt),
  };
}

function normalizeSelection(value, sentenceText) {
  const sentence = String(sentenceText || "");
  let text = String(value.text || "").trim();
  let startOffset = Number(value.startOffset);
  let endOffset = Number(value.endOffset);
  if ((!Number.isFinite(startOffset) || !Number.isFinite(endOffset) || endOffset <= startOffset) && text) {
    const index = sentence.indexOf(text);
    if (index >= 0) {
      startOffset = index;
      endOffset = index + text.length;
    }
  }
  startOffset = clampNumber(startOffset, 0, sentence.length);
  endOffset = clampNumber(endOffset, startOffset, sentence.length);
  if (!text && endOffset > startOffset) text = sentence.slice(startOffset, endOffset);
  return {
    text,
    startOffset,
    endOffset,
    kind: String(value.kind || "word"),
    confidence: clampNumber(Number(value.confidence || 0), 0, 1),
    reason: String(value.reason || ""),
  };
}

function truncate(value, limit) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function clampNumber(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

async function readJson(req) {
  const raw = await readRaw(req, BODY_LIMIT);
  return raw.length ? JSON.parse(raw.toString("utf8")) : {};
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(payload));
}

function empty(res, status) {
  res.writeHead(status);
  res.end();
}
