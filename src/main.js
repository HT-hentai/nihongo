const STORAGE_KEY = "bluebook-n2-agent-state-v1";
const STATE_VERSION = 3;
const START_DATE = "2026-05-01";
const END_DATE = "2026-07-04";
const EXAM_DATE = "2026-07-05";
const LEVEL_ORDER = ["N4", "N3", "N2"];
const PAST_PAPER_YEARS = {
  N3: range(2010, 2024),
  N2: range(2010, 2025),
};
const READING_SECTIONS = ["短文", "中文", "长文", "综合理解", "主张理解", "信息检索"];
const LISTENING_SECTIONS = ["课题理解", "要点理解", "概要理解", "即时应答", "综合理解"];
const MOJI_TEST_URL = "https://test.mojidict.com/";
const DEFAULT_PDF = {
  level: "N1-N5",
  fileName: "bluebook-n1-n5-grammar.pdf",
  publicUrl: "/public/materials/bluebooks/bluebook-n1-n5-grammar.pdf",
};
const PDFJS_MODULE = "/public/vendor/pdfjs/pdf.mjs";
const PDFJS_WORKER = "/public/vendor/pdfjs/pdf.worker.mjs";
const PDF_INDEX_DB = "bluebook-ai-pdf-index-v1";
const PDF_INDEX_META_KEY = "bluebook";
const AI_PROXY_DEFAULT = "http://localhost:8788";

let pdfjsLib = null;
let pdfDoc = null;
let pdfRenderTask = null;
let taskRegistry = new Map();
let pdfIndexPromise = null;
let app = {
  view: "today",
  selectedDate: clampDate(todayIso(), START_DATE, END_DATE),
  readerPage: 1,
  readerTitle: "蓝宝书",
  catalogFilter: "N2",
  scanMessage: "",
  readerSelection: null,
  aiPanel: { status: "idle", message: "", result: null },
  state: loadState(),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindGlobalActions();
  render();
  if (!app.state.catalog.length) {
    scanCatalogFromPdf(true);
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    pdf: DEFAULT_PDF,
    catalog: [],
    statuses: {},
    notes: {},
    pdfIndexMeta: null,
    aiNotebook: [],
    quizCache: {},
    quizResults: {},
    settings: {
      dailyMinutes: 240,
      grammarRange: "auto",
      ai: {
        enabled: true,
        proxyUrl: AI_PROXY_DEFAULT,
        model: "deepseek-chat",
      },
    },
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && saved.version <= STATE_VERSION) {
      return {
        ...defaultState(),
        ...saved,
        version: STATE_VERSION,
        pdf: { ...DEFAULT_PDF, ...(saved.pdf || {}) },
        settings: {
          ...defaultState().settings,
          ...(saved.settings || {}),
          ai: { ...defaultState().settings.ai, ...(saved.settings?.ai || {}) },
        },
        aiNotebook: saved.aiNotebook || [],
        quizCache: saved.quizCache || {},
        quizResults: saved.quizResults || {},
      };
    }
  } catch (error) {
    console.warn("Cannot parse saved state", error);
  }
  return defaultState();
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state));
}

function bindGlobalActions() {
  document.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "nav") {
      app.view = target.dataset.view;
      render();
    }
    if (action === "select-date") {
      app.selectedDate = target.dataset.date;
      app.view = "today";
      render();
    }
    if (action === "shift-date") {
      app.selectedDate = clampDate(addDays(app.selectedDate, Number(target.dataset.delta)), START_DATE, END_DATE);
      render();
    }
    if (action === "today") {
      app.selectedDate = clampDate(todayIso(), START_DATE, END_DATE);
      app.view = "today";
      render();
    }
    if (action === "scan-catalog") {
      scanCatalogFromPdf(false);
    }
    if (action === "open-reader") {
      openReader(Number(target.dataset.page || 1), target.dataset.title || "蓝宝书");
    }
    if (action === "open-external") {
      window.open(target.dataset.url, "_blank", "noopener");
    }
    if (action === "set-status") {
      setTaskStatus(target.dataset.taskId, target.dataset.status);
    }
    if (action === "set-confidence") {
      setTaskConfidence(target.dataset.taskId, Number(target.dataset.confidence));
    }
    if (action === "export-state") {
      exportState();
    }
    if (action === "import-state") {
      importState();
    }
    if (action === "reset-progress") {
      resetProgress();
    }
    if (action === "reader-prev") {
      openReader(Math.max(1, app.readerPage - 1), app.readerTitle);
    }
    if (action === "reader-next") {
      openReader(Math.min((pdfDoc && pdfDoc.numPages) || 965, app.readerPage + 1), app.readerTitle);
    }
    if (action === "build-pdf-index") {
      buildPdfIndex(true);
    }
    if (action === "ai-explain-selection") {
      explainReaderSelection(target.dataset.mode || "analyze");
    }
    if (action === "ai-save-selection") {
      saveReaderSelection();
    }
    if (action === "generate-quiz") {
      generateQuiz(target.dataset.taskId);
    }
    if (action === "answer-quiz-choice") {
      answerQuizChoice(target.dataset.quizKey, target.dataset.questionId, target.dataset.value);
    }
    if (action === "check-quiz-blank") {
      checkQuizBlank(target.dataset.quizKey, target.dataset.questionId);
    }
    if (action === "grade-quiz-sentence") {
      gradeQuizSentence(target.dataset.quizKey, target.dataset.questionId);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-catalog-field]")) {
      updateCatalogField(target.dataset.entryId, target.dataset.catalogField, target.value);
    }
    if (target.matches("[data-date-picker]")) {
      app.selectedDate = clampDate(target.value, START_DATE, END_DATE);
      render();
    }
    if (target.matches("[data-catalog-filter]")) {
      app.catalogFilter = target.value;
      render();
    }
    if (target.matches("[data-reader-page]")) {
      openReader(Number(target.value || 1), app.readerTitle);
    }
  });

  document.addEventListener("mouseup", handleTextSelection);
}

async function getPdfJs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(PDFJS_MODULE);
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  return pdfjsLib;
}

async function getPdfDoc() {
  if (!pdfDoc) {
    const lib = await getPdfJs();
    pdfDoc = await lib.getDocument(app.state.pdf.publicUrl).promise;
  }
  return pdfDoc;
}

async function scanCatalogFromPdf(isAuto) {
  app.scanMessage = "正在扫描 PDF 书签...";
  render();
  try {
    const pdf = await getPdfDoc();
    const outline = await pdf.getOutline();
    const entries = await catalogFromOutline(outline || [], pdf);
    if (!entries.length) {
      app.scanMessage = "没有从 PDF 大纲中识别到 N4/N3/N2 条目，请在目录校对页手动导入 JSON。";
      render();
      return;
    }
    app.state.catalog = entries;
    app.state.pdf = { ...DEFAULT_PDF, pages: pdf.numPages };
    saveState();
    app.scanMessage = `已识别 ${entries.length} 条文法：N4 ${countLevel(entries, "N4")} 条，N3 ${countLevel(entries, "N3")} 条，N2 ${countLevel(entries, "N2")} 条。`;
    if (isAuto) app.view = "today";
    render();
  } catch (error) {
    console.error(error);
    app.scanMessage = "PDF.js 加载或扫描失败。请确认网络可访问 CDN，PDF 文件在 public/materials/bluebooks/。";
    render();
  }
}

async function catalogFromOutline(outline, pdf) {
  const flat = [];
  function walk(items, depth = 0, level = null) {
    for (const item of items) {
      const title = item.title || "";
      const nextLevel = /N[234]文法/.test(title) ? title.match(/N[234]/)[0] : level;
      flat.push({ item, title, depth, level: nextLevel });
      if (item.items && item.items.length) {
        walk(item.items, depth + 1, nextLevel);
      }
    }
  }
  walk(outline);

  const entries = [];
  for (const node of flat) {
    if (!LEVEL_ORDER.includes(node.level)) continue;
    const parsed = parseEntryTitle(node.title);
    if (!parsed) continue;
    const page = await pageFromDestination(pdf, node.item.dest);
    entries.push({
      id: `${node.level}-${parsed.number}`,
      level: node.level,
      number: parsed.number,
      title: parsed.title || `第 ${parsed.number} 条`,
      page,
      pdfTarget: page ? `page=${page}` : "",
      videoRef: "",
    });
  }
  return uniqueEntries(entries).sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.number - b.number);
}

function parseEntryTitle(title) {
  if (/^\s*第\s*\d+\s*单元/.test(title)) return null;
  const match = title.match(/^\s*(?:第\s*)?(\d{1,3})[.．、]?\s*(.+)$/);
  if (!match) return null;
  return {
    number: Number(match[1]),
    title: cleanupTitle(match[2]),
  };
}

function cleanupTitle(title) {
  return title
    .replace(/\s+/g, " ")
    .replace(/[｜\u0000-\u001f]/g, "")
    .trim();
}

