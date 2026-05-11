import {
  AI_PROVIDERS,
  DEFAULT_AI_PROVIDER,
  providerDefaults,
  providerLabel as configuredProviderLabel,
} from "./ai-config.mjs";

const STORAGE_KEY = "bluebook-n2-agent-state-v1";
const SECRET_STORAGE_KEY = "bluebook-n2-agent-secrets-v1";
const STATE_VERSION = 4;
const START_DATE = "2026-05-01";
const END_DATE = "2026-07-04";
const EXAM_DATE = "2026-07-05";
const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
const REVIEW_INTERVALS = [1, 3, 7, 14, 30];
const CONTENT_SAVE_INTERVAL = 6;
const MINIMAX_DEFAULT_MODEL = AI_PROVIDERS.minimax.defaultModel;
const MINIMAX_DEFAULT_BASE_URL = AI_PROVIDERS.minimax.defaultBaseUrl;
const DEEPSEEK_DEFAULT_MODEL = AI_PROVIDERS.deepseek.defaultModel;
const DEEPSEEK_DEFAULT_BASE_URL = AI_PROVIDERS.deepseek.defaultBaseUrl;
const AI_PROMPT_VERSION = "grammar-ai-v2";
const AI_PRECACHE_EXAMPLE_LIMIT = 2;
const DEFAULT_CURRENT_LEVEL = "N4";
const DEFAULT_TARGET_LEVEL = "N2";
const DEFAULT_DAILY_MINUTES = 240;
const PAST_PAPER_YEARS = {
  N5: range(2010, 2024),
  N4: range(2010, 2024),
  N3: range(2010, 2024),
  N2: range(2010, 2025),
  N1: range(2010, 2025),
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

let pdfjsLib = null;
let pdfDoc = null;
let pdfRenderTask = null;
let extractionPromise = null;
let grammarSelectionTimer = null;
let aiPrecacheInFlight = new Map();
let taskRegistry = new Map();
let app = {
  view: "today",
  selectedDate: clampDate(todayIso(), START_DATE, END_DATE),
  readerPage: 1,
  readerTitle: "蓝宝书",
  catalogFilter: "N2",
  selectedGrammarRef: null,
  flashcardAnswerVisible: false,
  searchQuery: "",
  searchScope: "all",
  selectedExampleRef: null,
  selectedExampleIndex: null,
  selectedGrammarTarget: null,
  aiLoadingRef: null,
  aiMessage: "",
  onboardingMessage: "",
  userCenterMessage: "",
  secrets: loadSecrets(),
  scanMessage: "",
  state: loadState(),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindGlobalActions();
  render();
  if (!isOnboardingComplete()) return;
  if (!app.state.catalog.length || hasMissingCatalogLevels()) {
    scanCatalogFromPdf(true);
  } else if (hasMissingGrammarContent()) {
    ensureGrammarContent(false);
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    pdf: DEFAULT_PDF,
    catalog: [],
    statuses: {},
    notes: {},
    grammarProgress: {},
    grammarContent: {},
    aiExplanations: {},
    onboarding: defaultOnboarding(),
    extraction: {
      status: "idle",
      total: 0,
      done: 0,
      message: "",
      updatedAt: null,
    },
    settings: {
      dailyMinutes: DEFAULT_DAILY_MINUTES,
      grammarRange: "auto",
    },
  };
}

function defaultOnboarding() {
  return {
    currentLevel: DEFAULT_CURRENT_LEVEL,
    targetLevel: DEFAULT_TARGET_LEVEL,
    dailyMinutes: DEFAULT_DAILY_MINUTES,
    examDate: EXAM_DATE,
    startDate: todayIso(),
    completedAt: null,
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      return normalizeSavedState(saved);
    }
  } catch (error) {
    console.warn("Cannot parse saved state", error);
  }
  return defaultState();
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(app.state));
  } catch (error) {
    console.warn("Cannot save state", error);
  }
}

function loadSecrets() {
  try {
    const saved = JSON.parse(localStorage.getItem(SECRET_STORAGE_KEY) || "{}");
    return normalizeSecrets(saved);
  } catch (error) {
    console.warn("Cannot parse saved secrets", error);
  }
  return defaultSecrets();
}

function saveSecrets() {
  app.secrets = normalizeSecrets(app.secrets);
  localStorage.setItem(SECRET_STORAGE_KEY, JSON.stringify(app.secrets));
}

function defaultSecrets() {
  return {
    provider: DEFAULT_AI_PROVIDER,
    providers: {
      minimax: {
        apiKey: "",
        model: MINIMAX_DEFAULT_MODEL,
        baseUrl: MINIMAX_DEFAULT_BASE_URL,
      },
      deepseek: {
        apiKey: "",
        model: DEEPSEEK_DEFAULT_MODEL,
        baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
      },
    },
  };
}

function normalizeSecrets(saved = {}) {
  const base = defaultSecrets();
  const legacyModel = !saved.model || saved.model === "MiniMax-M2.7" ? MINIMAX_DEFAULT_MODEL : saved.model;
  const providers = {
    minimax: {
      ...base.providers.minimax,
      ...(saved.providers?.minimax || {}),
    },
    deepseek: {
      ...base.providers.deepseek,
      ...(saved.providers?.deepseek || {}),
    },
  };
  if (saved.apiKey || saved.model || saved.baseUrl) {
    providers.minimax = {
      ...providers.minimax,
      apiKey: saved.apiKey || providers.minimax.apiKey,
      model: legacyModel || providers.minimax.model,
      baseUrl: saved.baseUrl || providers.minimax.baseUrl,
    };
  }
  const provider = ["minimax", "deepseek"].includes(saved.provider)
    ? saved.provider
    : providers.minimax.apiKey
      ? "minimax"
      : DEFAULT_AI_PROVIDER;
  return { provider, providers };
}

function normalizeSavedState(saved) {
  const base = defaultState();
  const state = {
    ...base,
    ...saved,
    version: STATE_VERSION,
    pdf: { ...DEFAULT_PDF, ...(saved.pdf || {}) },
    statuses: { ...(saved.statuses || {}) },
    notes: { ...(saved.notes || {}) },
    grammarProgress: { ...(saved.grammarProgress || {}) },
    grammarContent: { ...(saved.grammarContent || {}) },
    aiExplanations: { ...(saved.aiExplanations || {}) },
    onboarding: normalizeOnboarding(saved.onboarding, saved),
    extraction: { ...base.extraction, ...(saved.extraction || {}) },
    settings: { ...base.settings, ...(saved.settings || {}) },
  };
  state.settings.dailyMinutes = Number(state.onboarding.dailyMinutes) || state.settings.dailyMinutes || DEFAULT_DAILY_MINUTES;
  if ((saved.version || 1) < 3) {
    migrateLegacyGrammarProgress(state, saved);
  }
  return state;
}

function normalizeOnboarding(onboarding, saved = {}) {
  const base = defaultOnboarding();
  const existingStudy = Boolean(
    saved.version
    || (saved.catalog && saved.catalog.length)
    || Object.keys(saved.statuses || {}).length
    || Object.keys(saved.grammarProgress || {}).length
  );
  const candidate = {
    ...base,
    ...(onboarding || {}),
  };
  candidate.currentLevel = LEVEL_ORDER.includes(candidate.currentLevel) ? candidate.currentLevel : DEFAULT_CURRENT_LEVEL;
  candidate.targetLevel = LEVEL_ORDER.includes(candidate.targetLevel) ? candidate.targetLevel : DEFAULT_TARGET_LEVEL;
  if (levelIndex(candidate.targetLevel) < levelIndex(candidate.currentLevel)) {
    candidate.targetLevel = candidate.currentLevel;
  }
  candidate.dailyMinutes = clampNumber(candidate.dailyMinutes, 45, 480);
  candidate.examDate = candidate.examDate || EXAM_DATE;
  candidate.startDate = candidate.startDate || todayIso();
  if (!candidate.completedAt && existingStudy && !onboarding) {
    candidate.startDate = START_DATE;
    candidate.completedAt = new Date().toISOString();
    candidate.migratedFromLegacy = true;
  }
  return candidate;
}

function isOnboardingComplete() {
  return Boolean(app.state.onboarding?.completedAt);
}

function studyProfile() {
  return normalizeOnboarding(app.state.onboarding || defaultOnboarding(), { onboarding: app.state.onboarding });
}

function levelIndex(level) {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? LEVEL_ORDER.indexOf(DEFAULT_TARGET_LEVEL) : index;
}

function diagnosticLevelsForProfile(profile = studyProfile()) {
  const targetIndex = levelIndex(profile.targetLevel);
  const currentIndex = Math.min(levelIndex(profile.currentLevel), targetIndex);
  return LEVEL_ORDER.slice(0, currentIndex + 1).filter((level) => levelIndex(level) <= targetIndex);
}

function mainLevelsForProfile(profile = studyProfile()) {
  const targetIndex = levelIndex(profile.targetLevel);
  const currentIndex = Math.min(levelIndex(profile.currentLevel), targetIndex);
  const levels = LEVEL_ORDER.slice(currentIndex + 1, targetIndex + 1);
  return levels.length ? levels : [profile.targetLevel];
}

function allPlanLevelsForProfile(profile = studyProfile()) {
  return uniqueRefs([...diagnosticLevelsForProfile(profile), ...mainLevelsForProfile(profile)]);
}

function updateOnboardingField(field, value, shouldRender = true) {
  app.state.onboarding = {
    ...defaultOnboarding(),
    ...(app.state.onboarding || {}),
    [field]: field === "dailyMinutes" ? Number(value || DEFAULT_DAILY_MINUTES) : value,
  };
  app.onboardingMessage = "";
  if (shouldRender) render();
}

