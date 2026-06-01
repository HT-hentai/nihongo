import { clampNumber, todayIso } from "./date-utils.mjs";

export const START_DATE = "2026-05-01";
export const END_DATE = "2026-07-04";
export const EXAM_DATE = "2026-07-05";
export const LEVEL_ORDER = ["N5", "N4", "N3", "N2", "N1"];
export const DEFAULT_CURRENT_LEVEL = "N4";
export const DEFAULT_TARGET_LEVEL = "N2";
export const DEFAULT_DAILY_MINUTES = 240;

export function defaultStudyProfile() {
  return {
    currentLevel: DEFAULT_CURRENT_LEVEL,
    targetLevel: DEFAULT_TARGET_LEVEL,
    dailyMinutes: DEFAULT_DAILY_MINUTES,
    examDate: EXAM_DATE,
    startDate: todayIso(),
    completedAt: null,
  };
}

export function normalizeStudyProfile(onboarding, saved = {}) {
  const base = defaultStudyProfile();
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

export function levelIndex(level) {
  const index = LEVEL_ORDER.indexOf(level);
  return index === -1 ? LEVEL_ORDER.indexOf(DEFAULT_TARGET_LEVEL) : index;
}

export function diagnosticLevelsForProfile(profile = defaultStudyProfile()) {
  const targetIndex = levelIndex(profile.targetLevel);
  const currentIndex = Math.min(levelIndex(profile.currentLevel), targetIndex);
  return LEVEL_ORDER.slice(0, currentIndex + 1).filter((level) => levelIndex(level) <= targetIndex);
}

export function mainLevelsForProfile(profile = defaultStudyProfile()) {
  const targetIndex = levelIndex(profile.targetLevel);
  const currentIndex = Math.min(levelIndex(profile.currentLevel), targetIndex);
  const levels = LEVEL_ORDER.slice(currentIndex + 1, targetIndex + 1);
  return levels.length ? levels : [profile.targetLevel];
}

export function allPlanLevelsForProfile(profile = defaultStudyProfile()) {
  return Array.from(new Set([...diagnosticLevelsForProfile(profile), ...mainLevelsForProfile(profile)]));
}