async function pageFromDestination(pdf, dest) {
  if (!dest) return null;
  try {
    const explicitDest = Array.isArray(dest) ? dest : await pdf.getDestination(dest);
    if (!explicitDest || !explicitDest[0]) return null;
    const pageIndex = await pdf.getPageIndex(explicitDest[0]);
    return pageIndex + 1;
  } catch (error) {
    return null;
  }
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.level}-${entry.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countLevel(entries, level) {
  return entries.filter((entry) => entry.level === level).length;
}

function render() {
  const root = document.querySelector("#app");
  const basePlan = buildPlan(app.state.catalog);
  const plan = buildRollingPlan(basePlan, app.state.statuses, app.state.settings, todayIso());
  const progress = progressSummary(plan);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const daysLeft = daysUntil(EXAM_DATE, clampDate(todayIso(), START_DATE, END_DATE));
  taskRegistry = new Map();
  root.innerHTML = `
    <main class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">N2</div>
          <div>
            <h1>蓝宝书备考 Agent</h1>
            <p>${daysLeft} 天后考试 · ${formatDate(EXAM_DATE)}</p>
          </div>
        </div>
        <nav class="nav">
          ${navButton("today", "今日计划")}
          ${navButton("calendar", "日历")}
          ${navButton("review", "积压池")}
          ${navButton("notebook", "AI 生词本")}
          ${navButton("catalog", "目录校对")}
          ${navButton("reader", "PDF 阅读器")}
        </nav>
        <div class="side-panel">
          <strong>备考进度 ${pct}%</strong>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <p>${progress.done}/${progress.total} 个任务已完成，目录 ${app.state.catalog.length || 0} 条</p>
        </div>
        <div class="side-panel">
          <strong>滚动规则</strong>
          <p>所有未完成任务都会按每日上限滚动重排；信心 1-2 分进入复盘池；PDF 只在本地阅读器打开</p>
        </div>
        <div class="side-panel">
          <strong>真题来源</strong>
          <p>阅读和听力使用 MOJi Test：N3 2010-2024，N2 2010-2025。用 Chrome 打开本页可复用 Chrome 登录态</p>
        </div>
      </aside>
      <section class="content">
        ${app.state.catalog.length ? renderView(plan) : renderSetup()}
      </section>
    </main>
  `;
  if (app.view === "reader" && app.state.catalog.length) {
    renderPdfPage(app.readerPage);
  }
}

function navButton(view, label) {
  return `<button class="${app.view === view ? "active" : ""}" data-action="nav" data-view="${view}">${label}</button>`;
}

function renderView(plan) {
  if (app.view === "calendar") return renderCalendar(plan);
  if (app.view === "review") return renderReview(plan);
  if (app.view === "notebook") return renderNotebook();
  if (app.view === "catalog") return renderCatalog();
  if (app.view === "reader") return renderReader();
  return renderToday(plan);
}

function renderSetup() {
  return `
    <div class="topbar">
      <div>
        <h2>初始化蓝宝书目录</h2>
        <p>从本地 PDF 大纲识别 N4/N3/N2 文法条目。</p>
      </div>
      <div class="toolbar">
        <button class="primary" data-action="scan-catalog">扫描 PDF 书签</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-body">
        <div class="empty">
          PDF 文件：<strong>${app.state.pdf.fileName}</strong><br />
          路径：<strong>${app.state.pdf.publicUrl}</strong><br />
          ${app.scanMessage || "正在等待扫描。"}
        </div>
      </div>
    </section>
  `;
}

function renderToday(plan) {
  const tasks = tasksForDate(app.selectedDate, plan);
  const totalMinutes = tasks.reduce((sum, task) => sum + displayMinutes(task), 0);
  const done = tasks.filter((task) => statusFor(task).status === "done").length;
  const grammar = tasks.filter((task) => task.type === "grammar").length;
  return `
    <div class="topbar">
      <div>
        <h2>${formatDate(app.selectedDate)} 计划</h2>
        <p>${phaseLabel(app.selectedDate)}，预计 ${totalMinutes} 分钟。</p>
      </div>
      <div class="toolbar">
        <button data-action="shift-date" data-delta="-1">上一天</button>
        <input type="date" min="${START_DATE}" max="${END_DATE}" value="${app.selectedDate}" data-date-picker />
        <button data-action="shift-date" data-delta="1">下一天</button>
        <button class="ghost" data-action="today">今天</button>
      </div>
    </div>
    <div class="layout">
      <section>
        <div class="stat-grid">
          ${stat("任务", `${done}/${tasks.length}`)}
          ${stat("文法", `${grammar} 项`)}
          ${stat("词汇", `${vocabCountForTasks(tasks)} 个`)}
          ${stat("剩余", `${daysUntil(EXAM_DATE, app.selectedDate)} 天`)}
        </div>
        ${renderRollingNotice(app.selectedDate, plan)}
        <div class="task-list">
          ${tasks.map(renderTask).join("") || `<div class="empty">这一天没有任务。</div>`}
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <h3>当天条目</h3>
          <p>点击文法任务可跳到蓝宝书页码。</p>
        </div>
        <div class="panel-body">
          ${renderDayOutline(tasks)}
        </div>
      </aside>
    </div>
  `;
}

function renderRollingNotice(date, plan) {
  const rolling = plan.rolling;
  if (!rolling || date < rolling.today) return "";
  const adjustedTasks = tasksForDate(date, plan).filter((task) => task.rolloverReason);
  const shouldShow = date === rolling.today || adjustedTasks.length || rolling.capacityWarning;
  if (!shouldShow) return "";

  const backlogCount = rolling.backlogItems.length;
  const backlogMinutes = rolling.totalBacklogMinutes;
  const mode = rolling.capacityWarning
    ? "容量不足"
    : rolling.todayAddedCount && rolling.futureAddedCount
      ? "今天加量，剩余均摊"
      : rolling.todayAddedCount
        ? "今天加量"
        : rolling.futureAddedCount
          ? "均摊到未来几天"
          : "按原计划";
  const adjustedMinutes = adjustedTasks.reduce((sum, task) => sum + task.remainingMinutes, 0);
  const adjustedMetricLabel = date === rolling.today ? "今日补入" : "本日补入";
  const adjustedMetricMinutes = date === rolling.today ? rolling.todayAddedMinutes : adjustedMinutes;
  const backlogPreview = rolling.backlogItems
    .slice(0, 4)
    .map((candidate) => `<span class="pill warn">${formatDate(candidate.baseDate)} · ${candidate.sourceTask.label}</span>`)
    .join("");

  return `
    <div class="rolling-notice ${rolling.capacityWarning ? "risk" : ""}">
      <div class="rolling-copy">
        <div class="task-title">
          <span class="pill warn">滚动调整</span>
          <h4>${mode}</h4>
        </div>
        <p>
          ${backlogCount
            ? `发现 ${backlogCount} 项积压，共 ${backlogMinutes} 分钟。${date === rolling.today ? `今天补入 ${rolling.todayAddedCount} 项；放不下的会排到后续日期。` : `这一天补入 ${adjustedTasks.length} 项，共 ${adjustedMinutes} 分钟。`}`
            : "没有发现过去未完成任务，今天按原计划推进。"}
          ${rolling.capacityWarning ? `考前仍缺 ${rolling.capacityWarning.gapMinutes} 分钟容量，需要提高每日上限或删减任务。` : ""}
        </p>
        ${backlogPreview ? `<div class="task-items">${backlogPreview}${backlogCount > 4 ? `<span class="pill">+${backlogCount - 4} 项</span>` : ""}</div>` : ""}
      </div>
      <div class="rolling-metrics">
        ${stat("积压", `${backlogMinutes} 分`)}
        ${stat(adjustedMetricLabel, `${adjustedMetricMinutes} 分`)}
      </div>
    </div>
  `;
}

function stat(label, value) {
  return `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`;
}

function renderDayOutline(tasks) {
  const grammarTasks = tasks.filter((task) => task.type === "grammar");
  if (!grammarTasks.length) return `<div class="empty">今天没有蓝宝书文法新条目。</div>`;
  return grammarTasks
    .map((task) => {
      const entries = refsToEntries(task.entryRefs);
      return `
        <div class="task-items" style="margin: 0 0 12px;">
          <span class="pill ${task.mode === "carryover" ? "warn" : "level"}">${task.modeLabel}</span>
          <span class="pill">${entryRangeLabel(entries)}</span>
        </div>
        <div class="task-meta" style="margin-bottom: 14px;">${entries.slice(0, 8).map((entry) => `${entry.number}. ${entry.title}`).join("<br />")}${entries.length > 8 ? "<br />..." : ""}</div>
      `;
    })
    .join("");
}

function renderTask(task) {
  taskRegistry.set(task.id, task);
  const current = statusFor(task);
  const entries = refsToEntries(task.entryRefs || []);
  const page = entries.find((entry) => entry.page)?.page;
  return `
    <article class="task task-${task.type} status-${current.status}">
      <div class="task-main">
        <div>
          <div class="task-title">
            <span class="pill ${pillForTask(task)}">${task.kindLabel}</span>
            ${task.rolloverReason ? `<span class="pill warn">${task.rolloverReason}</span>` : ""}
            <h4>${task.label}</h4>
          </div>
          <div class="task-meta">${task.detail}</div>
          ${renderTaskItems(task)}
          ${renderQuiz(task)}
        </div>
        <div class="task-actions">
          ${page ? `<button class="primary small" data-action="open-reader" data-page="${page}" data-title="${escapeAttr(task.label)}">打开 PDF</button>` : ""}
          ${task.type === "grammar" && task.mode !== "review" ? `<button class="small" data-action="generate-quiz" data-task-id="${escapeAttr(task.id)}">生成小测</button>` : ""}
          ${task.externalUrl ? `<button class="primary small" data-action="open-external" data-url="${escapeAttr(task.externalUrl)}">${escapeAttr(task.externalLabel || "打开资料")}</button>` : ""}
        </div>
      </div>
      <div class="statusbar">
        <span class="pill ${current.status === "done" ? "level" : current.status === "partial" ? "warn" : current.status === "skipped" ? "bad" : ""}">${statusLabel(current.status)}</span>
        <div class="segmented">
          ${statusButton(task, "done", "完成", current.status)}
          ${statusButton(task, "partial", "部分", current.status)}
          ${statusButton(task, "skipped", "跳过", current.status)}
          ${statusButton(task, "todo", "重置", current.status)}
        </div>
        <span class="pill info">信心</span>
        <div class="segmented confidence">
          ${[1, 2, 3, 4, 5].map((score) => `<button class="${current.confidence === score ? "active" : ""}" data-action="set-confidence" data-task-id="${task.id}" data-confidence="${score}">${score}</button>`).join("")}
        </div>
      </div>
    </article>
  `;
}

function statusButton(task, status, label, currentStatus) {
  return `<button class="${currentStatus === status ? "active" : ""}" data-action="set-status" data-task-id="${task.id}" data-status="${status}">${label}</button>`;
}

function renderTaskItems(task) {
  if (task.type === "grammar") {
    return `<div class="task-items">${refsToEntries(task.entryRefs).slice(0, 12).map((entry) => `<span class="pill">${entry.number}. ${entry.title}</span>`).join("")}</div>`;
  }
  if (task.type === "ai-review") {
    return `<div class="task-items">${(task.reviewItems || []).slice(0, 12).map((item) => `<span class="pill">${escapeHtml(item.label)}</span>`).join("")}</div>`;
  }
  if (task.items && task.items.length) {
    return `<div class="task-items">${task.items.slice(0, 18).map((item) => `<span class="pill">${item}</span>`).join("")}</div>`;
  }
  return "";
}

function renderQuiz(task) {
  if (task.type !== "grammar" || task.mode === "review") return "";
  const key = quizKeyForTask(task);
  const quiz = app.state.quizCache[key];
  const result = app.state.quizResults[key] || { answers: {}, checked: {} };
  if (!quiz) return "";
  if (quiz.status === "loading") return `<div class="quiz-box"><span class="pill warn">AI 小测</span><p>正在生成小测...</p></div>`;
  if (quiz.status === "error") return `<div class="quiz-box"><span class="pill bad">AI 小测失败</span><p>${escapeHtml(quiz.message || "请确认 8788 AI 代理已启动。")}</p></div>`;
  const questions = quiz.questions || [];
  return `
    <div class="quiz-box">
      <div class="task-title">
        <span class="pill info">AI 小测</span>
        <h4>${escapeHtml(quiz.title || "蓝宝书文法小测")}</h4>
        ${typeof result.score === "number" ? `<span class="pill ${result.score >= 70 ? "level" : "warn"}">${result.score} 分</span>` : ""}
      </div>
      ${questions.map((question, index) => renderQuizQuestion(key, question, index, result)).join("")}
    </div>
  `;
}

function renderQuizQuestion(quizKey, question, index, result) {
  const answer = result.answers?.[question.id] || "";
  const checked = result.checked?.[question.id];
  const dom = domId(`${quizKey}-${question.id}`);
  const feedback = checked ? `<p class="quiz-feedback ${checked.correct === false ? "bad" : ""}">${escapeHtml(checked.feedback || checked.explanation || "")}</p>` : "";
  if (question.type === "choice") {
    return `
      <div class="quiz-question">
        <strong>${index + 1}. ${escapeHtml(question.prompt)}</strong>
        <div class="task-items">
          ${(question.choices || []).map((choice) => `<button class="small ${answer === choice ? "active" : ""}" data-action="answer-quiz-choice" data-quiz-key="${escapeAttr(quizKey)}" data-question-id="${escapeAttr(question.id)}" data-value="${escapeAttr(choice)}">${escapeHtml(choice)}</button>`).join("")}
        </div>
        ${feedback}
      </div>
    `;
  }
  if (question.type === "sentence") {
    return `
      <div class="quiz-question">
        <strong>${index + 1}. ${escapeHtml(question.prompt)}</strong>
        <textarea id="${dom}" class="quiz-input" placeholder="写一句日语句子">${escapeHtml(answer)}</textarea>
        <button class="small" data-action="grade-quiz-sentence" data-quiz-key="${escapeAttr(quizKey)}" data-question-id="${escapeAttr(question.id)}">AI 批改</button>
        ${feedback}
      </div>
    `;
  }
  return `
    <div class="quiz-question">
      <strong>${index + 1}. ${escapeHtml(question.prompt)}</strong>
      <input id="${dom}" class="quiz-input" value="${escapeAttr(answer)}" placeholder="填写答案" />
      <button class="small" data-action="check-quiz-blank" data-quiz-key="${escapeAttr(quizKey)}" data-question-id="${escapeAttr(question.id)}">检查</button>
      ${feedback}
    </div>
  `;
}

function pillForTask(task) {
  if (task.mode === "carryover") return "warn";
  if (task.type === "grammar") return "level";
  if (task.type === "ai-review") return "warn";
  if (task.type === "review") return "warn";
  if (task.type === "mock") return "bad";
  return "info";
}

function statusLabel(status) {
  return {
    todo: "未完成",
    done: "已完成",
    partial: "部分完成",
    skipped: "跳过",
  }[status || "todo"];
}

function renderCalendar(plan) {
  const dates = dateRange(START_DATE, END_DATE);
  return `
    <div class="topbar">
      <div>
        <h2>滚动日历</h2>
        <p>每一天都显示蓝宝书范围，点击日期进入当天。</p>
      </div>
      <div class="toolbar">
        <button class="ghost" data-action="today">回到今天</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-body">
        <div class="calendar-grid">
          ${dates.map((date) => renderCalendarDay(date, plan)).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderCalendarDay(date, plan) {
  const tasks = tasksForDate(date, plan);
  const grammar = tasks.filter((task) => task.type === "grammar");
  const rolloverCount = tasks.filter((task) => task.rolloverReason).length;
  const total = tasks.length;
  const done = tasks.filter((task) => statusFor(task).status === "done").length;
  return `
    <button class="day-card ${date === app.selectedDate ? "active" : ""} ${rolloverCount ? "has-rollover" : ""}" data-action="select-date" data-date="${date}">
      <strong>${formatShortDate(date)}</strong>
      <span>${done}/${total} 完成${rolloverCount ? ` · ${rolloverCount} 项调整` : ""}</span>
      <p>${grammar.slice(0, 2).map((task) => task.label).join("<br />") || phaseLabel(date)}</p>
    </button>
  `;
}

function renderReview(plan) {
  const items = reviewItems(plan);
  return `
    <div class="topbar">
      <div>
        <h2>积压与复盘池</h2>
        <p>未完成、部分完成、低信心的任务都会聚到这里，不再只看文法。</p>
      </div>
      <div class="toolbar">
        <button data-action="export-state">导出进度</button>
        <button class="danger" data-action="reset-progress">清空进度</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-body">
        <div class="task-list">
          ${items.map(renderTask).join("") || `<div class="empty">复盘池是空的。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderNotebook() {
  const items = app.state.aiNotebook || [];
  const due = items.filter((item) => !item.archived && (!item.nextReviewDate || item.nextReviewDate <= todayIso())).length;
  return `
    <div class="topbar">
      <div>
        <h2>AI 生词本</h2>
        <p>${items.length} 个收藏，${due} 个今天应复习。收藏不会写入 PDF，也不会导出 PDF 正文。</p>
      </div>
      <div class="toolbar">
        <button data-action="nav" data-view="reader">去 PDF 选句</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-body">
        <div class="task-list">
          ${items.map(renderNotebookItem).join("") || `<div class="empty">还没有收藏。打开 PDF 阅读器，选中词或例句后点击收藏。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderNotebookItem(item) {
  return `
    <article class="task task-ai-review">
      <div class="task-main">
        <div>
          <div class="task-title">
            <span class="pill warn">${item.type === "sentence" ? "例句" : item.type === "grammar" ? "语法" : "生词"}</span>
            <h4>${escapeHtml(item.text)}</h4>
          </div>
          <div class="task-meta">${escapeHtml(item.meaning || item.reviewSuggestion || "待复习")} · 下次 ${item.nextReviewDate || "今天"} · 第 ${item.sourcePage || "?"} 页</div>
          ${(item.grammarRefs || []).length ? `<div class="task-items">${item.grammarRefs.map((ref) => `<span class="pill">${escapeHtml(ref)}</span>`).join("")}</div>` : ""}
        </div>
      </div>
    </article>
  `;
}

function renderCatalog() {
  const entries = app.state.catalog.filter((entry) => entry.level === app.catalogFilter);
  return `
    <div class="topbar">
      <div>
        <h2>目录校对</h2>
        <p>标题乱码或页码不准时，在这里改；每日计划会立即更新。</p>
      </div>
      <div class="toolbar">
        <select data-catalog-filter>
          ${LEVEL_ORDER.map((level) => `<option value="${level}" ${app.catalogFilter === level ? "selected" : ""}>${level}</option>`).join("")}
        </select>
        <button data-action="scan-catalog">重新扫描 PDF</button>
        <button data-action="export-state">导出 JSON</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-body">
        ${app.scanMessage ? `<div class="empty" style="margin-bottom: 12px;">${app.scanMessage}</div>` : ""}
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>级别</th>
                <th>条目</th>
                <th>句型名</th>
                <th>页码</th>
                <th>视频链接</th>
                <th>打开</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map(renderCatalogRow).join("")}
            </tbody>
          </table>
        </div>
        <div class="panel-head" style="padding-left:0;">
          <h3>导入 JSON</h3>
          <p>粘贴之前导出的完整状态，或只包含 catalog 的 JSON。</p>
        </div>
        <textarea class="json-box" id="importBox" placeholder='{"catalog":[...]}'></textarea>
        <div class="toolbar" style="margin-top: 10px;">
          <button class="primary" data-action="import-state">导入</button>
        </div>
        <p class="source-note">蓝宝书正文没有写入应用数据，只通过本地 PDF 阅读。词汇任务只记录每日数量，请在你的背词 app 中完成。</p>
      </div>
    </section>
  `;
}

function renderCatalogRow(entry) {
  return `
    <tr>
      <td>${entry.level}</td>
      <td>${entry.number}</td>
      <td><input value="${escapeAttr(entry.title)}" data-catalog-field="title" data-entry-id="${entry.id}" /></td>
      <td><input type="number" min="1" value="${entry.page || ""}" data-catalog-field="page" data-entry-id="${entry.id}" /></td>
      <td><input value="${escapeAttr(entry.videoRef || "")}" data-catalog-field="videoRef" data-entry-id="${entry.id}" /></td>
      <td>${entry.page ? `<button class="small" data-action="open-reader" data-page="${entry.page}" data-title="${escapeAttr(`${entry.level} 第 ${entry.number} 条`)}">PDF</button>` : ""}</td>
    </tr>
  `;
}

function renderReader() {
  return `
    <div class="topbar">
      <div>
        <h2>PDF 阅读器</h2>
        <p>${app.readerTitle}</p>
      </div>
      <div class="toolbar">
        <button data-action="nav" data-view="today">返回今日</button>
      </div>
    </div>
    <div class="reader-shell">
      <section class="pdf-frame">
        <div class="pdf-toolbar">
          <button class="small" data-action="reader-prev">上一页</button>
          <input type="number" min="1" value="${app.readerPage}" data-reader-page />
          <span id="pageCount">/ ${app.state.pdf.pages || 965}</span>
          <button class="small" data-action="reader-next">下一页</button>
          <span id="readerStatus">加载中...</span>
        </div>
        <div class="canvas-wrap">
          <iframe id="pdfFallback" class="pdf-fallback" src="${app.state.pdf.publicUrl}#page=${app.readerPage}" title="蓝宝书 PDF"></iframe>
          <canvas id="pdfCanvas" style="display:none;"></canvas>
          <div id="textLayer" class="text-layer"></div>
          <div id="annotationLayer" class="annotation-layer"></div>
          <div id="selectionTools" class="selection-tools" hidden></div>
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <h3>AI 阅读助手</h3>
          <p>选中 PDF 里的词或例句后，可以解释、识别语法或收藏。</p>
        </div>
        <div class="panel-body">
          ${renderReaderAiPanel()}
          <div class="panel-head" style="padding: 14px 0 0;">
            <h3>快速跳转</h3>
            <p>按级别和条目打开 PDF。</p>
          </div>
          ${LEVEL_ORDER.map((level) => quickJumpLevel(level)).join("")}
        </div>
      </aside>
    </div>
  `;
}

function renderReaderAiPanel() {
  const meta = app.state.pdfIndexMeta;
  const result = app.aiPanel.result;
  return `
    <div class="ai-reader-box">
      <div class="task-items" style="margin-top:0;">
        <span class="pill ${meta?.fingerprint ? "level" : "warn"}">${meta?.fingerprint ? "索引已建" : "索引未建"}</span>
        <span class="pill">代理 ${app.state.settings.ai.proxyUrl}</span>
      </div>
      <p class="task-meta" id="pdfIndexStatus">${meta?.indexedAt ? `索引时间：${formatDateTime(meta.indexedAt)}` : "首次打开阅读器会在后台建立本机索引。"}</p>
      <button class="small" data-action="build-pdf-index">重建索引</button>
      ${app.aiPanel.status === "loading" ? `<div class="empty" style="margin-top:12px;">AI 正在分析选中文本...</div>` : ""}
      ${app.aiPanel.message ? `<div class="empty" style="margin-top:12px;">${escapeHtml(app.aiPanel.message)}</div>` : ""}
      ${result ? renderAiExplanation(result) : ""}
    </div>
  `;
}

function renderAiExplanation(result) {
  const grammar = result.grammarPoints || [];
  return `
    <div class="ai-result">
      <div class="task-title">
        <span class="pill info">解释</span>
        <h4>${escapeHtml(result.original || app.readerSelection?.text || "")}</h4>
      </div>
      <p>${escapeHtml(result.meaning || "")}</p>
      ${result.reading ? `<p class="task-meta">读音：${escapeHtml(result.reading)}</p>` : ""}
      ${grammar.length ? `<div class="task-items">${grammar.map((item) => `<span class="pill">${escapeHtml(item.level || "语法")} ${escapeHtml(item.name || "")}</span>`).join("")}</div>` : ""}
      ${result.reviewSuggestion ? `<p class="task-meta">${escapeHtml(result.reviewSuggestion)}</p>` : ""}
    </div>
  `;
}

function quickJumpLevel(level) {
  const entries = app.state.catalog.filter((entry) => entry.level === level);
  const first = entries[0];
  const last = entries[entries.length - 1];
  return `
    <div class="task-items" style="margin-bottom: 12px;">
      <span class="pill level">${level}</span>
      <span class="pill">${entries.length} 条</span>
      ${first ? `<button class="small" data-action="open-reader" data-page="${first.page}" data-title="${level} 第 ${first.number} 条">第 ${first.number} 条</button>` : ""}
      ${last ? `<button class="small" data-action="open-reader" data-page="${last.page}" data-title="${level} 第 ${last.number} 条">第 ${last.number} 条</button>` : ""}
    </div>
  `;
}

async function renderPdfPage(pageNumber) {
  const status = document.querySelector("#readerStatus");
  const canvas = document.querySelector("#pdfCanvas");
  const fallback = document.querySelector("#pdfFallback");
  const layer = document.querySelector("#annotationLayer");
  if (!canvas || !layer) return;
  try {
    if (fallback) fallback.src = `${app.state.pdf.publicUrl}#page=${pageNumber}`;
    if (status) status.textContent = "PDF.js 渲染中，后备阅读器可直接使用";
    const fallbackTimer = window.setTimeout(() => {
      if (status && status.textContent.includes("PDF.js 渲染中")) {
        status.textContent = "使用后备阅读器";
      }
    }, 4000);
    const pdf = await getPdfDoc();
    app.state.pdf.pages = pdf.numPages;
    pageNumber = clampNumber(pageNumber, 1, pdf.numPages);
    app.readerPage = pageNumber;
    const page = await pdf.getPage(pageNumber);
    const wrap = document.querySelector(".canvas-wrap");
    const width = Math.min((wrap && wrap.clientWidth ? wrap.clientWidth : 920) - 36, 884);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = width / unscaled.width;
    const viewport = page.getViewport({ scale });
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    const context = canvas.getContext("2d");
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    if (pdfRenderTask) pdfRenderTask.cancel();
    pdfRenderTask = page.render({ canvasContext: context, viewport });
    await pdfRenderTask.promise;
    window.clearTimeout(fallbackTimer);
    canvas.style.display = "block";
    if (fallback) fallback.style.display = "none";
    await renderTextLayer(page, viewport);
    await renderAnnotations(page, viewport, layer);
    ensurePdfIndexStarted();
    const pageInput = document.querySelector("[data-reader-page]");
    if (pageInput) pageInput.value = pageNumber;
    const pageCount = document.querySelector("#pageCount");
    if (pageCount) pageCount.textContent = `/ ${pdf.numPages}`;
    if (status) status.textContent = `第 ${pageNumber} 页`;
  } catch (error) {
    console.error(error);
    canvas.style.display = "none";
    layer.innerHTML = "";
    if (fallback) fallback.style.display = "block";
    if (status) status.innerHTML = `PDF.js 渲染失败，已切换到后备阅读器`;
  }
}

async function renderTextLayer(page, viewport) {
  const layer = document.querySelector("#textLayer");
  if (!layer) return;
  layer.innerHTML = "";
  layer.style.width = `${viewport.width}px`;
  layer.style.height = `${viewport.height}px`;
  const textContent = await page.getTextContent();
  app.currentPageText = textContent.items.map((item) => item.str).join(" ").replace(/\s+/g, " ").trim();
  const lib = await getPdfJs();
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = lib.Util.transform(viewport.transform, item.transform);
    const span = document.createElement("span");
    span.textContent = item.str;
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5]}px`;
    span.style.fontSize = `${Math.max(8, Math.hypot(tx[2], tx[3]))}px`;
    span.style.transform = `scaleX(${Math.max(0.7, Math.min(1.4, (item.width || 1) / Math.max(1, item.str.length * Math.max(8, Math.hypot(tx[0], tx[1])) * 0.5)))})`;
    layer.appendChild(span);
  }
}

async function renderAnnotations(page, viewport, layer) {
  layer.innerHTML = "";
  const annotations = await page.getAnnotations({ intent: "display" });
  for (const annotation of annotations) {
    if (annotation.subtype !== "Link") continue;
    const rect = viewport.convertToViewportRectangle(annotation.rect);
    const left = Math.min(rect[0], rect[2]);
    const top = Math.min(rect[1], rect[3]);
    const width = Math.abs(rect[0] - rect[2]);
    const height = Math.abs(rect[1] - rect[3]);
    const button = document.createElement("button");
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.style.width = `${width}px`;
    button.style.height = `${height}px`;
    button.title = "PDF 内部链接";
    button.addEventListener("click", async () => {
      if (annotation.url) {
        window.open(annotation.url, "_blank");
        return;
      }
      if (annotation.dest) {
        const pdf = await getPdfDoc();
        const dest = Array.isArray(annotation.dest) ? annotation.dest : await pdf.getDestination(annotation.dest);
        const index = await pdf.getPageIndex(dest[0]);
        openReader(index + 1, "PDF 内部链接");
      }
    });
    layer.appendChild(button);
  }
}

function openReader(page, title) {
  app.readerPage = clampNumber(page || 1, 1, app.state.pdf.pages || 965);
  app.readerTitle = title || "蓝宝书";
  app.view = "reader";
  render();
}

function handleTextSelection(event) {
  const layer = event.target.closest?.("#textLayer");
  if (!layer) return;
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : "";
  if (!text) return;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  app.readerSelection = {
    text,
    page: app.readerPage,
    entryRef: currentEntryForPage(app.readerPage)?.id || "",
  };
  const tools = document.querySelector("#selectionTools");
  if (!tools) return;
  tools.hidden = false;
  tools.style.left = `${Math.max(12, rect.left + window.scrollX - layer.getBoundingClientRect().left)}px`;
  tools.style.top = `${Math.max(12, rect.top + window.scrollY - layer.getBoundingClientRect().top - 46)}px`;
  tools.innerHTML = `
    <button class="small primary" data-action="ai-explain-selection" data-mode="word">解释词句</button>
    <button class="small" data-action="ai-explain-selection" data-mode="grammar">识别语法</button>
    <button class="small" data-action="ai-save-selection">收藏</button>
  `;
}

async function explainReaderSelection(mode) {
  if (!app.readerSelection?.text) return;
  app.aiPanel = { status: "loading", message: "", result: null };
  render();
  try {
    const context = await collectReaderContext();
    const payload = await aiFetch("/api/deepseek/explain", { mode, ...context });
    app.aiPanel = { status: "done", message: "", result: payload.explanation };
    saveState();
    render();
  } catch (error) {
    app.aiPanel = { status: "error", message: error.message, result: null };
    render();
  }
}

async function saveReaderSelection() {
  if (!app.readerSelection?.text) return;
  const result = app.aiPanel.result || {};
  const item = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: guessNotebookType(app.readerSelection.text, result),
    text: app.readerSelection.text,
    reading: result.reading || "",
    meaning: result.meaning || result.reviewSuggestion || "",
    grammarRefs: uniqueRefs([app.readerSelection.entryRef, ...(result.grammarPoints || []).map((point) => point.name)].filter(Boolean)),
    sourcePage: app.readerSelection.page,
    sourceEntryRef: app.readerSelection.entryRef,
    nextReviewDate: addDays(todayIso(), 1),
    ease: 1,
    lapses: 0,
    createdAt: new Date().toISOString(),
    reviewSuggestion: result.reviewSuggestion || "",
  };
  app.state.aiNotebook.unshift(item);
  app.aiPanel.message = "已收藏，明天开始进入 AI 生词/例句复习。";
  saveState();
  render();
}

function guessNotebookType(text, result) {
  if ((result.grammarPoints || []).length) return "grammar";
  if (/[。！？]/.test(text) || text.length > 18) return "sentence";
  return "word";
}

async function collectReaderContext() {
  const selectedText = app.readerSelection?.text || "";
  const currentEntry = currentEntryForPage(app.readerSelection?.page || app.readerPage);
  const pageText = await getPageText(app.readerPage);
  const before = app.readerPage > 1 ? await getPageText(app.readerPage - 1) : "";
  const after = app.readerPage < (app.state.pdf.pages || 965) ? await getPageText(app.readerPage + 1) : "";
  const entryContext = currentEntry ? await getEntryText(currentEntry) : pageText;
  return {
    selectedText,
    currentEntry,
    pageText,
    nearbyContext: [before, after].filter(Boolean).join("\n"),
    entryContext,
  };
}

function currentEntryForPage(page) {
  const entries = app.state.catalog
    .filter((entry) => entry.page && entry.page <= page)
    .sort((a, b) => b.page - a.page || LEVEL_ORDER.indexOf(b.level) - LEVEL_ORDER.indexOf(a.level));
  return entries[0] || null;
}

function ensurePdfIndexStarted() {
  if (app.state.pdfIndexMeta?.fingerprint || pdfIndexPromise) return;
  pdfIndexPromise = buildPdfIndex(false).finally(() => {
    pdfIndexPromise = null;
  });
}

async function buildPdfIndex(force) {
  const status = document.querySelector("#pdfIndexStatus");
  const pdf = await getPdfDoc();
  const fingerprint = `${app.state.pdf.fileName}:${pdf.numPages}:${app.state.catalog.length}`;
  const db = await openPdfIndexDb();
  const existing = await idbGet(db, "meta", PDF_INDEX_META_KEY);
  if (!force && existing?.fingerprint === fingerprint) {
    app.state.pdfIndexMeta = existing;
    saveState();
    return existing;
  }
  if (status) status.textContent = "正在抽取 PDF 全书文本索引...";
  await idbClear(db, "pages");
  await idbClear(db, "entries");

  const pageTexts = new Map();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const extracted = await extractPageText(pdf, pageNumber);
    pageTexts.set(pageNumber, extracted.text);
    await idbPut(db, "pages", { page: pageNumber, ...extracted });
    if (status && pageNumber % 10 === 0) status.textContent = `正在索引 PDF：${pageNumber}/${pdf.numPages} 页`;
  }

  const sorted = app.state.catalog.filter((entry) => entry.page).sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.number - b.number);
  for (let index = 0; index < sorted.length; index += 1) {
    const entry = sorted[index];
    const next = sorted.slice(index + 1).find((item) => item.level === entry.level && item.page);
    const endPage = Math.max(entry.page, Math.min(next ? next.page - 1 : entry.page + 2, pdf.numPages));
    const text = range(entry.page, endPage).map((page) => pageTexts.get(page) || "").join("\n");
    await idbPut(db, "entries", { entryRef: entryRef(entry), startPage: entry.page, endPage, text });
  }

  const meta = { key: PDF_INDEX_META_KEY, fingerprint, pages: pdf.numPages, completedPages: pdf.numPages, indexedAt: new Date().toISOString() };
  await idbPut(db, "meta", meta);
  app.state.pdfIndexMeta = meta;
  saveState();
  if (status) status.textContent = `索引完成：${pdf.numPages} 页`;
  render();
  return meta;
}

async function extractPageText(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();
  const blocks = textContent.items
    .filter((item) => item.str && item.str.trim())
    .map((item) => ({ text: item.str, x: Math.round(item.transform[4]), y: Math.round(item.transform[5]) }));
  return {
    text: blocks.map((block) => block.text).join(" ").replace(/\s+/g, " ").trim(),
    blocks,
  };
}

async function getPageText(pageNumber) {
  const db = await openPdfIndexDb();
  const stored = await idbGet(db, "pages", pageNumber);
  if (stored?.text) return stored.text;
  if (pageNumber === app.readerPage && app.currentPageText) return app.currentPageText;
  const pdf = await getPdfDoc();
  const extracted = await extractPageText(pdf, pageNumber);
  await idbPut(db, "pages", { page: pageNumber, ...extracted });
  return extracted.text;
}

async function getEntryText(entry) {
  const db = await openPdfIndexDb();
  const stored = await idbGet(db, "entries", entryRef(entry));
  if (stored?.text) return stored.text;
  const pdf = await getPdfDoc();
  const peers = app.state.catalog.filter((item) => item.level === entry.level && item.page && item.number > entry.number).sort((a, b) => a.number - b.number);
  const endPage = Math.max(entry.page || app.readerPage, Math.min(peers[0]?.page ? peers[0].page - 1 : (entry.page || app.readerPage) + 2, pdf.numPages));
  const pages = [];
  for (let page = entry.page || app.readerPage; page <= endPage; page += 1) pages.push(await getPageText(page));
  const text = pages.join("\n");
  await idbPut(db, "entries", { entryRef: entryRef(entry), startPage: entry.page, endPage, text });
  return text;
}

function openPdfIndexDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PDF_INDEX_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("pages")) db.createObjectStore("pages", { keyPath: "page" });
      if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "entryRef" });
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, store, key) {
  return idbRequest(db.transaction(store, "readonly").objectStore(store).get(key));
}

function idbPut(db, store, value) {
  return idbRequest(db.transaction(store, "readwrite").objectStore(store).put(value));
}

function idbClear(db, store) {
  return idbRequest(db.transaction(store, "readwrite").objectStore(store).clear());
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function buildPlan(catalog) {
  const dates = dateRange(START_DATE, END_DATE);
  const phaseDates = splitPhaseDates(dates);
  const chunksByDate = {};
  for (const level of LEVEL_ORDER) {
    const entries = catalog.filter((entry) => entry.level === level).sort((a, b) => a.number - b.number);
    const chunks = chunkEntries(entries, phaseDates[level].length);
    phaseDates[level].forEach((date, index) => {
      if (chunks[index] && chunks[index].length) {
        chunksByDate[date] = chunksByDate[date] || [];
        chunksByDate[date].push({ level, entries: chunks[index] });
      }
    });
  }
  return { dates, phaseDates, chunksByDate };
}

function splitPhaseDates(dates) {
  const result = { N4: [], N3: [], N2: [], review: [] };
  const durations = { N4: 10, N3: 18, N2: 24 };
  let cursor = 0;
  for (const level of LEVEL_ORDER) {
    result[level] = dates.slice(cursor, cursor + durations[level]);
    cursor += durations[level];
  }
  result.review = dates.slice(cursor);
  return result;
}

function chunkEntries(entries, dayCount) {
  if (!dayCount) return [];
  const size = Math.max(1, Math.ceil(entries.length / dayCount));
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  while (chunks.length < dayCount) chunks.push([]);
  return chunks;
}

function tasksForDate(date, plan) {
  if (plan.tasksByDate) return plan.tasksByDate[date] || [];
  return baseTasksForDate(date, plan);
}

function baseTasksForDate(date, plan) {
  const tasks = [];

  for (const chunk of plan.chunksByDate[date] || []) {
    tasks.push(grammarTask(date, "new", chunk.entries));
  }

  for (const sourceDate of [addDays(date, -1), addDays(date, -4)]) {
    for (const chunk of plan.chunksByDate[sourceDate] || []) {
      tasks.push(grammarTask(date, "review", chunk.entries, sourceDate));
    }
  }

  const level = phaseLevel(date);
  tasks.push(vocabTask(date, level, vocabCountForDate(date)));
  tasks.push(readingTask(date));
  tasks.push(listeningTask(date));
  tasks.push(aiReviewTask(date));
  if (date >= "2026-06-21") {
    tasks.push(mockTask(date));
  }
  return tasks.filter(Boolean).map((task) => decorateBaseTask(task, date));
}

function buildRollingPlan(basePlan, statuses = {}, settings = {}, today = todayIso()) {
  const currentDate = clampDate(today, START_DATE, END_DATE);
  const dailyLimit = Number(settings.dailyMinutes) || 240;
  const tasksByDate = {};
  const candidates = [];
  const backlogItems = [];
  let order = 0;

  for (const date of basePlan.dates) {
    const baseTasks = baseTasksForDate(date, basePlan);
    tasksByDate[date] = date < currentDate ? baseTasks.slice() : [];

    for (const task of baseTasks) {
      const record = statusForId(task.id, statuses);
      const isDone = record.status === "done";
      const isExplicitBacklog = record.status === "partial" || record.status === "skipped";
      const isPastTodo = date < currentDate && record.status === "todo";
      const canRoll = shouldRollTask(task, date, statuses, currentDate);

      if (date >= currentDate && isDone) {
        tasksByDate[date].push(task);
        continue;
      }

      if (date >= currentDate && isExplicitBacklog) {
        tasksByDate[date].push(task);
      }

      if (canRoll && (isPastTodo || (date <= currentDate && isExplicitBacklog))) {
        const candidate = rolloverCandidate(task, date, record, currentDate, order);
        candidates.push(candidate);
        backlogItems.push(candidate);
        order += 1;
        continue;
      }

      if (date >= currentDate && !isDone && !isExplicitBacklog && canRoll) {
        candidates.push(baseCandidate(task, date, order));
        order += 1;
      }
    }
  }

  const queue = candidates.sort(compareCandidates);
  for (const date of dateRange(currentDate, END_DATE)) {
    let used = tasksByDate[date].reduce((sum, task) => sum + capacityMinutes(task, statuses), 0);
    let available = dailyLimit - used;

    while (available > 0) {
      const nextIndex = queue.findIndex((candidate) => candidate.earliestDate <= date && candidate.remainingMinutes <= available);
      if (nextIndex === -1) break;
      const [candidate] = queue.splice(nextIndex, 1);
      const scheduledTask = materializeCandidate(candidate, date);
      tasksByDate[date].push(scheduledTask);
      used += scheduledTask.remainingMinutes;
      available = dailyLimit - used;
    }
  }

  for (const date of basePlan.dates) {
    tasksByDate[date] = (tasksByDate[date] || []).sort(compareScheduledTasks);
  }

  const unscheduled = queue.filter((candidate) => candidate.earliestDate <= END_DATE);
  const scheduledBacklogTasks = Object.values(tasksByDate)
    .flat()
    .filter((task) => task.adjustmentKind === "backlog");
  const todayAdjustedTasks = tasksByDate[currentDate].filter((task) => task.adjustmentKind === "backlog");
  const futureAdjustedTasks = scheduledBacklogTasks.filter((task) => task.scheduledDate > currentDate);
  const totalBacklogMinutes = backlogItems.reduce((sum, candidate) => sum + candidate.remainingMinutes, 0);
  const scheduledBacklogMinutes = scheduledBacklogTasks.reduce((sum, task) => sum + task.remainingMinutes, 0);
  const gapMinutes = unscheduled.reduce((sum, candidate) => sum + candidate.remainingMinutes, 0);

  return {
    ...basePlan,
    tasksByDate,
    rolling: {
      today: currentDate,
      dailyLimit,
      backlogItems,
      totalBacklogMinutes,
      scheduledBacklogMinutes,
      todayAddedMinutes: todayAdjustedTasks.reduce((sum, task) => sum + task.remainingMinutes, 0),
      todayAddedCount: todayAdjustedTasks.length,
      futureAddedCount: futureAdjustedTasks.length,
      unscheduled,
      capacityWarning: gapMinutes > 0 ? { gapMinutes, taskCount: unscheduled.length } : null,
    },
  };
}

function grammarTask(date, mode, entries, sourceDate = null) {
  const refs = entries.map(entryRef);
  const labelMap = {
    new: `新学 ${entryRangeLabel(entries)}`,
    review: `复盘 ${entryRangeLabel(entries)}`,
    carryover: `补做 ${entryRangeLabel(entries)}`,
  };
  const minutes = mode === "new"
    ? entries.reduce((sum, entry) => sum + grammarMinutes(entry.level), 0)
    : Math.min(32, Math.max(12, entries.length * 2));
  return {
    id: `grammar-${mode}-${date}-${sourceDate || "today"}-${hashRefs(refs)}`,
    type: "grammar",
    mode,
    modeLabel: mode === "new" ? "新学" : mode === "review" ? "复盘" : "补做",
    kindLabel: "文法",
    label: labelMap[mode],
    detail: mode === "new" ? "读蓝宝书解释和例句，遮住中文回忆接续，至少口头造 2 句。" : "遮住解释复述用法，重新读例句，低信心条目标注到复盘池。",
    estimatedMinutes: minutes,
    entryRefs: refs,
    sourceDate,
  };
}

function decorateBaseTask(task, date) {
  return {
    ...task,
    baseDate: task.baseDate || date,
    scheduledDate: task.scheduledDate || date,
    remainingMinutes: task.remainingMinutes || task.estimatedMinutes,
    priority: task.priority || taskPriority(task, false),
  };
}

function baseCandidate(task, date, order) {
  return {
    sourceTask: task,
    baseDate: date,
    earliestDate: date,
    remainingMinutes: task.estimatedMinutes,
    priority: taskPriority(task, false),
    order,
    kind: "base",
  };
}

function rolloverCandidate(task, date, record, currentDate, order) {
  const remainingMinutes = record.status === "partial" ? Math.ceil(task.estimatedMinutes * 0.5) : task.estimatedMinutes;
  return {
    sourceTask: task,
    baseDate: date,
    earliestDate: currentDate,
    remainingMinutes,
    priority: taskPriority(task, true),
    order,
    kind: "rollover",
    status: record.status,
  };
}

function materializeCandidate(candidate, scheduledDate) {
  if (candidate.kind === "rollover") {
    return materializeRollover(candidate, scheduledDate);
  }
  const task = {
    ...candidate.sourceTask,
    scheduledDate,
    baseDate: candidate.baseDate,
    remainingMinutes: candidate.remainingMinutes,
    priority: candidate.priority,
  };
  if (scheduledDate === candidate.baseDate) return task;
  return {
    ...task,
    id: `rescheduled-${scheduledDate}-${task.id}`,
    label: `顺延 ${task.label}`,
    detail: `原计划 ${formatDate(candidate.baseDate)}；因积压和每日上限滚动到这一天。${task.detail}`,
    rolloverReason: "容量顺延",
    adjustmentKind: "rescheduled",
    sourceTaskIds: uniqueRefs([task.id, ...(task.sourceTaskIds || [])]),
  };
}

function materializeRollover(candidate, scheduledDate) {
  const source = candidate.sourceTask;
  const reason = candidate.status === "partial" ? "部分补做" : candidate.status === "skipped" ? "跳过补做" : "逾期补做";
  return {
    ...source,
    id: `rollover-${scheduledDate}-${source.id}`,
    mode: source.type === "grammar" ? "carryover" : source.mode,
    modeLabel: "补做",
    label: `补做 ${source.label.replace(/^(新学|复盘|补做|顺延)\s*/, "")}`,
    detail: `${formatDate(candidate.baseDate)} 的${statusLabel(candidate.status)}任务；本次按 ${candidate.remainingMinutes} 分钟安排。${source.detail}`,
    estimatedMinutes: candidate.remainingMinutes,
    remainingMinutes: candidate.remainingMinutes,
    baseDate: candidate.baseDate,
    scheduledDate,
    rolloverReason: reason,
    adjustmentKind: "backlog",
    priority: candidate.priority,
    sourceTaskIds: uniqueRefs([source.id, ...(source.sourceTaskIds || [])]),
  };
}

function taskPriority(task, isRollover) {
  if (isRollover && task.type === "grammar") return 10;
  if (task.type === "grammar" && task.mode === "new") return 20;
  if (task.type === "grammar" && task.mode === "review") return 25;
  if (isRollover && (task.type === "reading" || task.type === "listening")) return 30;
  if (task.type === "reading" || task.type === "listening") return 40;
  if (task.type === "ai-review") return 45;
  if (task.type === "vocab") return 50;
  if (task.type === "mock") return 60;
  return 70;
}

function compareCandidates(a, b) {
  return a.priority - b.priority || a.baseDate.localeCompare(b.baseDate) || a.order - b.order;
}

function compareScheduledTasks(a, b) {
  return (a.priority || 99) - (b.priority || 99) || (a.baseDate || "").localeCompare(b.baseDate || "") || a.id.localeCompare(b.id);
}

function capacityMinutes(task, statuses) {
  const record = statusForId(task.id, statuses);
  if (record.status === "done") return 0;
  if (!task.rolloverReason && (record.status === "partial" || record.status === "skipped")) return 0;
  return task.remainingMinutes || task.estimatedMinutes || 0;
}

function displayMinutes(task) {
  return capacityMinutes(task, app.state.statuses);
}

function shouldRollTask(task, date, statuses, today) {
  if (task.type !== "grammar" || task.mode !== "review" || !task.sourceDate) return true;
  if (task.sourceDate >= today) return true;
  const sourceId = `grammar-new-${task.sourceDate}-today-${hashRefs(task.entryRefs || [])}`;
  return statusForId(sourceId, statuses).status === "done";
}

function vocabTask(date, level, count) {
  return {
    id: `vocab-${date}-${level}-${count}`,
    type: "vocab",
    kindLabel: "词汇",
    label: `${level} 词汇：背 ${count} 个`,
    detail: "在你的背词 app 中完成新词/复习；这里不显示词单，只记录数量和完成状态。",
    estimatedMinutes: 32,
    vocabCount: count,
    items: [`新词/复习合计 ${count} 个`, "在背词 app 完成", "低熟词留到背词 app 复习队列"],
  };
}

function readingTask(date) {
  const source = pastPaperSource(date, 0);
  const section = READING_SECTIONS[dateIndex(date) % READING_SECTIONS.length];
  return {
    id: `reading-${date}-${source.level}-${source.year}-${section}`,
    type: "reading",
    kindLabel: "阅读",
    label: `${source.level} ${source.year} 年真题阅读：${section}`,
    detail: `资料在 MOJi Test。点击按钮打开网页端，进入试卷库/真题 → ${source.level} → ${source.year} 年，完成阅读「${section}」板块并记录错因。`,
    estimatedMinutes: source.level === "N2" ? 36 : 30,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: ["MOJi Test", `${source.level} ${source.year}`, `阅读 ${section}`, "限时完成", "错因：词汇/句型/定位/推理"],
  };
}

function listeningTask(date) {
  const source = pastPaperSource(date, 0);
  const section = LISTENING_SECTIONS[(dateIndex(date) + 1) % LISTENING_SECTIONS.length];
  return {
    id: `listening-${date}-${source.level}-${source.year}-${section}`,
    type: "listening",
    kindLabel: "听力",
    label: `${source.level} ${source.year} 年真题听力：${section}`,
    detail: `资料在 MOJi Test。点击按钮打开网页端，进入试卷库/真题 → ${source.level} → ${source.year} 年，完成听力「${section}」板块；错题只重听关键句。`,
    estimatedMinutes: source.level === "N2" ? 32 : 26,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: ["MOJi Test", `${source.level} ${source.year}`, `听力 ${section}`, "第一遍答题", "第二遍错题重听"],
  };
}

function aiReviewTask(date) {
  const reviewItems = dueAiReviewItems(date);
  if (!reviewItems.length) return null;
  return {
    id: `ai-review-${date}-${hashRefs(reviewItems.map((item) => item.id))}`,
    type: "ai-review",
    kindLabel: "AI复习",
    label: `AI 生词/例句复习：${reviewItems.length} 项`,
    detail: "复习你从 PDF 里收藏的词句，以及低分小测对应的语法点；完成后会自动滚到下一次复习。",
    estimatedMinutes: Math.min(25, Math.max(15, reviewItems.length * 3)),
    reviewItems,
    items: reviewItems.map((item) => item.label),
  };
}

function dueAiReviewItems(date) {
  const notebook = (app.state.aiNotebook || [])
    .filter((item) => !item.archived && (!item.nextReviewDate || item.nextReviewDate <= date))
    .map((item) => ({
      id: `note:${item.id}`,
      label: item.text,
      source: "notebook",
      itemId: item.id,
    }));
  const quizzes = Object.entries(app.state.quizResults || {})
    .filter(([, result]) => result.completedAt && result.score < 70 && (!result.nextReviewDate || result.nextReviewDate <= date) && !result.reviewedAt)
    .map(([key, result]) => ({
      id: `quiz:${key}`,
      label: `小测低分复盘 ${result.score} 分`,
      source: "quiz",
      itemId: key,
    }));
  return [...notebook, ...quizzes].slice(0, 10);
}

function mockTask(date) {
  const setNumber = Math.floor((dateIndex(date) - dateIndex("2026-06-21")) / 3) + 1;
  const isFull = dateIndex(date) % 3 === 0;
  const source = pastPaperSource(date, setNumber, "N2");
  return {
    id: `mock-${date}-${source.level}-${source.year}`,
    type: "mock",
    kindLabel: "模拟",
    label: isFull ? `MOJi Test ${source.level} ${source.year} 年真题套卷` : `MOJi Test ${source.level} ${source.year} 年弱项重刷`,
    detail: isFull
      ? "点击按钮打开 MOJi Test，按 N2 考试时间切块完成：语言知识/阅读 105 分钟，听力 50 分钟；记录三项分数和低于 19 分风险项。"
      : "点击按钮打开 MOJi Test，只重刷上一轮错得多的板块：阅读定位、听力关键词、或语言知识错题；不要开新资料。",
    estimatedMinutes: isFull ? 155 : 55,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: isFull ? ["MOJi Test", `${source.level} ${source.year}`, "语言知识/阅读", "听力", "记录分项分数"] : ["MOJi Test", `${source.level} ${source.year}`, "错题重做", "同题型加练"],
  };
}

function reviewItems(plan) {
  const today = clampDate(todayIso(), START_DATE, END_DATE);
  const orderedDates = [...dateRange(today, END_DATE), ...dateRange(START_DATE, addDays(today, -1))];
  const tasks = [];
  const seen = new Set();
  for (const date of orderedDates) {
    for (const task of tasksForDate(date, plan)) {
      const status = statusFor(task);
      const sourceKey = (task.sourceTaskIds && task.sourceTaskIds[0]) || task.id;
      if (seen.has(sourceKey)) continue;
      const lowConfidence = status.status === "done" && status.confidence && status.confidence <= 2;
      const backlog = task.rolloverReason && status.status !== "done";
      const missed = status.status === "partial" || status.status === "skipped" || (date < today && status.status === "todo");
      if (lowConfidence || backlog || missed) {
        seen.add(sourceKey);
        tasks.push({
          ...task,
          id: `review-pool-${task.id}`,
          sourceTaskIds: uniqueRefs([task.id, ...(task.sourceTaskIds || [])]),
          mode: task.type === "grammar" ? "review" : task.mode,
          modeLabel: lowConfidence ? "低信心" : "待补",
          label: `${lowConfidence ? "低信心复盘" : "补做"} ${task.label.replace(/^(新学|补做|顺延)\s*/, "")}`,
          detail: `${formatDate(task.baseDate || date)} 的任务。${task.type === "grammar" ? "先回忆接续和语义，再打开 PDF 核对。" : "按原资料补完并记录错因。"}`,
          estimatedMinutes: task.remainingMinutes || Math.min(36, Math.max(12, refsToEntries(task.entryRefs || []).length * 3)) || task.estimatedMinutes,
          remainingMinutes: task.remainingMinutes || task.estimatedMinutes,
          rolloverReason: lowConfidence ? "低信心" : task.rolloverReason || "待补",
        });
      }
    }
  }
  return tasks.slice(0, 40);
}

function phaseLevel(date) {
  if (date < "2026-05-11") return "N4";
  if (date < "2026-05-29") return "N3";
  return "N2";
}

function phaseLabel(date) {
  if (date < "2026-05-11") return "N4 快速补底";
  if (date < "2026-05-29") return "N3 桥接";
  if (date < "2026-06-21") return "N2 核心文法";
  if (date < "2026-07-01") return "真题型与弱项修补";
  return "考前总复盘";
}

function grammarMinutes(level) {
  return { N4: 8, N3: 10, N2: 13 }[level] || 10;
}

function vocabCountForDate(date) {
  const level = phaseLevel(date);
  if (level === "N4") return 25;
  if (level === "N3") return 35;
  if (date >= "2026-06-21") return 45;
  return 40;
}

function vocabCountForTasks(tasks) {
  return tasks
    .filter((task) => task.type === "vocab" && statusFor(task).status !== "done")
    .reduce((sum, task) => sum + (task.vocabCount || 0), 0);
}

function pastPaperSource(date, offset = 0, forcedLevel = null) {
  const level = forcedLevel || (date < "2026-05-29" ? "N3" : "N2");
  const years = PAST_PAPER_YEARS[level];
  const index = (dateIndex(date) + offset) % years.length;
  return { level, year: years[index] };
}

function refsToEntries(refs) {
  const byId = new Map(app.state.catalog.map((entry) => [entryRef(entry), entry]));
  return refs.map((ref) => byId.get(ref)).filter(Boolean);
}

function entryRef(entry) {
  return `${entry.level}-${entry.number}`;
}

function uniqueRefs(refs) {
  return Array.from(new Set(refs));
}

function entryRangeLabel(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.level)) groups.set(entry.level, []);
    groups.get(entry.level).push(entry.number);
  }
  return Array.from(groups.entries())
    .map(([level, numbers]) => {
      const sorted = numbers.slice().sort((a, b) => a - b);
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return `${level} 蓝宝书第 ${first}${last !== first ? `-${last}` : ""} 条`;
    })
    .join("、");
}

function hashRefs(refs) {
  let hash = 0;
  const value = refs.join("|");
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function setTaskStatus(taskId, status) {
  const task = taskRegistry.get(taskId);
  if (status === "todo") {
    delete app.state.statuses[taskId];
  } else {
    app.state.statuses[taskId] = {
      ...app.state.statuses[taskId],
      status,
      updatedAt: new Date().toISOString(),
    };
  }
  if (task?.sourceTaskIds?.length) {
    for (const sourceTaskId of task.sourceTaskIds) {
      if (status === "todo") {
        delete app.state.statuses[sourceTaskId];
      } else {
        app.state.statuses[sourceTaskId] = {
          ...app.state.statuses[sourceTaskId],
          status,
          updatedAt: new Date().toISOString(),
        };
      }
    }
  }
  if (status === "done" && task?.type === "ai-review") {
    completeAiReviewTask(task);
  }
  saveState();
  render();
}

function setTaskConfidence(taskId, confidence) {
  const task = taskRegistry.get(taskId);
  app.state.statuses[taskId] = {
    ...app.state.statuses[taskId],
    status: app.state.statuses[taskId]?.status || "todo",
    confidence,
    updatedAt: new Date().toISOString(),
  };
  if (task?.sourceTaskIds?.length) {
    for (const sourceTaskId of task.sourceTaskIds) {
      app.state.statuses[sourceTaskId] = {
        ...app.state.statuses[sourceTaskId],
        status: app.state.statuses[sourceTaskId]?.status || "todo",
        confidence,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  saveState();
  render();
}

function statusFor(task) {
  return statusForId(task.id, app.state.statuses);
}

function statusForId(taskId, statuses) {
  return { status: "todo", confidence: null, ...((statuses || {})[taskId] || {}) };
}

function completeAiReviewTask(task) {
  const today = todayIso();
  for (const item of task.reviewItems || []) {
    if (item.source === "notebook") {
      const note = app.state.aiNotebook.find((record) => record.id === item.itemId);
      if (!note) continue;
      note.ease = Math.min(6, Number(note.ease || 1) + 1);
      note.nextReviewDate = addDays(today, reviewInterval(note.ease));
      note.lastReviewedAt = new Date().toISOString();
    }
    if (item.source === "quiz") {
      const result = app.state.quizResults[item.itemId];
      if (!result) continue;
      result.reviewedAt = new Date().toISOString();
      result.nextReviewDate = addDays(today, 3);
    }
  }
}

function reviewInterval(ease) {
  return [1, 2, 4, 7, 14, 30][Math.max(0, Math.min(5, Number(ease || 1) - 1))];
}

async function generateQuiz(taskId) {
  const task = taskRegistry.get(taskId);
  if (!task) return;
  const key = quizKeyForTask(task);
  app.state.quizCache[key] = { status: "loading", title: "正在生成小测", questions: [] };
  saveState();
  render();
  try {
    const entries = refsToEntries(task.entryRefs || []);
    const entryContext = await contextForEntries(entries);
    const payload = await aiFetch("/api/deepseek/quiz", {
      date: app.selectedDate,
      taskLabel: task.label,
      entries: entries.map((entry) => ({ ref: entryRef(entry), level: entry.level, number: entry.number, title: entry.title })),
      entryContext,
    });
    app.state.quizCache[key] = {
      ...payload.quiz,
      status: "ready",
      createdAt: new Date().toISOString(),
      taskId: task.id,
      sourceTaskIds: task.sourceTaskIds || [],
      entryRefs: task.entryRefs || [],
    };
    app.state.quizResults[key] = app.state.quizResults[key] || { answers: {}, checked: {}, entryRefs: task.entryRefs || [] };
  } catch (error) {
    app.state.quizCache[key] = { status: "error", message: error.message, questions: [] };
  }
  saveState();
  render();
}

function answerQuizChoice(quizKey, questionId, value) {
  const quiz = app.state.quizCache[quizKey];
  const question = quiz?.questions?.find((item) => item.id === questionId);
  if (!question) return;
  const result = ensureQuizResult(quizKey, quiz);
  result.answers[questionId] = value;
  result.checked[questionId] = {
    correct: normalizeAnswer(value) === normalizeAnswer(question.answer),
    feedback: question.explanation || `正确答案：${question.answer}`,
    score: normalizeAnswer(value) === normalizeAnswer(question.answer) ? 100 : 0,
  };
  updateQuizScore(quizKey);
  saveState();
  render();
}

function checkQuizBlank(quizKey, questionId) {
  const quiz = app.state.quizCache[quizKey];
  const question = quiz?.questions?.find((item) => item.id === questionId);
  if (!question) return;
  const value = document.querySelector(`#${domId(`${quizKey}-${questionId}`)}`)?.value || "";
  const correct = normalizeAnswer(value) === normalizeAnswer(question.answer);
  const result = ensureQuizResult(quizKey, quiz);
  result.answers[questionId] = value;
  result.checked[questionId] = {
    correct,
    feedback: correct ? `正确。${question.explanation || ""}` : `参考答案：${question.answer}。${question.explanation || ""}`,
    score: correct ? 100 : 0,
  };
  updateQuizScore(quizKey);
  saveState();
  render();
}