function saveOnboarding() {
  const draft = {
    ...defaultOnboarding(),
    ...(app.state.onboarding || {}),
  };
  draft.dailyMinutes = clampNumber(draft.dailyMinutes, 45, 480);
  if (levelIndex(draft.targetLevel) < levelIndex(draft.currentLevel)) {
    app.onboardingMessage = "目标水平不能低于目前水平。请重新选择目标级别。";
    render();
    return;
  }
  app.state.onboarding = {
    ...draft,
    startDate: todayIso(),
    completedAt: draft.completedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  app.state.settings = {
    ...app.state.settings,
    dailyMinutes: draft.dailyMinutes,
  };
  app.catalogFilter = draft.targetLevel;
  app.selectedDate = clampDate(todayIso(), app.state.onboarding.startDate, planEndDateForProfile(app.state.onboarding));
  app.view = "today";
  app.onboardingMessage = "";
  saveState();
  render();
  if (!app.state.catalog.length) scanCatalogFromPdf(true);
}

function migrateLegacyGrammarProgress(state, saved) {
  if (!state.catalog.length) return;
  const today = clampDate(todayIso(), START_DATE, END_DATE);
  const plan = buildPlan(state.catalog, state.onboarding);
  const legacyStatuses = saved.statuses || {};

  for (const date of plan.dates) {
    for (const task of legacyGrammarTasksForDate(date, plan)) {
      const record = legacyStatuses[task.id];
      if (record) {
        applyLegacyGrammarTaskProgress(state, task, record, date, today);
      }
    }

    if (date < today) {
      for (const chunk of plan.chunksByDate[date] || []) {
        for (const entry of chunk.entries) {
          setMigratedGrammarProgress(state, entryRef(entry), {
            status: "learning",
            reviewStage: 0,
            dueDate: today,
            lastReviewedAt: null,
            masteredAt: null,
            updatedAt: new Date().toISOString(),
          }, today);
        }
      }
    }
  }
}

function applyLegacyGrammarTaskProgress(state, task, record, date, today) {
  const now = new Date().toISOString();
  const lastReviewedDate = isoDateFromTimestamp(record.updatedAt) || date;
  for (const ref of task.entryRefs || []) {
    if (record.status === "done") {
      const lowConfidence = record.confidence && record.confidence <= 2;
      setMigratedGrammarProgress(state, ref, {
        status: "review",
        reviewStage: lowConfidence ? 0 : 1,
        dueDate: lowConfidence ? today : addDays(lastReviewedDate, REVIEW_INTERVALS[0]),
        lastReviewedAt: record.updatedAt || now,
        masteredAt: null,
        updatedAt: record.updatedAt || now,
      }, today);
      continue;
    }
    if (record.status === "partial" || record.status === "skipped") {
      setMigratedGrammarProgress(state, ref, {
        status: "learning",
        reviewStage: 0,
        dueDate: today,
        lastReviewedAt: null,
        masteredAt: null,
        updatedAt: record.updatedAt || now,
      }, today);
    }
  }
}

function setMigratedGrammarProgress(state, ref, candidate, today) {
  const existing = state.grammarProgress[ref];
  if (!existing || grammarMigrationWeight(candidate, today) >= grammarMigrationWeight(existing, today)) {
    state.grammarProgress[ref] = candidate;
  }
}

function grammarMigrationWeight(progress, today) {
  if (!progress) return 0;
  if (progress.status === "mastered") return 5;
  if (progress.status === "review" && (!progress.dueDate || progress.dueDate <= today)) return 4;
  if (progress.status === "review") return 3;
  if (progress.status === "learning") return 2;
  return 1;
}

function isoDateFromTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return toIsoDate(date);
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
    if (action === "save-onboarding") {
      saveOnboarding();
    }
    if (action === "edit-onboarding") {
      app.view = "onboarding";
      render();
    }
    if (action === "select-date") {
      app.selectedDate = target.dataset.date;
      app.view = "today";
      render();
    }
    if (action === "shift-date") {
      const plan = currentPlan();
      app.selectedDate = clampDate(addDays(app.selectedDate, Number(target.dataset.delta)), plan.dates[0] || START_DATE, plan.dates[plan.dates.length - 1] || END_DATE);
      render();
    }
    if (action === "today") {
      const plan = currentPlan();
      app.selectedDate = clampDate(todayIso(), plan.dates[0] || START_DATE, plan.dates[plan.dates.length - 1] || END_DATE);
      app.view = "today";
      render();
    }
    if (action === "scan-catalog") {
      scanCatalogFromPdf(false);
    }
    if (action === "extract-content") {
      ensureGrammarContent(true);
    }
    if (action === "open-reader") {
      openReader(Number(target.dataset.page || 1), target.dataset.title || "蓝宝书");
    }
    if (action === "open-grammar-card") {
      app.selectedGrammarRef = target.dataset.entryRef;
      app.flashcardAnswerVisible = true;
      if (target.dataset.view) app.view = target.dataset.view;
      render();
    }
    if (action === "start-grammar-study") {
      startGrammarSession("study");
    }
    if (action === "start-grammar-review") {
      startGrammarSession("review");
    }
    if (action === "toggle-answer") {
      app.flashcardAnswerVisible = !app.flashcardAnswerVisible;
      render();
    }
    if (action === "select-grammar-example") {
      scheduleGrammarTokenSelection(target, event);
    }
    if (action === "select-grammar-sentence") {
      selectGrammarSentence(target);
    }
    if (action === "remember-grammar") {
      rememberGrammarEntry(target.dataset.entryRef);
    }
    if (action === "forget-grammar") {
      forgetGrammarEntry(target.dataset.entryRef);
    }
    if (action === "complete-grammar") {
      completeGrammarEntry(target.dataset.entryRef);
    }
    if (action === "master-grammar") {
      masterGrammarEntry(target.dataset.entryRef);
    }
    if (action === "relearn-grammar") {
      relearnGrammarEntry(target.dataset.entryRef);
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
    if (action === "save-user-settings") {
      saveUserSettings();
    }
    if (action === "clear-api-key") {
      clearApiKey();
    }
    if (action === "test-ai-settings") {
      testAiSettings();
    }
    if (action === "set-ai-provider") {
      setAiProvider(target.dataset.provider);
    }
    if (action === "set-ai-base") {
      setAiBaseUrl(target.dataset.baseUrl);
    }
    if (action === "set-ai-model") {
      setAiModel(target.dataset.model);
    }
    if (action === "set-minimax-base") {
      setAiBaseUrl(target.dataset.baseUrl);
    }
    if (action === "refresh-ai-explanation") {
      refreshGrammarAi(target.dataset.entryRef);
    }
    if (action === "reader-prev") {
      openReader(Math.max(1, app.readerPage - 1), app.readerTitle);
    }
    if (action === "reader-next") {
      openReader(Math.min((pdfDoc && pdfDoc.numPages) || 965, app.readerPage + 1), app.readerTitle);
    }
  });

  document.addEventListener("change", (event) => {
    const target = event.target;
    if (target.matches("[data-catalog-field]")) {
      updateCatalogField(target.dataset.entryId, target.dataset.catalogField, target.value);
    }
    if (target.matches("[data-onboarding-field]")) {
      updateOnboardingField(target.dataset.onboardingField, target.value);
    }
    if (target.matches("[data-date-picker]")) {
      const plan = currentPlan();
      app.selectedDate = clampDate(target.value, plan.dates[0] || START_DATE, plan.dates[plan.dates.length - 1] || END_DATE);
      render();
    }
    if (target.matches("[data-catalog-filter]")) {
      app.catalogFilter = target.value;
      render();
    }
    if (target.matches("[data-search-scope]")) {
      app.searchScope = target.value;
      render();
    }
    if (target.matches("[data-reader-page]")) {
      openReader(Number(target.value || 1), app.readerTitle);
    }
  });

  document.addEventListener("input", (event) => {
    const target = event.target;
    if (target.matches("[data-secret-field]")) {
      updateCurrentAiConfig(target.dataset.secretField, target.value);
    }
    if (target.matches("[data-onboarding-field]")) {
      updateOnboardingField(target.dataset.onboardingField, target.value, false);
    }
    if (target.matches("[data-search-query]")) {
      app.searchQuery = target.value;
      const cursor = target.selectionStart;
      render();
      const input = document.querySelector("[data-search-query]");
      if (input) {
        input.focus();
        input.setSelectionRange(cursor, cursor);
      }
    }
  });

  document.addEventListener("dblclick", (event) => {
    const target = event.target.closest(".grammar-example[data-example-index][data-entry-ref]");
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    selectGrammarSentence(target);
  });
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
      app.scanMessage = "没有从 PDF 大纲中识别到 N5-N1 条目，请在目录校对页手动导入 JSON。";
      render();
      return;
    }
    app.state.catalog = entries;
    app.state.pdf = { ...DEFAULT_PDF, pages: pdf.numPages };
    app.state.grammarContent = {};
    saveState();
    app.scanMessage = `已识别 ${entries.length} 条文法：${LEVEL_ORDER.map((level) => `${level} ${countLevel(entries, level)} 条`).join("，")}。`;
    if (isAuto) app.view = "today";
    render();
    ensureGrammarContent(true);
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
      const nextLevel = /N[1-5]文法/.test(title) ? title.match(/N[1-5]/)[0] : level;
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

function hasMissingCatalogLevels() {
  if (!app.state.catalog.length) return true;
  const existing = new Set(app.state.catalog.map((entry) => entry.level));
  return LEVEL_ORDER.some((level) => !existing.has(level));
}

function render() {
  const root = document.querySelector("#app");
  const profile = studyProfile();
  const basePlan = buildPlan(app.state.catalog, profile);
  const plan = buildRollingPlan(basePlan, app.state.statuses, app.state.settings, todayIso());
  const progress = progressSummary(plan);
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const examDate = profile.examDate || EXAM_DATE;
  const daysLeft = daysUntil(examDate, clampDate(todayIso(), START_DATE, END_DATE));
  taskRegistry = new Map();
  root.innerHTML = `
    <main class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">${profile.targetLevel}</div>
          <div>
            <h1>JLPT 备考 Agent</h1>
            <p>${daysLeft} 天后考试 · ${formatDate(examDate)}</p>
          </div>
        </div>
        <nav class="nav">
          ${navButton("today", "今日计划")}
          ${navButton("calendar", "日历")}
          ${navButton("review", "复习池")}
          ${navButton("search", "搜索")}
          ${navButton("user", "用户中心")}
          ${navButton("catalog", "目录校对")}
          ${navButton("reader", "PDF 阅读器")}
        </nav>
        <div class="side-panel">
          <strong>备考进度 ${pct}%</strong>
          <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
          <p>${progress.done}/${progress.total} 个任务已完成，目标 ${profile.targetLevel}，每天 ${profile.dailyMinutes} 分钟，目录 ${app.state.catalog.length || 0} 条</p>
        </div>
        <div class="side-panel">
          <strong>滚动规则</strong>
          <p>文法卡片按 1/3/7/14/30 天复习；已掌握条目只进入掌握池；中文说明只原样显示和搜索</p>
        </div>
        ${renderExtractionPanel()}
        <div class="side-panel">
          <strong>真题来源</strong>
          <p>阅读和听力使用 MOJi Test：按目标级别安排真题和模拟。用 Chrome 打开本页可复用 Chrome 登录态</p>
        </div>
      </aside>
      <section class="content">
        ${!isOnboardingComplete() || app.view === "onboarding" ? renderOnboarding() : app.state.catalog.length ? renderView(plan) : renderSetup()}
      </section>
    </main>
  `;
  if (app.view === "reader" && app.state.catalog.length) {
    renderPdfPage(app.readerPage);
  }
  scheduleVisibleGrammarPrecache();
}

function navButton(view, label) {
  return `<button class="${app.view === view ? "active" : ""}" data-action="nav" data-view="${view}">${label}</button>`;
}

function renderView(plan) {
  if (app.view === "calendar") return renderCalendar(plan);
  if (app.view === "review") return renderReview(plan);
  if (app.view === "search") return renderSearch(plan);
  if (app.view === "user") return renderUserCenter();
  if (app.view === "grammar-study") return renderGrammarSession(plan, "study");
  if (app.view === "grammar-review") return renderGrammarSession(plan, "review");
  if (app.view === "catalog") return renderCatalog();
  if (app.view === "reader") return renderReader();
  return renderToday(plan);
}

function renderExtractionPanel() {
  const extraction = app.state.extraction || {};
  const total = extraction.status === "running" ? extraction.total || 0 : orderedGrammarEntries().length || 0;
  const done = extraction.status === "running" ? extraction.done || 0 : contentReadyCount();
  const pct = total ? Math.round((done / total) * 100) : 0;
  const label = extraction.status === "running"
    ? `提取中 ${done}/${total}`
    : extraction.status === "done"
      ? `已缓存 ${contentReadyCount()} 条`
      : extraction.status === "error"
        ? "提取失败"
        : `已缓存 ${contentReadyCount()} 条`;
  return `
    <div class="side-panel">
      <strong>文法文本</strong>
      <p>${label}${extraction.message ? `<br />${escapeHtml(extraction.message)}` : ""}</p>
      <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <button class="small ghost" data-action="extract-content">${extraction.status === "running" ? "继续提取" : "重新提取"}</button>
    </div>
  `;
}

function renderOnboarding() {
  const profile = studyProfile();
  const isEdit = Boolean(app.state.onboarding?.completedAt);
  const targetOptions = LEVEL_ORDER.map((level) => `<option value="${level}" ${profile.targetLevel === level ? "selected" : ""}>${level}</option>`).join("");
  const currentOptions = LEVEL_ORDER.map((level) => `<option value="${level}" ${profile.currentLevel === level ? "selected" : ""}>${level}</option>`).join("");
  return `
    <div class="topbar">
      <div>
        <h2>${isEdit ? "重新配置备考目标" : "配置你的 JLPT 备考计划"}</h2>
        <p>先确认当前水平、目标级别和每天可投入时间，系统会从蓝宝书 N5-N1 文法生成滚动计划。</p>
      </div>
      <div class="toolbar">
        ${isEdit ? `<button data-action="nav" data-view="today">返回今日</button>` : ""}
        <button class="primary" data-action="save-onboarding">${isEdit ? "保存配置" : "生成计划"}</button>
      </div>
    </div>
    <section class="panel onboarding-panel">
      <div class="panel-body">
        <div class="settings-grid onboarding-grid">
          <label class="setting-field">
            <span>目前水平</span>
            <select data-onboarding-field="currentLevel">${currentOptions}</select>
          </label>
          <label class="setting-field">
            <span>目标水平</span>
            <select data-onboarding-field="targetLevel">${targetOptions}</select>
          </label>
          <label class="setting-field">
            <span>每天备考时间（分钟）</span>
            <input type="number" min="45" max="480" step="15" value="${Number(profile.dailyMinutes) || DEFAULT_DAILY_MINUTES}" data-onboarding-field="dailyMinutes" />
          </label>
          <label class="setting-field">
            <span>目标考试日</span>
            <input type="date" value="${escapeAttr(profile.examDate || EXAM_DATE)}" data-onboarding-field="examDate" />
          </label>
        </div>
        <div class="onboarding-summary">
          ${stat("查漏复盘", diagnosticLevelsForProfile(profile).join(" / ") || "无")}
          ${stat("主学习路径", mainLevelsForProfile(profile).join(" / ") || profile.targetLevel)}
          ${stat("默认考试", formatDate(profile.examDate || EXAM_DATE))}
        </div>
        ${app.onboardingMessage ? `<div class="empty user-message">${escapeHtml(app.onboardingMessage)}</div>` : ""}
        <p class="source-note">当前水平表示这些级别大体学过；该级别及以下只做查漏复盘，目标路径会从下一阶段开始推进。</p>
      </div>
    </section>
  `;
}