async function gradeQuizSentence(quizKey, questionId) {
  const quiz = app.state.quizCache[quizKey];
  const question = quiz?.questions?.find((item) => item.id === questionId);
  if (!question) return;
  const value = document.querySelector(`#${domId(`${quizKey}-${questionId}`)}`)?.value || "";
  const result = ensureQuizResult(quizKey, quiz);
  result.answers[questionId] = value;
  result.checked[questionId] = { feedback: "AI 正在批改...", score: 0 };
  saveState();
  render();
  try {
    const entryContext = await contextForEntries(refsToEntries(quiz.entryRefs || []));
    const payload = await aiFetch("/api/deepseek/grade-sentence", {
      prompt: question.prompt,
      answer: value,
      grammarRef: question.grammarRef,
      entryContext,
    });
    result.checked[questionId] = {
      correct: Number(payload.grade.score || 0) >= 70,
      feedback: `${payload.grade.feedback || ""}${payload.grade.corrected ? ` 改写：${payload.grade.corrected}` : ""}`,
      score: Number(payload.grade.score || 0),
    };
  } catch (error) {
    result.checked[questionId] = { correct: false, feedback: error.message, score: 0 };
  }
  updateQuizScore(quizKey);
  saveState();
  render();
}

function ensureQuizResult(quizKey, quiz) {
  app.state.quizResults[quizKey] = app.state.quizResults[quizKey] || { answers: {}, checked: {}, entryRefs: quiz.entryRefs || [] };
  app.state.quizResults[quizKey].answers = app.state.quizResults[quizKey].answers || {};
  app.state.quizResults[quizKey].checked = app.state.quizResults[quizKey].checked || {};
  return app.state.quizResults[quizKey];
}