function renderSetup() {
  return `
    <div class="topbar">
      <div>
        <h2>初始化蓝宝书目录</h2>
        <p>从本地 PDF 大纲识别 N5-N1 文法条目。</p>
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
  const grammarQueue = grammarQueueForDate(app.selectedDate, plan);
  const grammarStudyQueue = grammarLearningQueueForDate(app.selectedDate, plan);
  const totalMinutes = tasks.reduce((sum, task) => sum + displayMinutes(task), 0) + grammarStudyQueue.reduce((sum, item) => sum + grammarMinutes(item.entry.level), 0);
  const done = tasks.filter((task) => statusFor(task).status === "done").length;
  return `
    <div class="topbar">
      <div>
        <h2>${formatDate(app.selectedDate)} 计划</h2>
        <p>${phaseLabel(app.selectedDate, plan)}，预计 ${totalMinutes} 分钟。</p>
      </div>
      <div class="toolbar">
        <button data-action="shift-date" data-delta="-1">上一天</button>
        <input type="date" min="${plan.dates[0] || START_DATE}" max="${plan.dates[plan.dates.length - 1] || END_DATE}" value="${app.selectedDate}" data-date-picker />
        <button data-action="shift-date" data-delta="1">下一天</button>
        <button class="ghost" data-action="today">今天</button>
      </div>
    </div>
    <div class="layout">
      <section>
        <div class="stat-grid">
          ${stat("任务", `${done}/${tasks.length + grammarStudyQueue.length}`)}
          ${stat("文法", `${grammarStudyQueue.length} 张`)}
          ${stat("词汇", `${vocabCountForTasks(tasks)} 个`)}
          ${stat("剩余", `${daysUntil((plan.profile || studyProfile()).examDate || EXAM_DATE, app.selectedDate)} 天`)}
        </div>
        <div class="task-list">
          ${renderGrammarOverview(app.selectedDate, plan)}
          ${tasks.map(renderTask).join("") || `<div class="empty">这一天没有任务。</div>`}
        </div>
        ${renderRollingNotice(app.selectedDate, plan)}
      </section>
      <aside class="panel">
        <div class="panel-head">
          <h3>当天条目</h3>
          <p>今日卡片和原书页码。</p>
        </div>
        <div class="panel-body">
          ${renderDayOutline(grammarQueue, app.selectedDate, plan)}
        </div>
      </aside>
    </div>
  `;
}

function renderGrammarOverview(date, plan) {
  const summary = grammarSummaryForDate(date, plan);
  const rows = summary.studyQueue.length ? summary.studyQueue : plannedGrammarEntriesForDate(date, plan).map((entry) => ({
    entry,
    ref: entryRef(entry),
    reason: "已安排",
    queueKind: "planned",
    progress: grammarProgressFor(entryRef(entry)),
  }));
  return `
    <article class="task task-grammar grammar-overview">
      <div class="task-main">
        <div>
          <div class="task-title">
            <span class="pill level">文法</span>
            <h4>蓝宝书语法学习</h4>
          </div>
          <div class="task-meta">先从这里进入学习或复习页；首页只做今日内容总览，不直接展开抽认卡。</div>
          <div class="grammar-overview-stats">
            ${stat("新学", `${summary.newCount}`)}
            ${stat("补学", `${summary.learningCount}`)}
            ${stat("复习", `${summary.reviewCount}`)}
            ${stat("掌握", `${summary.masteredCount}`)}
          </div>
          <div class="grammar-mini-list">
            ${rows.slice(0, 12).map((item) => renderGrammarMiniRow(item)).join("") || `<div class="empty">今天没有语法学习内容。</div>`}
            ${rows.length > 12 ? `<div class="task-meta">还有 ${rows.length - 12} 条语法在待处理队列中。</div>` : ""}
          </div>
        </div>
        <div class="task-actions grammar-start-actions">
          <button class="primary small" data-action="start-grammar-study" ${summary.studyQueue.length ? "" : "disabled"}>开始学习</button>
          <button class="small" data-action="start-grammar-review" ${summary.reviewQueue.length ? "" : "disabled"}>开始复习</button>
        </div>
      </div>
    </article>
  `;
}

function renderGrammarMiniRow(item) {
  const entry = item.entry;
  const ref = item.ref || entryRef(entry);
  return `
    <div class="grammar-mini-row">
      <div>
        <span class="pill ${item.queueKind === "review" ? "warn" : item.queueKind === "learning" ? "bad" : "level"}">${item.reason}</span>
        <span class="pill">${entry.level} ${entry.number}</span>
        <span>${escapeHtml(entry.title)}</span>
      </div>
      <div class="task-actions">
        <button class="small" data-action="open-grammar-card" data-entry-ref="${ref}" data-view="search">查看</button>
        ${entry.page ? `<button class="small" data-action="open-reader" data-page="${entry.page}" data-title="${escapeAttr(`${entry.level} ${entry.number}. ${entry.title}`)}">PDF</button>` : ""}
      </div>
    </div>
  `;
}

function renderGrammarSession(plan, mode) {
  const isReview = mode === "review";
  const queue = isReview
    ? grammarReviewQueueForDate(app.selectedDate, plan)
    : grammarLearningQueueForDate(app.selectedDate, plan);
  const title = isReview ? "语法复习" : "语法学习";
  const description = isReview
    ? "复习只判断记得或忘了；忘了会回到学习池。"
    : "学习只处理已完成或已掌握；已完成会按遗忘曲线进入复习池。";

  if (!queue.length) {
    return `
      <div class="topbar">
        <div>
          <h2>${title}</h2>
          <p>${formatDate(app.selectedDate)} · 队列已清空。</p>
        </div>
        <div class="toolbar">
          ${isReview && grammarLearningQueueForDate(app.selectedDate, plan).length ? `<button class="primary" data-action="start-grammar-study">去学习池</button>` : ""}
          <button data-action="nav" data-view="today">返回今日</button>
        </div>
      </div>
      <section class="flashcard-panel">
        <div class="empty">${isReview ? "今天没有到期复习卡片。" : "今天没有待学习语法卡片。"}</div>
      </section>
    `;
  }

  const selectedRef = resolveSelectedGrammarRef(queue);
  const index = Math.max(0, queue.findIndex((item) => item.ref === selectedRef));
  const item = queue[index] || queue[0];
  return `
    <div class="topbar">
      <div>
        <h2>${title}</h2>
        <p>${formatDate(app.selectedDate)} · ${description}</p>
      </div>
      <div class="toolbar">
        <span class="pill">${index + 1}/${queue.length}</span>
        <button data-action="nav" data-view="today">返回今日</button>
      </div>
    </div>
    <section class="flashcard-panel">
      ${renderGrammarCard(item, { mode, countLabel: `${index + 1}/${queue.length}` })}
    </section>
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

function renderDayOutline(queue, date, plan) {
  const planned = plannedGrammarEntriesForDate(date, plan);
  if (!queue.length && !planned.length) return `<div class="empty">今天没有蓝宝书文法新条目。</div>`;
  const rows = queue.length ? queue : planned.map((entry) => ({
    entry,
    ref: entryRef(entry),
    reason: "已安排",
    queueKind: "planned",
    progress: grammarProgressFor(entryRef(entry)),
  }));
  return rows
    .slice(0, 18)
    .map((item) => `
      <div class="outline-entry">
        <div class="task-items" style="margin: 0 0 8px;">
          <span class="pill ${item.queueKind === "review" ? "warn" : item.queueKind === "learning" ? "bad" : "level"}">${item.reason}</span>
          <span class="pill">${item.entry.level} ${item.entry.number}</span>
        </div>
        <button class="link-button" data-action="open-grammar-card" data-entry-ref="${item.ref}" data-view="search">${escapeHtml(item.entry.title)}</button>
      </div>
    `)
    .join("") + (rows.length > 18 ? `<div class="empty">还有 ${rows.length - 18} 条在今日卡片队列中。</div>` : "");
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
        </div>
        <div class="task-actions">
          ${page ? `<button class="primary small" data-action="open-reader" data-page="${page}" data-title="${escapeAttr(task.label)}">打开 PDF</button>` : ""}
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
  if (task.items && task.items.length) {
    return `<div class="task-items">${task.items.slice(0, 18).map((item) => `<span class="pill">${item}</span>`).join("")}</div>`;
  }
  return "";
}

function pillForTask(task) {
  if (task.mode === "carryover") return "warn";
  if (task.type === "diagnostic") return "warn";
  if (task.type === "grammar") return "level";
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
  const dates = plan.dates || dateRange(START_DATE, END_DATE);
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
  const grammar = plannedGrammarEntriesForDate(date, plan);
  const grammarDue = grammarQueueForDate(date, plan).length;
  const rolloverCount = tasks.filter((task) => task.rolloverReason).length;
  const total = tasks.length;
  const done = tasks.filter((task) => statusFor(task).status === "done").length;
  return `
    <button class="day-card ${date === app.selectedDate ? "active" : ""} ${rolloverCount ? "has-rollover" : ""}" data-action="select-date" data-date="${date}">
      <strong>${formatShortDate(date)}</strong>
      <span>${done}/${total} 完成${grammarDue ? ` · ${grammarDue} 张文法` : ""}${rolloverCount ? ` · ${rolloverCount} 项调整` : ""}</span>
      <p>${grammar.length ? entryRangeLabel(grammar) : phaseLabel(date, plan)}</p>
    </button>
  `;
}

function renderReview(plan) {
  const items = reviewItems(plan);
  const grammarItems = grammarReviewQueueForDate(clampDate(todayIso(), plan.dates?.[0] || START_DATE, plan.dates?.[plan.dates.length - 1] || END_DATE), plan);
  const mastered = masteredGrammarEntries();
  const selectedEntry = app.selectedGrammarRef ? entryForRef(app.selectedGrammarRef) : null;
  const selectedProgress = selectedEntry ? grammarProgressFor(entryRef(selectedEntry)) : null;
  const selectedMode = selectedProgress?.status === "review" && selectedProgress.dueDate && selectedProgress.dueDate <= clampDate(todayIso(), plan.dates?.[0] || START_DATE, plan.dates?.[plan.dates.length - 1] || END_DATE) ? "review" : "detail";
  return `
    <div class="topbar">
      <div>
        <h2>复习池与已掌握</h2>
        <p>到期文法会进入复习池；已掌握条目可查看，也可以整条重新学习。</p>
      </div>
      <div class="toolbar">
        <button data-action="nav" data-view="search">搜索文法</button>
        <button data-action="export-state">导出进度</button>
        <button class="danger" data-action="reset-progress">清空进度</button>
      </div>
    </div>
    ${selectedEntry ? `<section class="flashcard-panel">${renderGrammarCard({ entry: selectedEntry, ref: entryRef(selectedEntry), reason: "池中查看", queueKind: "review" }, { mode: selectedMode })}</section>` : ""}
    <section class="panel review-section">
      <div class="panel-head">
        <h3>文法复习池</h3>
        <p>按遗忘曲线到期、重新学习、或逾期补学的卡片。</p>
      </div>
      <div class="panel-body">
        <div class="grammar-result-list">
          ${grammarItems.map((item) => renderGrammarResult(item.entry, item.reason, { actionMode: "review" })).join("") || `<div class="empty">今天没有到期文法卡片。</div>`}
        </div>
      </div>
    </section>
    <section class="panel review-section">
      <div class="panel-head">
        <h3>其他积压</h3>
        <p>阅读、听力、词汇和模拟任务仍按任务维度滚动。</p>
      </div>
      <div class="panel-body">
        <div class="task-list">
          ${items.map(renderTask).join("") || `<div class="empty">没有其他积压任务。</div>`}
        </div>
      </div>
    </section>
    <section class="panel review-section">
      <div class="panel-head">
        <h3>已掌握池</h3>
        <p>这些条目不会自动进入复习池。</p>
      </div>
      <div class="panel-body">
        <div class="grammar-result-list">
          ${mastered.slice(0, 40).map((entry) => renderGrammarResult(entry, "已掌握", { actionMode: "mastered" })).join("") || `<div class="empty">已掌握池暂时为空。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderSearch() {
  const results = searchGrammarEntries(app.searchQuery, app.searchScope);
  const selectedEntry = app.selectedGrammarRef ? entryForRef(app.selectedGrammarRef) : null;
  const showResults = app.searchQuery.trim() || app.searchScope !== "all";
  return `
    <div class="topbar">
      <div>
        <h2>文法搜索</h2>
        <p>搜索句型名、编号、级别和 PDF 原文。中文说明只原样检索，不接 AI。</p>
      </div>
      <div class="toolbar search-toolbar">
        <input value="${escapeAttr(app.searchQuery)}" placeholder="搜索：～わけではない / 说明 / 例文" data-search-query />
        <select data-search-scope>
          <option value="all" ${app.searchScope === "all" ? "selected" : ""}>全部</option>
          <option value="due" ${app.searchScope === "due" ? "selected" : ""}>复习池</option>
          <option value="mastered" ${app.searchScope === "mastered" ? "selected" : ""}>已掌握</option>
        </select>
      </div>
    </div>
    ${selectedEntry ? `<section class="flashcard-panel">${renderGrammarCard({ entry: selectedEntry, ref: entryRef(selectedEntry), reason: "搜索结果", queueKind: "search" }, { mode: "detail" })}</section>` : ""}
    <section class="panel">
      <div class="panel-body">
        <div class="grammar-result-list">
          ${showResults
            ? results.map((entry) => renderGrammarResult(entry, grammarStatusLabel(grammarProgressFor(entryRef(entry))), { actionMode: "detail" })).join("") || `<div class="empty">没有找到匹配的文法。</div>`
            : `<div class="empty">输入关键词开始搜索；也可以切到“复习池”或“已掌握”直接浏览。</div>`}
        </div>
      </div>
    </section>
  `;
}

function renderUserCenter() {
  const provider = currentAiProvider();
  const config = currentAiConfig();
  const hasKey = Boolean(config.apiKey);
  const baseUrl = config.baseUrl || providerDefaultBaseUrl(provider);
  const profile = studyProfile();
  return `
    <div class="topbar">
      <div>
        <h2>用户中心</h2>
        <p>第一项：AI API 设置。Key 只保存在本机浏览器，不会进入进度导出。</p>
      </div>
      <div class="toolbar">
        <button data-action="test-ai-settings">测试连接</button>
        <button class="primary" data-action="save-user-settings">保存设置</button>
      </div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h3>AI API</h3>
        <p>粘贴 API Key 后，抽认卡会先预热例句；DeepSeek 默认使用非思考快速模式。</p>
      </div>
      <div class="panel-body">
        <div class="preset-grid">
          <button class="small ${provider === "deepseek" ? "primary" : ""}" data-action="set-ai-provider" data-provider="deepseek">DeepSeek</button>
          <button class="small ${provider === "minimax" ? "primary" : ""}" data-action="set-ai-provider" data-provider="minimax">MiniMax</button>
        </div>
        <div class="settings-grid">
          <label class="setting-field">
            <span>API Key</span>
            <input type="password" autocomplete="off" spellcheck="false" value="${escapeAttr(config.apiKey || "")}" placeholder="${provider === "deepseek" ? "sk-..." : "sk-api-..."}" data-secret-field="apiKey" />
          </label>
          <label class="setting-field">
            <span>模型</span>
            <input value="${escapeAttr(config.model || providerDefaultModel(provider))}" data-secret-field="model" />
          </label>
          <label class="setting-field">
            <span>API Base URL</span>
            <input value="${escapeAttr(baseUrl)}" data-secret-field="baseUrl" />
          </label>
        </div>
        ${renderAiProviderPresets(provider, baseUrl, config.model)}
        <div class="toolbar user-actions">
          <button class="danger" data-action="clear-api-key" ${hasKey ? "" : "disabled"}>清除 API Key</button>
          <span class="pill ${hasKey ? "level" : "warn"}">${hasKey ? `${providerLabel(provider)} 已保存 ${maskApiKey(config.apiKey)}` : `${providerLabel(provider)} 未保存 API Key`}</span>
        </div>
        ${app.userCenterMessage ? `<div class="empty user-message">${escapeHtml(app.userCenterMessage)}</div>` : ""}
        <p class="source-note">安全提醒：这里是为了个人本地学习方便，Key 会存入当前浏览器的 localStorage。公共电脑请不要保存，或用完后清除。</p>
      </div>
    </section>
    <section class="panel">
      <div class="panel-head">
        <h3>备考目标</h3>
        <p>当前配置会影响日历、每日任务容量和文法级别路径。</p>
      </div>
      <div class="panel-body">
        <div class="grammar-overview-stats">
          ${stat("目前", profile.currentLevel)}
          ${stat("目标", profile.targetLevel)}
          ${stat("每天", `${profile.dailyMinutes} 分`)}
          ${stat("考试", formatDate(profile.examDate || EXAM_DATE))}
        </div>
        <div class="toolbar user-actions">
          <button class="primary" data-action="edit-onboarding">重新配置备考目标</button>
        </div>
      </div>
    </section>
  `;
}

function renderAiProviderPresets(provider, baseUrl, model) {
  if (provider === "deepseek") {
    return `
      <div class="preset-grid">
        <button class="small ${baseUrl === DEEPSEEK_DEFAULT_BASE_URL ? "primary" : ""}" data-action="set-ai-base" data-base-url="${DEEPSEEK_DEFAULT_BASE_URL}">DeepSeek 官方</button>
        <button class="small ${model === "deepseek-v4-flash" ? "primary" : ""}" data-action="set-ai-model" data-model="deepseek-v4-flash">v4 Flash</button>
        <button class="small ${model === "deepseek-v4-pro" ? "primary" : ""}" data-action="set-ai-model" data-model="deepseek-v4-pro">v4 Pro</button>
      </div>
    `;
  }
  return `
    <div class="preset-grid">
      <button class="small ${baseUrl === "https://api.minimax.io/v1" ? "primary" : ""}" data-action="set-ai-base" data-base-url="https://api.minimax.io/v1">国际接口</button>
      <button class="small ${baseUrl === "https://api.minimaxi.com/v1" ? "primary" : ""}" data-action="set-ai-base" data-base-url="https://api.minimaxi.com/v1">中国区接口</button>
      <button class="small ${/chatcompletion_v2$/.test(baseUrl) ? "primary" : ""}" data-action="set-ai-base" data-base-url="https://api.minimax.io/v1/text/chatcompletion_v2">原生接口</button>
    </div>
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
        <button data-action="extract-content">提取全文</button>
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
          <div id="annotationLayer" class="annotation-layer"></div>
        </div>
      </section>
      <aside class="panel">
        <div class="panel-head">
          <h3>快速跳转</h3>
          <p>按级别和条目打开 PDF。</p>
        </div>
        <div class="panel-body">
          ${LEVEL_ORDER.map((level) => quickJumpLevel(level)).join("")}
        </div>
      </aside>
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
    await renderAnnotations(page, viewport, layer);
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

function hasMissingGrammarContent() {
  const entries = orderedGrammarEntries();
  if (!entries.length) return false;
  return entries.some((entry, index) => {
    const ref = entryRef(entry);
    const next = nextGrammarEntry(entries, index);
    return app.state.grammarContent[ref]?.signature !== contentSignatureForEntry(entry, next);
  });
}

function contentReadyCount() {
  const entries = orderedGrammarEntries();
  return entries.filter((entry, index) => {
    const next = nextGrammarEntry(entries, index);
    return app.state.grammarContent[entryRef(entry)]?.signature === contentSignatureForEntry(entry, next);
  }).length;
}

function ensureGrammarContent(force) {
  if (extractionPromise) return extractionPromise;
  extractionPromise = extractGrammarContent(force).finally(() => {
    extractionPromise = null;
  });
  return extractionPromise;
}

async function extractGrammarContent(force = false) {
  const entries = orderedGrammarEntries();
  if (!entries.length) return;
  const targets = entries
    .map((entry, index) => ({ entry, index, next: nextGrammarEntry(entries, index) }))
    .filter(({ entry, next }) => force || app.state.grammarContent[entryRef(entry)]?.signature !== contentSignatureForEntry(entry, next));
  if (!targets.length) {
    app.state.extraction = {
      status: "done",
      total: entries.length,
      done: entries.length,
      message: "全文已经提取完成。",
      updatedAt: new Date().toISOString(),
    };
    saveState();
    render();
    return;
  }

  app.state.extraction = {
    status: "running",
    total: targets.length,
    done: 0,
    message: "正在从 PDF 文本层原样提取文法说明。",
    updatedAt: new Date().toISOString(),
  };
  saveState();
  render();

  try {
    const pdf = await getPdfDoc();
    app.state.pdf.pages = pdf.numPages;
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const ref = entryRef(target.entry);
      try {
        app.state.grammarContent[ref] = await extractEntryContent(pdf, target.entry, target.next);
      } catch (error) {
        console.warn("Cannot extract entry", ref, error);
        app.state.grammarContent[ref] = {
          text: "",
          startPage: target.entry.page || null,
          endPage: target.entry.page || null,
          extractedAt: new Date().toISOString(),
          signature: contentSignatureForEntry(target.entry, target.next),
          error: error.message || "提取失败",
        };
      }
      app.state.extraction.done = index + 1;
      app.state.extraction.message = `${target.entry.level} ${target.entry.number}. ${target.entry.title}`;
      app.state.extraction.updatedAt = new Date().toISOString();
      if ((index + 1) % CONTENT_SAVE_INTERVAL === 0 || index === targets.length - 1) {
        saveState();
        render();
      }
    }
    app.state.extraction = {
      status: "done",
      total: targets.length,
      done: targets.length,
      message: "全文提取完成，搜索会使用原书文本。",
      updatedAt: new Date().toISOString(),
    };
    saveState();
    render();
  } catch (error) {
    console.error(error);
    app.state.extraction = {
      status: "error",
      total: targets.length,
      done: app.state.extraction.done || 0,
      message: "PDF 文本提取失败；卡片仍可打开原 PDF。",
      updatedAt: new Date().toISOString(),
    };
    saveState();
    render();
  }
}

async function extractEntryContent(pdf, entry, next) {
  const startPage = clampNumber(entry.page || 1, 1, pdf.numPages);
  const endPage = next?.page
    ? clampNumber(Math.max(startPage, next.page), startPage, pdf.numPages)
    : clampNumber(startPage + 2, startPage, pdf.numPages);
  const texts = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    texts.push(await extractPageText(page));
  }
  const raw = texts.join("\n\n");
  return {
    text: trimEntryText(raw, entry, next),
    startPage,
    endPage,
    extractedAt: new Date().toISOString(),
    signature: contentSignatureForEntry(entry, next),
    source: "pdfjs-text-layer",
  };
}

async function extractPageText(page) {
  const content = await page.getTextContent();
  const items = content.items
    .map((item) => ({
      text: cleanupTitle(item.str || ""),
      x: item.transform ? item.transform[4] : 0,
      y: item.transform ? item.transform[5] : 0,
    }))
    .filter((item) => item.text);
  items.sort((a, b) => Math.round(b.y) - Math.round(a.y) || a.x - b.x);

  const lines = [];
  let current = null;
  for (const item of items) {
    if (!current || Math.abs(current.y - item.y) > 3) {
      current = { y: item.y, parts: [item] };
      lines.push(current);
    } else {
      current.parts.push(item);
    }
  }

  return normalizeExtractedText(lines
    .map((line) => line.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(""))
    .join("\n"));
}

function trimEntryText(text, entry, next) {
  let value = normalizeExtractedText(text);
  const start = findEntryMarker(value, entry);
  if (start >= 0) {
    value = value.slice(start);
  }
  if (next) {
    const searchOffset = Math.min(value.length, 20);
    const nextIndex = findEntryMarker(value.slice(searchOffset), next);
    if (nextIndex >= 0) {
      value = value.slice(0, searchOffset + nextIndex);
    }
  }
  return normalizeExtractedText(value);
}

function findEntryMarker(text, entry) {
  const match = new RegExp(`(^|\\n)\\s*${entry.number}\\s*[.．、]\\s*`, "m").exec(text);
  return match ? match.index + match[1].length : -1;
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function nextGrammarEntry(entries, index) {
  const entry = entries[index];
  for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
    if (entries[cursor].level === entry.level) return entries[cursor];
    if (entries[cursor].level !== entry.level) return null;
  }
  return null;
}

function contentSignatureForEntry(entry, next) {
  return `${entryRef(entry)}|${entry.page || ""}|${entry.title || ""}|${next ? `${entryRef(next)}:${next.page || ""}` : "end"}`;
}

function buildPlan(catalog, profile = defaultOnboarding()) {
  const normalizedProfile = normalizeOnboarding(profile, { onboarding: profile });
  const startDate = normalizedProfile.startDate || START_DATE;
  const endDate = planEndDateForProfile(normalizedProfile);
  const dates = dateRange(startDate, endDate >= startDate ? endDate : startDate);
  const phaseDates = splitPhaseDates(dates, normalizedProfile, catalog);
  const phaseByDate = phaseMapFromDates(phaseDates, normalizedProfile);
  const chunksByDate = {};
  for (const level of mainLevelsForProfile(normalizedProfile)) {
    const entries = catalog.filter((entry) => entry.level === level).sort((a, b) => a.number - b.number);
    const chunks = chunkEntries(entries, phaseDates[level].length);
    phaseDates[level].forEach((date, index) => {
      if (chunks[index] && chunks[index].length) {
        chunksByDate[date] = chunksByDate[date] || [];
        chunksByDate[date].push({ level, entries: chunks[index] });
      }
    });
  }
  return { dates, phaseDates, phaseByDate, chunksByDate, profile: normalizedProfile };
}

function splitPhaseDates(dates, profile, catalog = []) {
  const result = Object.fromEntries(LEVEL_ORDER.map((level) => [level, []]));
  result.diagnostic = [];
  result.review = [];
  if (!dates.length) return result;

  const diagnosticLevels = diagnosticLevelsForProfile(profile);
  const mainLevels = mainLevelsForProfile(profile);
  const totalDays = dates.length;
  const reviewDays = Math.min(Math.max(4, Math.round(totalDays * 0.18)), Math.max(0, totalDays - 1));
  const diagnosticDays = diagnosticLevels.length
    ? Math.min(Math.max(1, diagnosticLevels.length), Math.max(0, Math.round(totalDays * 0.12)))
    : 0;
  const studyStart = diagnosticDays;
  const studyEnd = Math.max(studyStart, totalDays - reviewDays);
  result.diagnostic = dates.slice(0, diagnosticDays);
  result.review = dates.slice(studyEnd);
  const studyDates = dates.slice(studyStart, studyEnd);
  if (!studyDates.length) {
    result[profile.targetLevel] = dates.slice(diagnosticDays, Math.max(diagnosticDays + 1, totalDays - reviewDays));
    return result;
  }

  const counts = mainLevels.map((level) => catalog.filter((entry) => entry.level === level).length || 1);
  const totalEntries = counts.reduce((sum, count) => sum + count, 0) || mainLevels.length || 1;
  let cursor = 0;
  mainLevels.forEach((level, index) => {
    const remainingLevels = mainLevels.length - index;
    const remainingDates = studyDates.length - cursor;
    const isLast = index === mainLevels.length - 1;
    const weighted = Math.round(studyDates.length * (counts[index] / totalEntries));
    const daysForLevel = isLast
      ? remainingDates
      : Math.max(1, Math.min(weighted || 1, remainingDates - remainingLevels + 1));
    result[level] = studyDates.slice(cursor, cursor + daysForLevel);
    cursor += daysForLevel;
  });
  return result;
}

function phaseMapFromDates(phaseDates, profile) {
  const map = {};
  for (const date of phaseDates.diagnostic || []) {
    map[date] = { kind: "diagnostic", levels: diagnosticLevelsForProfile(profile), level: profile.currentLevel };
  }
  for (const level of mainLevelsForProfile(profile)) {
    for (const date of phaseDates[level] || []) {
      map[date] = { kind: "study", level };
    }
  }
  for (const date of phaseDates.review || []) {
    map[date] = { kind: "review", level: profile.targetLevel };
  }
  return map;
}

function planEndDateForProfile(profile = studyProfile()) {
  const examDate = profile.examDate || EXAM_DATE;
  return addDays(examDate, -1);
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
  const phase = phaseForDate(date, plan);
  const profile = plan.profile || studyProfile();
  const level = phase.level || profile.targetLevel;
  const dailyMinutes = Number(profile.dailyMinutes) || DEFAULT_DAILY_MINUTES;

  if (phase.kind === "diagnostic") {
    tasks.push(diagnosticTask(date, phase.levels || [profile.currentLevel]));
  }
  tasks.push(vocabTask(date, level, vocabCountForDate(date, plan)));
  if (dailyMinutes < 100) {
    tasks.push(dateIndex(date) % 2 === 0 ? readingTask(date, plan) : listeningTask(date, plan));
  } else {
    tasks.push(readingTask(date, plan));
    tasks.push(listeningTask(date, plan));
  }
  if (phase.kind === "review" && dailyMinutes >= 150) tasks.push(mockTask(date, plan));
  return tasks.filter(Boolean).map((task) => decorateBaseTask(task, date));
}

function legacyGrammarTasksForDate(date, plan) {
  const tasks = [];
  for (const chunk of plan.chunksByDate[date] || []) {
    tasks.push(grammarTask(date, "new", chunk.entries));
  }

  for (const sourceDate of [addDays(date, -1), addDays(date, -4)]) {
    for (const chunk of plan.chunksByDate[sourceDate] || []) {
      tasks.push(grammarTask(date, "review", chunk.entries, sourceDate));
    }
  }
  return tasks.filter(Boolean).map((task) => decorateBaseTask(task, date));
}

function buildRollingPlan(basePlan, statuses = {}, settings = {}, today = todayIso()) {
  const firstDate = basePlan.dates[0] || START_DATE;
  const lastDate = basePlan.dates[basePlan.dates.length - 1] || END_DATE;
  const currentDate = clampDate(today, firstDate, lastDate);
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
  for (const date of dateRange(currentDate, lastDate)) {
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

  const unscheduled = queue.filter((candidate) => candidate.earliestDate <= lastDate);
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

function plannedGrammarEntriesForDate(date, plan) {
  return (plan.chunksByDate[date] || []).flatMap((chunk) => chunk.entries);
}

function orderedGrammarEntries() {
  return (app.state.catalog || [])
    .filter((entry) => LEVEL_ORDER.includes(entry.level))
    .slice()
    .sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.number - b.number);
}

function grammarQueueForDate(date, plan) {
  const today = clampDate(todayIso(), START_DATE, END_DATE);
  const queue = [];
  const seen = new Set();

  function add(entry, reason, queueKind, dueDate = null, baseDate = null) {
    const ref = entryRef(entry);
    if (seen.has(ref)) return;
    const progress = grammarProgressFor(ref);
    if (progress.status === "mastered") return;
    seen.add(ref);
    queue.push({ entry, ref, reason, queueKind, dueDate, baseDate, progress });
  }

  for (const entry of plannedGrammarEntriesForDate(date, plan)) {
    const ref = entryRef(entry);
    const progress = grammarProgressFor(ref);
    if (progress.status === "mastered") continue;
    if (progress.status === "review" && progress.dueDate && progress.dueDate > date) continue;
    if (progress.status === "review" && (!progress.dueDate || progress.dueDate <= date)) {
      add(entry, "到期复习", "review", progress.dueDate, date);
      continue;
    }
    if (progress.status === "learning" && (!progress.dueDate || progress.dueDate <= date)) {
      add(entry, "重新学习", "learning", progress.dueDate, date);
      continue;
    }
    if (progress.status === "new") {
      add(entry, "新学", "new", null, date);
    }
  }

  if (date >= today) {
    const firstDate = plan.dates?.[0] || START_DATE;
    for (const sourceDate of dateRange(firstDate, addDays(date, -1))) {
      for (const entry of plannedGrammarEntriesForDate(sourceDate, plan)) {
        const progress = grammarProgressFor(entryRef(entry));
        if (progress.status === "new") {
          add(entry, "逾期补学", "learning", date, sourceDate);
        }
      }
    }
  }

  for (const entry of orderedGrammarEntries()) {
    const progress = grammarProgressFor(entryRef(entry));
    if (progress.status === "mastered" || progress.status === "new") continue;
    if (!progress.dueDate || progress.dueDate > date) continue;
    add(entry, progress.status === "learning" ? "重新学习" : "到期复习", progress.status === "learning" ? "learning" : "review", progress.dueDate, progress.dueDate);
  }

  return queue.sort(compareGrammarQueueItems);
}

function grammarReviewQueueForDate(date, plan) {
  return grammarQueueForDate(date, plan).filter((item) => item.queueKind === "review");
}

function grammarLearningQueueForDate(date, plan) {
  return grammarQueueForDate(date, plan);
}

function grammarSummaryForDate(date, plan) {
  const queue = grammarQueueForDate(date, plan);
  const reviewQueue = grammarReviewQueueForDate(date, plan);
  return {
    studyQueue: grammarLearningQueueForDate(date, plan),
    reviewQueue,
    newCount: queue.filter((item) => item.queueKind === "new").length,
    learningCount: queue.filter((item) => item.queueKind === "learning").length,
    reviewCount: reviewQueue.length,
    masteredCount: masteredGrammarEntries().length,
  };
}

function compareGrammarQueueItems(a, b) {
  const priority = { learning: 1, review: 2, new: 3, planned: 4, search: 5 };
  return (priority[a.queueKind] || 9) - (priority[b.queueKind] || 9)
    || (a.dueDate || a.baseDate || "").localeCompare(b.dueDate || b.baseDate || "")
    || LEVEL_ORDER.indexOf(a.entry.level) - LEVEL_ORDER.indexOf(b.entry.level)
    || a.entry.number - b.entry.number;
}

function resolveSelectedGrammarRef(queue) {
  if (!queue.length) {
    app.selectedGrammarRef = null;
    return null;
  }
  if (!queue.some((item) => item.ref === app.selectedGrammarRef)) {
    app.selectedGrammarRef = queue[0].ref;
    app.flashcardAnswerVisible = false;
  }
  return app.selectedGrammarRef;
}

function renderGrammarCard(item, options = {}) {
  const entry = item.entry;
  const ref = item.ref || entryRef(entry);
  const progress = grammarProgressFor(ref);
  const content = app.state.grammarContent[ref];
  const hasContent = content && content.text && content.text.trim();
  const sourceLabel = hasContent
    ? `PDF 原文 ${content.startPage || entry.page || "-"}-${content.endPage || entry.page || "-"} 页`
    : "尚未提取到正文，可打开 PDF 对照";
  const answer = app.flashcardAnswerVisible;
  const mode = options.mode || "detail";
  return `
    <article class="flashcard">
      <div class="flashcard-head">
        <div>
          <div class="task-title">
            <span class="pill level">${entry.level}</span>
            <span class="pill ${item.queueKind === "review" ? "warn" : item.queueKind === "learning" ? "bad" : "info"}">${item.reason || grammarStatusLabel(progress)}</span>
            <span class="pill">${grammarStatusLabel(progress)}</span>
          </div>
          <h3>${entry.number}. ${escapeHtml(entry.title)}</h3>
          <p>${sourceLabel}${progress.dueDate ? ` · 下次/本次到期 ${formatDate(progress.dueDate)}` : ""}</p>
        </div>
        ${options.countLabel ? `<span class="pill">${options.countLabel}</span>` : ""}
      </div>
      <div class="flashcard-front">
        <span class="card-number">${entry.level} · ${entry.number}</span>
        <strong>${escapeHtml(entry.title)}</strong>
      </div>
      <div class="flashcard-answer ${answer ? "is-open" : ""}">
        ${answer
          ? `
            <div class="grammar-text">${hasContent ? formatGrammarContent(content.text, ref) : "还没有提取到这一条的正文。中文说明不会接入 AI；可先打开 PDF 原文查看。"}</div>
            ${hasContent ? renderAiPanel(ref) : ""}
          `
          : `<button class="primary" data-action="toggle-answer">显示答案</button>`}
      </div>
      <div class="flashcard-actions">
        ${entry.page ? `<button data-action="open-reader" data-page="${entry.page}" data-title="${escapeAttr(`${entry.level} ${entry.number}. ${entry.title}`)}">打开 PDF</button>` : ""}
        ${answer ? `<button class="ghost" data-action="toggle-answer">收起答案</button>` : ""}
        ${grammarActionButtons(ref, progress, mode)}
      </div>
    </article>
  `;
}

function grammarActionButtons(ref, progress = grammarProgressFor(ref), mode = "detail") {
  if (mode === "review") {
    return `
      <button class="primary" data-action="remember-grammar" data-entry-ref="${ref}">记得</button>
      <button data-action="forget-grammar" data-entry-ref="${ref}">忘了</button>
    `;
  }
  if (progress.status === "mastered") {
    return `<button class="primary" data-action="relearn-grammar" data-entry-ref="${ref}">重新学习</button>`;
  }
  return `
    <button class="primary" data-action="complete-grammar" data-entry-ref="${ref}">已完成</button>
    <button data-action="master-grammar" data-entry-ref="${ref}">已掌握</button>
  `;
}

function renderGrammarResult(entry, reason, options = {}) {
  const ref = entryRef(entry);
  const progress = grammarProgressFor(ref);
  const snippet = grammarSearchSnippet(ref, app.searchQuery);
  const actionMode = options.actionMode || "detail";
  return `
    <article class="grammar-result status-${progress.status}">
      <div>
        <div class="task-title">
          <span class="pill level">${entry.level}</span>
          <span class="pill">${entry.number}</span>
          <span class="pill ${progress.status === "mastered" ? "level" : progress.status === "review" ? "warn" : progress.status === "learning" ? "bad" : "info"}">${reason || grammarStatusLabel(progress)}</span>
        </div>
        <h4>${escapeHtml(entry.title)}</h4>
        ${snippet ? `<p>${snippet}</p>` : `<p>${entry.page ? `PDF 第 ${entry.page} 页` : "未记录页码"}</p>`}
      </div>
      <div class="task-actions">
        <button class="small" data-action="open-grammar-card" data-entry-ref="${ref}" data-view="${actionMode === "review" ? "review" : app.view}">查看卡片</button>
        ${entry.page ? `<button class="small" data-action="open-reader" data-page="${entry.page}" data-title="${escapeAttr(`${entry.level} ${entry.number}. ${entry.title}`)}">PDF</button>` : ""}
        ${grammarActionButtons(ref, progress, actionMode)}
      </div>
    </article>
  `;
}

function renderAiPanel(ref) {
  const entry = entryForRef(ref);
  const target = selectedGrammarTargetForRef(ref);
  const cached = app.state.aiExplanations[aiCacheKey(ref)] || aiResultFromSentencePrecache(ref, target);
  const isLoading = app.aiLoadingRef === ref;
  const isPreheating = !target && hasPrecacheInFlightForRef(ref);
  const targetLabel = target
    ? target.type === "word"
      ? `已选词语：${target.text}`
      : `已选整句 ${target.exampleIndex + 1}`
    : "单击词语或双击整句后自动分析";
  const placeholder = hasConfiguredAi()
    ? isPreheating
      ? "正在后台预热当前例句；预热完成后单击词语会直接显示句中解释。"
      : `${escapeHtml(targetLabel)}。如果这条例句还没预热完成，会先等待句子分析缓存。`
    : `${escapeHtml(targetLabel)}。请先在用户中心粘贴 AI API Key，或设置 <code>DEEPSEEK_API_KEY</code>/<code>MINIMAX_API_KEY</code> 后用 <code>node server.mjs</code> 启动。`;
  return `
    <div class="ai-panel">
      <div class="ai-panel-head">
        <div>
          <span class="pill info">AI</span>
          <h4>AI 例句拆解</h4>
          <p>卡片展开后会预热例句拆解；单击词语优先秒开句中解释，双击例句分析整句。</p>
        </div>
        ${target ? `<button class="small" data-action="refresh-ai-explanation" data-entry-ref="${ref}">重新分析</button>` : ""}
      </div>
      ${isLoading ? `<div class="empty">正在分析：${escapeHtml(targetLabel)}...</div>` : ""}
      ${app.aiMessage && app.selectedGrammarTarget?.ref === ref ? `<div class="empty">${escapeHtml(app.aiMessage)}</div>` : ""}
      ${cached ? renderAiExplanation(cached, entry) : `<div class="ai-placeholder">${placeholder}</div>`}
    </div>
  `;
}

function renderAiExplanation(result, entry) {
  const clean = normalizeAiExplanationForDisplay(result);
  if (clean.isDirty) {
    return `
      <div class="ai-result">
        <p>这条 AI 缓存是旧格式或非中文输出，已经隐藏。请点右上角“重新分析”刷新。</p>
      </div>
    `;
  }
  return `
    <div class="ai-result">
      ${clean.summary ? `<p>${escapeHtml(clean.summary)}</p>` : ""}
      ${clean.points.length ? `
        <div class="ai-points">
          ${clean.points.map((point) => `<span>${escapeHtml(point)}</span>`).join("")}
        </div>
      ` : ""}
      ${clean.examples.length ? clean.examples.map((example) => `
        <div class="ai-example">
          <strong>${escapeHtml(example.sentence || entry.title)}</strong>
          ${example.breakdown ? `<p>${escapeHtml(example.breakdown)}</p>` : ""}
          ${example.memoryTip ? `<p class="ai-tip">${escapeHtml(example.memoryTip)}</p>` : ""}
        </div>
      `).join("") : ""}
    </div>
  `;
}

function normalizeAiExplanationForDisplay(result) {
  const parsed = parseCachedAiResult(result);
  const normalized = {
    summary: cleanCachedAiText(parsed.summary),
    points: Array.isArray(parsed.points) ? parsed.points.map(cleanCachedAiText).filter(Boolean) : [],
    examples: Array.isArray(parsed.examples)
      ? parsed.examples.map((example) => ({
        sentence: cleanCachedAiText(example?.sentence),
        breakdown: cleanCachedAiText(example?.breakdown),
        memoryTip: cleanCachedAiText(example?.memoryTip),
      })).filter((example) => example.sentence || example.breakdown || example.memoryTip)
      : [],
  };
  const displayText = [
    normalized.summary,
    ...normalized.points,
    ...normalized.examples.flatMap((example) => [example.breakdown, example.memoryTip]),
  ].join("\n");
  return {
    ...normalized,
    isDirty: isDirtyAiText(displayText),
  };
}

function parseCachedAiResult(value) {
  if (typeof value === "string") return parseCachedAiJson(value) || { summary: value };
  if (value?.summary && looksLikeCachedJson(value.summary)) {
    return parseCachedAiJson(value.summary) || value;
  }
  return value || {};
}

function parseCachedAiJson(value) {
  const text = String(value || "").trim();
  const candidates = [text];
  const objectSlice = sliceCachedJsonObject(text);
  if (objectSlice && objectSlice !== text) candidates.push(objectSlice);
  if (text.includes('\\"')) {
    const unescaped = text.replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    candidates.push(unescaped);
    const unescapedObjectSlice = sliceCachedJsonObject(unescaped);
    if (unescapedObjectSlice && unescapedObjectSlice !== unescaped) candidates.push(unescapedObjectSlice);
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      return typeof parsed === "string" && looksLikeCachedJson(parsed)
        ? parseCachedAiJson(parsed)
        : parsed;
    } catch {}
  }
  return null;
}

function sliceCachedJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : "";
}

function looksLikeCachedJson(value) {
  const text = String(value || "").trim();
  return text.startsWith("{") || text.startsWith('\\"{') || text.includes('"summary"') || text.includes('\\"summary\\"');
}

function cleanCachedAiText(value) {
  return String(value || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();
}

function isDirtyAiText(text) {
  if (!text.trim()) return true;
  return /\b(Let me|I need to|Looking at|tokenIndex|candidateSpan|reasoning|thinking|tokens?\[|Wait,|Actually|selectedText)\b/i.test(text)
    || /^\\?["']?\s*\{/.test(text.trim());
}

function grammarProgressFor(ref) {
  return {
    status: "new",
    reviewStage: 0,
    dueDate: null,
    lastReviewedAt: null,
    masteredAt: null,
    updatedAt: null,
    ...(app.state.grammarProgress[ref] || {}),
  };
}

function grammarStatusLabel(progress) {
  return {
    new: "未学",
    learning: "学习中",
    review: progress.dueDate && progress.dueDate <= clampDate(todayIso(), START_DATE, END_DATE) ? "待复习" : "复习中",
    mastered: "已掌握",
  }[progress.status || "new"] || "未学";
}

function entryForRef(ref) {
  return app.state.catalog.find((entry) => entryRef(entry) === ref);
}

function masteredGrammarEntries() {
  return orderedGrammarEntries().filter((entry) => grammarProgressFor(entryRef(entry)).status === "mastered");
}

function searchGrammarEntries(query, scope) {
  const normalized = normalizeSearch(query);
  return orderedGrammarEntries()
    .filter((entry) => {
      const progress = grammarProgressFor(entryRef(entry));
      if (scope === "mastered" && progress.status !== "mastered") return false;
      if (scope === "due" && (progress.status !== "review" || !progress.dueDate || progress.dueDate > clampDate(todayIso(), START_DATE, END_DATE))) return false;
      if (!normalized) return scope !== "all";
      const ref = entryRef(entry);
      const content = app.state.grammarContent[ref]?.text || "";
      const haystack = normalizeSearch(`${entry.level} ${entry.number} ${entry.title} ${content}`);
      return haystack.includes(normalized);
    })
    .slice(0, 100);
}

function grammarSearchSnippet(ref, query) {
  const content = app.state.grammarContent[ref]?.text || "";
  const normalized = normalizeSearch(query);
  if (!content || !normalized) return "";
  const lower = normalizeSearch(content);
  const index = lower.indexOf(normalized);
  if (index === -1) return "";
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + normalized.length + 100);
  return escapeHtml(`${start > 0 ? "..." : ""}${content.slice(start, end).replace(/\s+/g, " ")}${end < content.length ? "..." : ""}`);
}

function normalizeSearch(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

function saveUserSettings() {
  const provider = currentAiProvider();
  const config = currentAiConfig();
  updateCurrentAiConfig("apiKey", String(config.apiKey || "").trim());
  updateCurrentAiConfig("model", String(config.model || providerDefaultModel(provider)).trim());
  updateCurrentAiConfig("baseUrl", String(config.baseUrl || providerDefaultBaseUrl(provider)).trim());
  saveSecrets();
  const savedConfig = currentAiConfig();
  app.userCenterMessage = savedConfig.apiKey
    ? `已保存 ${providerLabel(provider)} API 设置：${maskApiKey(savedConfig.apiKey)}。`
    : `已保存 ${providerLabel(provider)} 模型和 Base URL；还没有 API Key。`;
  render();
}

function clearApiKey() {
  updateCurrentAiConfig("apiKey", "");
  saveSecrets();
  app.userCenterMessage = `${providerLabel(currentAiProvider())} API Key 已从本机浏览器清除。`;
  render();
}

function setAiProvider(provider) {
  if (!["minimax", "deepseek"].includes(provider)) return;
  app.secrets = normalizeSecrets({ ...app.secrets, provider });
  app.userCenterMessage = `已切换到 ${providerLabel(provider)}。`;
  render();
}

function setAiBaseUrl(baseUrl) {
  updateCurrentAiConfig("baseUrl", baseUrl || providerDefaultBaseUrl(currentAiProvider()));
  app.userCenterMessage = `已切换 Base URL：${currentAiConfig().baseUrl}`;
  render();
}

function setAiModel(model) {
  updateCurrentAiConfig("model", model || providerDefaultModel(currentAiProvider()));
  app.userCenterMessage = `已切换模型：${currentAiConfig().model}`;
  render();
}

function updateCurrentAiConfig(field, value) {
  const provider = currentAiProvider();
  app.secrets = normalizeSecrets(app.secrets);
  app.secrets.providers[provider] = {
    ...currentAiConfig(),
    [field]: value,
  };
}

function currentAiProvider() {
  app.secrets = normalizeSecrets(app.secrets);
  return app.secrets.provider;
}

function currentAiConfig() {
  app.secrets = normalizeSecrets(app.secrets);
  const provider = app.secrets.provider;
  return app.secrets.providers[provider] || app.secrets.providers[DEFAULT_AI_PROVIDER];
}

function providerDefaultModel(provider) {
  return providerDefaults(provider).defaultModel;
}

function providerDefaultBaseUrl(provider) {
  return providerDefaults(provider).defaultBaseUrl;
}

function providerLabel(provider) {
  return configuredProviderLabel(provider);
}

async function testAiSettings() {
  const provider = currentAiProvider();
  const config = currentAiConfig();
  if (!String(config.apiKey || "").trim()) {
    app.userCenterMessage = `请先粘贴 ${providerLabel(provider)} API Key，再测试连接。`;
    render();
    return;
  }
  app.userCenterMessage = `正在测试 ${providerLabel(provider)} 连接...`;
  render();
  try {
    let health;
    try {
      health = await fetch("/api/health");
    } catch {
      throw new Error(aiProxyUnavailableMessage());
    }
    if (!health.ok) {
      throw new Error(aiProxyUnavailableMessage());
    }
    const response = await fetch("/api/grammar-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...aiCredentialsPayload(),
        level: "N4",
        number: "test",
        title: "～ず（に）",
        analysisMode: "sentence-cache",
        promptVersion: AI_PROMPT_VERSION,
        selectionType: "sentence",
        selectedText: "何も食べずに働いた。",
        tokenIndex: null,
        tokens: ["何", "も", "食べ", "ずに", "働いた", "。"],
        beforeText: "",
        afterText: "",
        candidateSpan: "何も食べずに働いた。",
        examples: [{ japanese: "何も食べずに働いた。" }],
      }),
    });
    const payload = await readJsonPayload(response);
    if (!response.ok) throw new Error(formatAiPayloadError(payload, "连接失败"));
    app.userCenterMessage = `${providerLabel(provider)} 连接成功，例句预缓存可以使用。`;
  } catch (error) {
    app.userCenterMessage = formatAiException(error, "AI 连接失败。");
  }
  render();
}

function aiCredentialsPayload() {
  const provider = currentAiProvider();
  const config = currentAiConfig();
  return {
    provider,
    apiKey: config.apiKey || "",
    model: config.model || providerDefaultModel(provider),
    baseUrl: config.baseUrl || providerDefaultBaseUrl(provider),
  };
}

async function readJsonPayload(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const code = clientAiCodeForStatus(response.status);
    return {
      code,
      error: response.status === 404
        ? "没有找到本地 AI 代理接口。"
        : text.slice(0, 240),
      advice: clientAdviceForAiCode(code),
      provider: null,
      status: response.status,
      endpoint: null,
    };
  }
}

function formatAiPayloadError(payload, fallback = "AI 请求失败。") {
  const message = payload?.error || fallback;
  const advice = payload?.advice || clientAdviceForAiCode(payload?.code);
  const detail = payload?.code
    ? `（${payload.code}${payload.endpoint ? ` · ${payload.endpoint}` : ""}）`
    : "";
  const parts = [`${message}${detail}`, advice].filter(Boolean);
  return Array.from(new Set(parts)).join(" ");
}

function formatAiException(error, fallback = "AI 请求失败。") {
  const message = error?.message || fallback;
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return aiProxyUnavailableMessage();
  }
  return message;
}

function aiProxyUnavailableMessage() {
  return "本地 Node 代理未响应。请用 node server.mjs 启动；静态 Python 服务只能使用非 AI 功能。";
}

function clientAiCodeForStatus(status) {
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 405) return "endpoint_not_found";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  return "provider_unavailable";
}

function clientAdviceForAiCode(code) {
  return {
    missing_api_key: "请在用户中心粘贴 API Key，或设置环境变量后用 node server.mjs 启动。",
    invalid_request: "请重新打开卡片再试；如果你手动调用接口，请确认请求 JSON 格式。",
    auth_failed: "请检查 API Key 是否正确、是否属于当前服务商，以及账号是否仍可用。",
    rate_limited: "服务商返回限流。请稍后重试，或临时切换服务商/模型。",
    provider_unavailable: "服务商暂时不可用。请稍后重试，或切换服务商。",
    endpoint_not_found: "请确认用 node server.mjs 启动；如果已经启动，请检查 Base URL 或 MiniMax 接口预设。",
    network_error: "请检查本机网络、代理设置和 Base URL；AI 功能必须通过 node server.mjs 同源访问。",
    invalid_model_json: "模型没有按要求输出 JSON。请点“重新分析”，或换用默认快速模型后再试。",
  }[code] || "请检查 API Key、模型名和 Base URL。";
}

function hasConfiguredAi() {
  return Boolean(String(currentAiConfig().apiKey || "").trim());
}

function scheduleVisibleGrammarPrecache() {
  if (!isOnboardingComplete() || !app.flashcardAnswerVisible || !hasConfiguredAi()) return;
  window.setTimeout(() => {
    const nodes = Array.from(document.querySelectorAll(".flashcard .grammar-example[data-entry-ref][data-example-index]"));
    const scheduled = new Set();
    let count = 0;
    for (const node of nodes) {
      if (count >= AI_PRECACHE_EXAMPLE_LIMIT) break;
      const ref = node.dataset.entryRef;
      const exampleIndex = Number(node.dataset.exampleIndex);
      const key = aiSentenceCacheKey(ref, exampleIndex);
      if (!key || scheduled.has(key) || app.state.aiExplanations[key] || aiPrecacheInFlight.has(key)) continue;
      scheduled.add(key);
      count += 1;
      window.setTimeout(() => {
        prefetchGrammarExampleAnalysis(ref, exampleIndex, { renderOnComplete: true }).catch(() => {});
      }, 80 + count * 120);
    }
  }, 0);
}

async function prefetchGrammarExampleAnalysis(ref, exampleIndex, options = {}) {
  const key = aiSentenceCacheKey(ref, exampleIndex);
  if (!key || !hasConfiguredAi()) return null;
  if (options.force) {
    delete app.state.aiExplanations[key];
  }
  if (app.state.aiExplanations[key]) return app.state.aiExplanations[key];
  if (!options.force && aiPrecacheInFlight.has(key)) return aiPrecacheInFlight.get(key);

  let promise;
  promise = fetchGrammarExamplePrecache(ref, exampleIndex, options)
    .finally(() => {
      if (aiPrecacheInFlight.get(key) !== promise) return;
      aiPrecacheInFlight.delete(key);
    });
  aiPrecacheInFlight.set(key, promise);
  return promise;
}

async function fetchGrammarExamplePrecache(ref, exampleIndex, options = {}) {
  const entry = entryForRef(ref);
  const example = grammarExampleForRef(ref, exampleIndex);
  if (!entry || !example?.japanese) return null;
  const tokens = grammarTokensForExample(example).map((token) => token.text);
  let response;
  try {
    response = await fetch("/api/grammar-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...aiCredentialsPayload(),
        ref,
        analysisMode: "sentence-cache",
        promptVersion: AI_PROMPT_VERSION,
        level: entry.level,
        number: entry.number,
        title: entry.title,
        selectionType: "sentence",
        selectedText: example.japanese,
        tokenIndex: null,
        tokens,
        beforeText: "",
        afterText: "",
        candidateSpan: example.japanese,
        selectedExampleIndex: example.index,
        examples: [{
          japanese: example.japanese,
          translation: example.translation || "",
          source: "pdf-example",
        }],
      }),
    });
  } catch (error) {
    throw new Error(formatAiException(error));
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new Error(formatAiPayloadError(payload, "AI 预缓存请求失败"));
  }
  const normalized = normalizeSentencePrecache(payload, example, tokens);
  const key = aiSentenceCacheKey(ref, exampleIndex);
  app.state.aiExplanations[key] = normalized;
  saveState();
  if (options.renderOnComplete && app.selectedGrammarRef === ref) render();
  return normalized;
}

function normalizeSentencePrecache(payload, example, tokens) {
  const tokenAnalyses = Array.isArray(payload.tokenAnalyses)
    ? payload.tokenAnalyses.map((item) => ({
      tokenIndex: Number.isInteger(item?.tokenIndex) ? item.tokenIndex : Number(item?.tokenIndex),
      text: cleanCachedAiText(item?.text),
      spanText: cleanCachedAiText(item?.spanText),
      meaning: cleanCachedAiText(item?.meaning),
      role: cleanCachedAiText(item?.role),
      explanation: cleanCachedAiText(item?.explanation),
      memoryTip: cleanCachedAiText(item?.memoryTip),
      dependsOn: normalizeNumberArray(item?.dependsOn),
    })).filter((item) => Number.isInteger(item.tokenIndex) && item.tokenIndex >= 0 && item.tokenIndex < tokens.length)
    : [];
  return {
    analysisMode: "sentence-cache",
    promptVersion: AI_PROMPT_VERSION,
    sentence: cleanCachedAiText(payload.sentence) || example.japanese,
    sentenceSummary: cleanCachedAiText(payload.sentenceSummary) || cleanCachedAiText(payload.summary),
    summary: cleanCachedAiText(payload.summary) || cleanCachedAiText(payload.sentenceSummary),
    tokenAnalyses,
    examples: Array.isArray(payload.examples)
      ? payload.examples.map((item) => ({
        sentence: cleanCachedAiText(item?.sentence) || example.japanese,
        breakdown: cleanCachedAiText(item?.breakdown),
        memoryTip: cleanCachedAiText(item?.memoryTip),
      })).filter((item) => item.sentence || item.breakdown || item.memoryTip)
      : [],
    createdAt: new Date().toISOString(),
  };
}

function normalizeNumberArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function grammarExampleForRef(ref, exampleIndex) {
  return grammarContentExamples(ref).find((item) => item.index === Number(exampleIndex));
}

function grammarTokensForExample(example) {
  return tokenizeJapaneseText(example?.japanese || "").filter((token) => !token.isPunctuation || token.text.trim());
}

function sentencePrecacheForTarget(ref, target) {
  if (!target) return null;
  const key = aiSentenceCacheKey(ref, target.exampleIndex);
  const cached = key ? app.state.aiExplanations[key] : null;
  if (!cached || cached.analysisMode !== "sentence-cache") return null;
  return normalizeSentencePrecache(cached, {
    japanese: target.sentence,
    translation: target.translation || "",
  }, target.tokens || []);
}

function aiResultFromSentencePrecache(ref, target) {
  const cached = sentencePrecacheForTarget(ref, target);
  if (!cached) return null;
  if (target.type === "sentence") {
    const example = cached.examples[0] || {};
    return {
      summary: cached.sentenceSummary || cached.summary,
      points: cached.summary && cached.summary !== cached.sentenceSummary ? [cached.summary] : [],
      examples: [{
        sentence: target.sentence,
        breakdown: example.breakdown || cached.sentenceSummary || cached.summary,
        memoryTip: example.memoryTip || "",
      }],
      fromPrecache: true,
      promptVersion: AI_PROMPT_VERSION,
    };
  }

  const analysis = tokenAnalysisForTarget(ref, target, cached);
  if (!analysis) return null;
  const related = relatedTokenText(target, analysis);
  return {
    summary: analysis.meaning
      ? `${target.text} 在句中表示：${analysis.meaning}`
      : `${target.text} 在这句中要结合上下文理解。`,
    points: [
      analysis.role ? `成分：${analysis.role}` : "",
      analysis.spanText && analysis.spanText !== target.text ? `关联片段：${analysis.spanText}` : "",
      related ? `需要一起看：${related}` : "",
    ].filter(Boolean),
    examples: [{
      sentence: target.sentence,
      breakdown: analysis.explanation || cached.sentenceSummary || cached.summary,
      memoryTip: analysis.memoryTip || "",
    }],
    fromPrecache: true,
    promptVersion: AI_PROMPT_VERSION,
  };
}

function tokenAnalysisForTarget(ref, target, cached = sentencePrecacheForTarget(ref, target)) {
  if (!cached || target?.type !== "word") return null;
  const tokenIndex = Number(target.tokenIndex);
  return cached.tokenAnalyses.find((item) => item.tokenIndex === tokenIndex)
    || cached.tokenAnalyses.find((item) => item.text === target.text)
    || cached.tokenAnalyses.find((item) => item.spanText && item.spanText.includes(target.text));
}

function relatedTokenText(target, analysis) {
  const tokens = target.tokens || [];
  return (analysis.dependsOn || [])
    .filter((index) => index !== target.tokenIndex && tokens[index])
    .map((index) => tokens[index])
    .join("");
}

function relatedTokenIndexesForSelection(ref, exampleIndex) {
  const selected = selectedGrammarTargetForRef(ref);
  if (selected?.type !== "word" || selected.exampleIndex !== exampleIndex) return new Set();
  const analysis = tokenAnalysisForTarget(ref, selected);
  if (!analysis) return new Set();
  return new Set((analysis.dependsOn || []).filter((index) => index !== selected.tokenIndex));
}

function hasPrecacheInFlightForRef(ref) {
  for (const key of aiPrecacheInFlight.keys()) {
    if (key.startsWith(`${ref}:sentence-cache:`)) return true;
  }
  return false;
}

function maskApiKey(value) {
  const key = String(value || "");
  if (key.length <= 10) return "已保存";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function scheduleGrammarTokenSelection(target, event) {
  window.clearTimeout(grammarSelectionTimer);
  if (event?.detail >= 2) return;
  grammarSelectionTimer = window.setTimeout(() => {
    const ref = target.dataset.entryRef;
    const exampleIndex = Number(target.dataset.exampleIndex);
    const tokenIndex = Number(target.dataset.tokenIndex);
    const example = grammarExampleForRef(ref, exampleIndex);
    if (!example) return;
    const tokens = grammarTokensForExample(example);
    const context = grammarTokenContext(tokens, tokenIndex);
    selectGrammarTarget({
      ref,
      type: "word",
      exampleIndex,
      tokenIndex,
      text: target.dataset.tokenText || target.textContent || "",
      sentence: example.japanese,
      translation: example.translation,
      tokens: tokens.map((token) => token.text),
      beforeText: context.beforeText,
      afterText: context.afterText,
      candidateSpan: context.candidateSpan,
    });
  }, 320);
}

function selectGrammarSentence(target) {
  window.clearTimeout(grammarSelectionTimer);
  const ref = target.dataset.entryRef;
  const exampleIndex = Number(target.dataset.exampleIndex);
  const example = grammarExampleForRef(ref, exampleIndex);
  if (!example) return;
  const tokens = grammarTokensForExample(example);
  selectGrammarTarget({
    ref,
    type: "sentence",
    exampleIndex,
    tokenIndex: null,
    text: example.japanese,
    sentence: example.japanese,
    translation: example.translation,
    tokens: tokens.map((token) => token.text),
    beforeText: "",
    afterText: "",
    candidateSpan: example.japanese,
  });
}

function selectGrammarTarget(target) {
  app.selectedExampleRef = target.ref;
  app.selectedExampleIndex = target.exampleIndex;
  app.selectedGrammarTarget = target;
  app.aiMessage = "";
  requestGrammarAi(target.ref);
}

function refreshGrammarAi(ref) {
  const target = selectedGrammarTargetForRef(ref);
  if (!target) {
    app.aiMessage = "请先单击词语或双击整句。";
    render();
    return;
  }
  delete app.state.aiExplanations[aiCacheKey(ref)];
  const sentenceKey = aiSentenceCacheKey(ref, target.exampleIndex);
  if (sentenceKey) delete app.state.aiExplanations[sentenceKey];
  saveState();
  requestGrammarAi(ref, { forceSentence: true });
}

async function requestGrammarAi(ref, options = {}) {
  const entry = entryForRef(ref);
  const content = app.state.grammarContent[ref]?.text || "";
  if (!entry || !content.trim()) return;
  const target = selectedGrammarTargetForRef(ref);
  if (!target) {
    app.aiMessage = "请先单击词语或双击整句。";
    app.aiLoadingRef = ref;
    render();
    window.setTimeout(() => {
      app.aiLoadingRef = null;
      app.aiMessage = "";
      render();
    }, 1800);
    return;
  }

  const cacheKey = aiCacheKey(ref);
  if (!options.forceSentence && app.state.aiExplanations[cacheKey]) {
    render();
    return;
  }
  if (!options.forceSentence) {
    const precomputed = aiResultFromSentencePrecache(ref, target);
    if (precomputed) {
      app.state.aiExplanations[cacheKey] = {
        ...precomputed,
        target: target.type === "word" ? `word-${target.text}` : `sentence-${target.exampleIndex}`,
        createdAt: new Date().toISOString(),
      };
      saveState();
      render();
      return;
    }
  }
  if (!hasConfiguredAi()) {
    app.aiMessage = "请先在用户中心粘贴 AI API Key。";
    render();
    return;
  }

  app.aiLoadingRef = ref;
  app.aiMessage = target.type === "word"
    ? `正在等待例句预分析：${target.text}`
    : "正在等待整句预分析...";
  render();
  try {
    try {
      await prefetchGrammarExampleAnalysis(ref, target.exampleIndex, { force: options.forceSentence });
    } catch (precacheError) {
      console.warn("Grammar sentence precache failed, falling back to focused analysis", precacheError);
    }
    const precomputed = aiResultFromSentencePrecache(ref, target);
    if (precomputed) {
      app.state.aiExplanations[cacheKey] = {
        ...precomputed,
        target: target.type === "word" ? `word-${target.text}` : `sentence-${target.exampleIndex}`,
        createdAt: new Date().toISOString(),
      };
      app.aiMessage = "";
      saveState();
      return;
    }
    await requestFocusedGrammarAi(ref, target, entry, cacheKey);
    app.aiMessage = "";
    saveState();
  } catch (error) {
    app.aiMessage = formatAiException(error, "AI 代理请求失败。");
  } finally {
    app.aiLoadingRef = null;
    render();
  }
}

async function requestFocusedGrammarAi(ref, target, entry, cacheKey) {
  app.aiMessage = target.type === "word" ? `正在补充分析词语：${target.text}` : "正在补充分析整句...";
  let response;
  try {
    response = await fetch("/api/grammar-ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...aiCredentialsPayload(),
        ref,
        analysisMode: "selection",
        promptVersion: AI_PROMPT_VERSION,
        level: entry.level,
        number: entry.number,
        title: entry.title,
        selectionType: target.type,
        selectedText: target.text,
        tokenIndex: target.tokenIndex,
        tokens: target.tokens || [],
        beforeText: target.beforeText || "",
        afterText: target.afterText || "",
        candidateSpan: target.candidateSpan || target.text,
        selectedExampleIndex: target.exampleIndex,
        examples: [{
          japanese: target.sentence,
          translation: target.translation || "",
          source: "pdf-example",
        }],
      }),
    });
  } catch (error) {
    throw new Error(formatAiException(error));
  }
  const payload = await readJsonPayload(response);
  if (!response.ok) {
    throw new Error(formatAiPayloadError(payload, "AI 代理请求失败"));
  }
  app.state.aiExplanations[cacheKey] = {
    ...payload,
    target: target.type === "word" ? `word-${target.text}` : `sentence-${target.exampleIndex}`,
    createdAt: new Date().toISOString(),
  };
}

function startGrammarSession(mode) {
  const view = mode === "review" ? "grammar-review" : "grammar-study";
  const queue = grammarQueueForView(view);
  app.view = view;
  app.selectedGrammarRef = queue[0]?.ref || null;
  app.flashcardAnswerVisible = false;
  render();
}

function completeGrammarEntry(ref) {
  scheduleGrammarReview(ref);
}

function rememberGrammarEntry(ref) {
  scheduleGrammarReview(ref);
}

function scheduleGrammarReview(ref) {
  if (!ref) return;
  const progress = grammarProgressFor(ref);
  const stage = Math.max(0, Number(progress.reviewStage) || 0);
  const interval = REVIEW_INTERVALS[Math.min(stage, REVIEW_INTERVALS.length - 1)];
  const now = new Date().toISOString();
  app.state.grammarProgress[ref] = {
    ...progress,
    status: "review",
    reviewStage: Math.min(stage + 1, REVIEW_INTERVALS.length),
    dueDate: addDays(clampDate(todayIso(), START_DATE, END_DATE), interval),
    lastReviewedAt: now,
    masteredAt: null,
    updatedAt: now,
  };
  app.flashcardAnswerVisible = false;
  saveState();
  selectNextGrammarAfter(ref);
  render();
}

function masterGrammarEntry(ref) {
  if (!ref) return;
  const progress = grammarProgressFor(ref);
  const now = new Date().toISOString();
  app.state.grammarProgress[ref] = {
    ...progress,
    status: "mastered",
    dueDate: null,
    masteredAt: now,
    updatedAt: now,
  };
  app.flashcardAnswerVisible = false;
  saveState();
  selectNextGrammarAfter(ref);
  render();
}

function forgetGrammarEntry(ref) {
  if (!ref) return;
  const progress = grammarProgressFor(ref);
  const now = new Date().toISOString();
  app.state.grammarProgress[ref] = {
    ...progress,
    status: "learning",
    reviewStage: 0,
    dueDate: clampDate(todayIso(), START_DATE, END_DATE),
    masteredAt: null,
    updatedAt: now,
  };
  app.flashcardAnswerVisible = false;
  saveState();
  selectNextGrammarAfter(ref);
  render();
}

function relearnGrammarEntry(ref) {
  if (!ref) return;
  const progress = grammarProgressFor(ref);
  const now = new Date().toISOString();
  app.state.grammarProgress[ref] = {
    ...progress,
    status: "learning",
    reviewStage: 0,
    dueDate: clampDate(todayIso(), START_DATE, END_DATE),
    masteredAt: null,
    updatedAt: now,
  };
  app.selectedGrammarRef = ref;
  app.flashcardAnswerVisible = false;
  saveState();
  app.view = "grammar-study";
  render();
}

function selectNextGrammarAfter(ref) {
  const queue = grammarQueueForView(app.view);
  if (app.view !== "grammar-study" && app.view !== "grammar-review") {
    app.selectedGrammarRef = ref;
    return;
  }
  if (!queue.length) {
    app.selectedGrammarRef = null;
    return;
  }
  if (queue.some((item) => item.ref === ref)) {
    app.selectedGrammarRef = ref;
    return;
  }
  app.selectedGrammarRef = queue[0].ref;
}

function grammarQueueForView(view) {
  const plan = currentPlan();
  if (view === "grammar-review") return grammarReviewQueueForDate(app.selectedDate, plan);
  if (view === "grammar-study") return grammarLearningQueueForDate(app.selectedDate, plan);
  return grammarQueueForDate(app.selectedDate, plan);
}

function currentPlan() {
  return buildRollingPlan(buildPlan(app.state.catalog, studyProfile()), app.state.statuses, app.state.settings, todayIso());
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
  if (task.type === "diagnostic") return 15;
  if (task.type === "grammar" && task.mode === "new") return 20;
  if (task.type === "grammar" && task.mode === "review") return 25;
  if (isRollover && (task.type === "reading" || task.type === "listening")) return 30;
  if (task.type === "reading" || task.type === "listening") return 40;
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

function diagnosticTask(date, levels) {
  const label = `${levels.join("/")} 文法查漏复盘`;
  return {
    id: `diagnostic-${date}-${hashRefs(levels)}`,
    type: "diagnostic",
    kindLabel: "查漏",
    label,
    detail: "当前水平及以下不大规模重学；用搜索和 PDF 快速抽查薄弱句型，低信心条目重新加入学习池。",
    estimatedMinutes: 24,
    items: [
      `${levels.join(" / ")} 快速回忆接续`,
      "搜索 3-5 个模糊句型",
      "低信心文法点进重新学习",
    ],
  };
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

function readingTask(date, plan) {
  const source = pastPaperSource(date, 0, null, plan);
  const section = READING_SECTIONS[dateIndex(date) % READING_SECTIONS.length];
  const minutes = { N5: 22, N4: 26, N3: 30, N2: 36, N1: 40 }[source.level] || 32;
  return {
    id: `reading-${date}-${source.level}-${source.year}-${section}`,
    type: "reading",
    kindLabel: "阅读",
    label: `${source.level} ${source.year} 年真题阅读：${section}`,
    detail: `资料在 MOJi Test。点击按钮打开网页端，进入试卷库/真题 → ${source.level} → ${source.year} 年，完成阅读「${section}」板块并记录错因。`,
    estimatedMinutes: minutes,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: ["MOJi Test", `${source.level} ${source.year}`, `阅读 ${section}`, "限时完成", "错因：词汇/句型/定位/推理"],
  };
}

function listeningTask(date, plan) {
  const source = pastPaperSource(date, 0, null, plan);
  const section = LISTENING_SECTIONS[(dateIndex(date) + 1) % LISTENING_SECTIONS.length];
  const minutes = { N5: 20, N4: 24, N3: 26, N2: 32, N1: 36 }[source.level] || 28;
  return {
    id: `listening-${date}-${source.level}-${source.year}-${section}`,
    type: "listening",
    kindLabel: "听力",
    label: `${source.level} ${source.year} 年真题听力：${section}`,
    detail: `资料在 MOJi Test。点击按钮打开网页端，进入试卷库/真题 → ${source.level} → ${source.year} 年，完成听力「${section}」板块；错题只重听关键句。`,
    estimatedMinutes: minutes,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: ["MOJi Test", `${source.level} ${source.year}`, `听力 ${section}`, "第一遍答题", "第二遍错题重听"],
  };
}

function mockTask(date, plan) {
  const reviewStart = (plan.phaseDates?.review || [date])[0] || date;
  const setNumber = Math.floor((dateIndex(date) - dateIndex(reviewStart)) / 3) + 1;
  const isFull = dateIndex(date) % 3 === 0;
  const targetLevel = (plan.profile || studyProfile()).targetLevel;
  const source = pastPaperSource(date, setNumber, targetLevel, plan);
  return {
    id: `mock-${date}-${source.level}-${source.year}`,
    type: "mock",
    kindLabel: "模拟",
    label: isFull ? `MOJi Test ${source.level} ${source.year} 年真题套卷` : `MOJi Test ${source.level} ${source.year} 年弱项重刷`,
    detail: isFull
      ? `点击按钮打开 MOJi Test，按 ${source.level} 考试时间切块完成语言知识/阅读和听力；记录三项分数和低于合格线风险项。`
      : "点击按钮打开 MOJi Test，只重刷上一轮错得多的板块：阅读定位、听力关键词、或语言知识错题；不要开新资料。",
    estimatedMinutes: isFull ? 155 : 55,
    externalUrl: MOJI_TEST_URL,
    externalLabel: "打开 MOJi Test",
    items: isFull ? ["MOJi Test", `${source.level} ${source.year}`, "语言知识/阅读", "听力", "记录分项分数"] : ["MOJi Test", `${source.level} ${source.year}`, "错题重做", "同题型加练"],
  };
}

function reviewItems(plan) {
  const firstDate = plan.dates?.[0] || START_DATE;
  const lastDate = plan.dates?.[plan.dates.length - 1] || END_DATE;
  const today = clampDate(todayIso(), firstDate, lastDate);
  const orderedDates = [...dateRange(today, lastDate), ...dateRange(firstDate, addDays(today, -1))];
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

function phaseForDate(date, plan = currentPlan()) {
  return plan.phaseByDate?.[date] || { kind: "study", level: (plan.profile || studyProfile()).targetLevel };
}

function phaseLevel(date, plan = currentPlan()) {
  return phaseForDate(date, plan).level || (plan.profile || studyProfile()).targetLevel;
}

function phaseLabel(date, plan = currentPlan()) {
  const phase = phaseForDate(date, plan);
  if (phase.kind === "diagnostic") return `${(phase.levels || []).join("/")} 查漏复盘`;
  if (phase.kind === "review") return `${(plan.profile || studyProfile()).targetLevel} 真题型与考前总复盘`;
  return `${phase.level || (plan.profile || studyProfile()).targetLevel} 主路径学习`;
}

function grammarMinutes(level) {
  return { N5: 7, N4: 8, N3: 10, N2: 13, N1: 15 }[level] || 10;
}

function vocabCountForDate(date, plan = currentPlan()) {
  const level = phaseLevel(date, plan);
  const dailyMinutes = Number((plan.profile || studyProfile()).dailyMinutes) || DEFAULT_DAILY_MINUTES;
  const base = { N5: 20, N4: 25, N3: 35, N2: 40, N1: 45 }[level] || 30;
  const multiplier = dailyMinutes < 90 ? 0.6 : dailyMinutes < 150 ? 0.85 : dailyMinutes >= 240 ? 1.2 : 1;
  const reviewBoost = phaseForDate(date, plan).kind === "review" ? 1.1 : 1;
  return Math.max(10, Math.round(base * multiplier * reviewBoost));
}

function vocabCountForTasks(tasks) {
  return tasks
    .filter((task) => task.type === "vocab" && statusFor(task).status !== "done")
    .reduce((sum, task) => sum + (task.vocabCount || 0), 0);
}

function pastPaperSource(date, offset = 0, forcedLevel = null, plan = currentPlan()) {
  const level = forcedLevel || phaseLevel(date, plan);
  const years = PAST_PAPER_YEARS[level] || PAST_PAPER_YEARS.DEFAULT || range(2010, 2024);
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
  anchor.download = "jlpt-bluebook-agent-progress.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

function importState() {
  const box = document.querySelector("#importBox");
  if (!box || !box.value.trim()) return;
  try {
    const imported = JSON.parse(box.value);
    if (Array.isArray(imported.catalog)) {
      app.state = normalizeSavedState({ ...app.state, ...imported, pdf: { ...DEFAULT_PDF, ...(imported.pdf || app.state.pdf) } });
    } else {
      app.state = { ...app.state, catalog: imported };
    }
    saveState();
    render();
    if (hasMissingGrammarContent()) ensureGrammarContent(false);
  } catch (error) {
    box.value = `JSON 解析失败：${error.message}`;
  }
}

function resetProgress() {
  app.state.statuses = {};
  app.state.notes = {};
  app.state.grammarProgress = {};
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
  total += app.state.catalog.length;
  done += orderedGrammarEntries().filter((entry) => {
    const progress = grammarProgressFor(entryRef(entry));
    return progress.status === "review" || progress.status === "mastered";
  }).length;
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

function formatGrammarContent(text, ref) {
  const blocks = grammarContentBlocks(text);
  if (!blocks.length) return "";
  return blocks.map((block) => {
    if (block.type === "heading") {
      return `<h4 class="grammar-section-title">${escapeHtml(block.text)}</h4>`;
    }
    if (block.type === "example") {
      const selected = selectedGrammarTargetForRef(ref);
      const isSentenceSelected = selected?.type === "sentence" && selected.exampleIndex === block.exampleIndex;
      return `
        <div class="grammar-example ${isSentenceSelected ? "selected sentence-selected" : ""}" data-entry-ref="${ref}" data-example-index="${block.exampleIndex}">
          <span class="example-mark">例句 ${block.exampleIndex + 1}</span>
          <span class="example-japanese">${formatSelectableJapanese(block.japanese, ref, block.exampleIndex)}</span>
          ${block.source ? `<span class="example-source">${escapeHtml(block.source)}</span>` : ""}
          ${block.translation ? `<span class="example-translation">${escapeHtml(block.translation)}</span>` : ""}
        </div>
      `;
    }
    return `<p>${escapeHtml(block.text)}</p>`;
  }).join("");
}

function grammarContentBlocks(text) {
  const lines = normalizeExtractedText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const blocks = [];
  let exampleIndex = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] || "";
    if (isFuriganaPrelude(line, next)) continue;
    if (isGrammarSectionHeading(line)) {
      blocks.push({ type: "heading", text: line });
      continue;
    }
    if (/^△/.test(line)) {
      const exampleLines = [line.replace(/^△\s*/, "")];
      while (index + 1 < lines.length && !isGrammarSectionHeading(lines[index + 1]) && !/^△/.test(lines[index + 1]) && !looksEntryMarker(lines[index + 1])) {
        index += 1;
        exampleLines.push(lines[index]);
      }
      const example = splitGrammarExample(exampleLines.join(""));
      blocks.push({ type: "example", exampleIndex, ...example });
      exampleIndex += 1;
      continue;
    }
    if (!isLikelyNoiseLine(line)) {
      blocks.push({ type: "paragraph", text: line });
    }
  }
  return mergeParagraphBlocks(blocks);
}

function grammarContentExamples(ref) {
  const text = app.state.grammarContent[ref]?.text || "";
  return grammarContentBlocks(text)
    .filter((block) => block.type === "example")
    .map((block) => ({
      index: block.exampleIndex,
      japanese: block.japanese,
      translation: block.translation,
      sourceLabel: block.source,
    }));
}

function formatSelectableJapanese(text, ref, exampleIndex) {
  const relatedIndexes = relatedTokenIndexesForSelection(ref, exampleIndex);
  return tokenizeJapaneseText(text)
    .map((token, tokenIndex) => {
      if (!token.text.trim()) return escapeHtml(token.text);
      if (token.isPunctuation) return `<span class="jp-punctuation">${escapeHtml(token.text)}</span>`;
      const selected = selectedGrammarTargetForRef(ref);
      const isSelected = selected?.type === "word" && selected.exampleIndex === exampleIndex && selected.tokenIndex === tokenIndex;
      const isRelated = relatedIndexes.has(tokenIndex);
      return `<span class="jp-token ${isSelected ? "selected" : ""} ${isRelated ? "related" : ""}" data-action="select-grammar-example" data-entry-ref="${ref}" data-example-index="${exampleIndex}" data-token-index="${tokenIndex}" data-token-text="${escapeAttr(token.text)}">${escapeHtml(token.text)}</span>`;
    })
    .join("");
}

function tokenizeJapaneseText(text) {
  const value = String(text || "");
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter("ja", { granularity: "word" });
    return Array.from(segmenter.segment(value)).map((segment) => ({
      text: segment.segment,
      isPunctuation: isPunctuationToken(segment.segment),
    }));
  }
  return (value.match(/[一-龯々〆〤]+|[ぁ-んー]+|[ァ-ヶー]+|[A-Za-z0-9]+|[^\s]/g) || [])
    .map((text) => ({ text, isPunctuation: isPunctuationToken(text) }));
}

function grammarTokenContext(tokens, tokenIndex) {
  const normalizedTokens = tokens.map((token) => typeof token === "string" ? { text: token, isPunctuation: isPunctuationToken(token) } : token);
  const effectiveIndex = clampNumber(tokenIndex, 0, Math.max(0, normalizedTokens.length - 1));
  const beforeText = normalizedTokens.slice(Math.max(0, effectiveIndex - 5), effectiveIndex).map((token) => token.text).join("");
  const afterTokens = [];
  for (let index = effectiveIndex + 1; index < normalizedTokens.length && afterTokens.length < 8; index += 1) {
    const token = normalizedTokens[index];
    if (token.isPunctuation) break;
    afterTokens.push(token.text);
  }
  const candidateTokens = [normalizedTokens[effectiveIndex]?.text || "", ...afterTokens.slice(0, 4)].filter(Boolean);
  return {
    beforeText,
    afterText: afterTokens.join(""),
    candidateSpan: candidateTokens.join(""),
  };
}

function isPunctuationToken(text) {
  return /^[\s。、，,.！？!?「」『』（）()【】\[\]：:；;・/]+$/.test(text);
}

function selectedGrammarTargetForRef(ref) {
  return app.selectedGrammarTarget?.ref === ref ? app.selectedGrammarTarget : null;
}

function splitGrammarExample(text) {
  const value = normalizeInlineText(text);
  const slashIndex = value.indexOf("/");
  const japanese = stripExampleSource(slashIndex >= 0 ? value.slice(0, slashIndex) : value);
  const translation = slashIndex >= 0 ? value.slice(slashIndex + 1) : "";
  return {
    japanese: normalizeInlineText(japanese.text),
    translation: normalizeInlineText(translation),
    source: japanese.source,
  };
}

function stripExampleSource(text) {
  let value = normalizeInlineText(text);
  let source = "";
  const sourcePattern = /\s*([【\[\(（［]\s*(?:19|20)\d{2}\s*年?\s*真\s*[题題]\s*[】\]\)）］])\s*$/u;
  const match = value.match(sourcePattern);
  if (match) {
    source = normalizeInlineText(match[1]);
    value = normalizeInlineText(value.slice(0, match.index));
  }
  return { text: value, source };
}

function isGrammarSectionHeading(line) {
  return /^(接续|说明|例文|注意)\d*$/.test(line);
}

function looksEntryMarker(line) {
  return /^\d{1,3}\.\s*～/.test(line);
}

function isFuriganaPrelude(line, next) {
  return /^△/.test(next) && !/[。！？/「」『』【】]/.test(line) && /[ぁ-んァ-ヶ]/.test(line);
}

function isLikelyNoiseLine(line) {
  return /^[\f\s]+$/.test(line);
}

function mergeParagraphBlocks(blocks) {
  const result = [];
  for (const block of blocks) {
    const last = result[result.length - 1];
    if (block.type === "paragraph" && last?.type === "paragraph") {
      last.text = normalizeInlineText(`${last.text}${block.text}`);
    } else {
      result.push({ ...block });
    }
  }
  return result;
}

function normalizeInlineText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([。！？、，；：])/g, "$1")
    .trim();
}

function aiCacheKey(ref) {
  const target = selectedGrammarTargetForRef(ref);
  const salt = aiProviderCacheSalt();
  return target ? `${ref}:${salt}:${AI_PROMPT_VERSION}:${target.type}:${target.exampleIndex}:${target.tokenIndex ?? "sentence"}:${hashRefs([target.text, target.candidateSpan || ""])}` : `${ref}:${salt}:${AI_PROMPT_VERSION}:none`;
}

function aiSentenceCacheKey(ref, exampleIndex) {
  const example = grammarExampleForRef(ref, exampleIndex);
  if (!example?.japanese) return "";
  const tokens = grammarTokensForExample(example).map((token) => token.text).join("|");
  return `${ref}:sentence-cache:${aiProviderCacheSalt()}:${AI_PROMPT_VERSION}:${example.index}:${hashRefs([example.japanese, tokens])}`;
}

function aiProviderCacheSalt() {
  const payload = aiCredentialsPayload();
  return `${payload.provider || DEFAULT_AI_PROVIDER}:${payload.model || ""}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