function updateQuizScore(quizKey) {
  const quiz = app.state.quizCache[quizKey];
  const result = app.state.quizResults[quizKey];
  if (!quiz || !result) return;
  const scores = (quiz.questions || []).map((question) => result.checked?.[question.id]?.score).filter((score) => typeof score === "number");
  result.score = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  if (scores.length === (quiz.questions || []).length) {
    result.completedAt = result.completedAt || new Date().toISOString();
    if (result.score < 70) result.nextReviewDate = result.nextReviewDate || addDays(todayIso(), 1);
  }
}

function quizKeyForTask(task) {
  const sourceId = task.sourceTaskIds?.[0] || task.id;
  return `${app.selectedDate}:${sourceId}`;
}

async function contextForEntries(entries) {
  const chunks = [];
  for (const entry of entries.slice(0, 12)) {
    const text = await getEntryText(entry);
    chunks.push(`## ${entryRef(entry)} ${entry.title}\n${text}`);
  }
  return chunks.join("\n\n");
}

async function aiFetch(path, payload) {
  const base = (app.state.settings.ai?.proxyUrl || AI_PROXY_DEFAULT).replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || data.error || `AI 代理错误 ${response.status}`);
  return data;
}

function normalizeAnswer(value) {
  return String(value || "").trim().replace(/[。．.]/g, "").replace(/\s+/g, "").toLowerCase();
}

function updateCatalogField(entryId, field, value) {
  const entry = app.state.catalog.find((item) => item.id === entryId);
  if (!entry) return;
  entry[field] = field === "page" ? Number(value || 0) : value;
  saveState();
}

function exportState() {
  const payload = JSON.stringify(app.state, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "bluebook-n2-agent-progress.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function importState() {
  const box = document.querySelector("#importBox");
  if (!box || !box.value.trim()) return;
  try {
    const imported = JSON.parse(box.value);
    if (Array.isArray(imported.catalog)) {
      app.state = { ...app.state, ...imported, pdf: { ...DEFAULT_PDF, ...(imported.pdf || app.state.pdf) } };
    } else {
      app.state = { ...app.state, catalog: imported };
    }
    saveState();
    render();
  } catch (error) {
    box.value = `JSON 解析失败：${error.message}`;
  }
}

function resetProgress() {
  app.state.statuses = {};
  app.state.notes = {};
  saveState();
  render();
}

function progressSummary(plan) {
  let total = 0;
  let done = 0;
  for (const date of plan.dates) {
    const tasks = tasksForDate(date, plan);
    total += tasks.length;
    done += tasks.filter((task) => statusFor(task).status === "done").length;
  }
  return { total, done };
}

function dateRange(start, end) {
  const dates = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function addDays(date, delta) {
  const value = parseIsoDate(date);
  value.setDate(value.getDate() + delta);
  return toIsoDate(value);
}

function parseIsoDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso() {
  return toIsoDate(new Date());
}

function clampDate(date, min, max) {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

function dateIndex(date) {
  return Math.round((parseIsoDate(date) - parseIsoDate(START_DATE)) / 86400000);
}

function daysUntil(target, from) {
  return Math.max(0, Math.round((parseIsoDate(target) - parseIsoDate(from)) / 86400000));
}

function formatDate(date) {
  const value = parseIsoDate(date);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
}

function formatShortDate(date) {
  const value = parseIsoDate(date);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(value);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function domId(value) {
  return `id-${hashRefs([String(value)])}`;
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(value) {
  return escapeAttr(value);
}
