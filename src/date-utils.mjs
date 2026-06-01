export const DEFAULT_DATE_INDEX_BASE = "2026-05-01";

export function dateRange(start, end) {
  const dates = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

export function range(start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

export function addDays(date, delta) {
  const value = parseIsoDate(date);
  value.setDate(value.getDate() + delta);
  return toIsoDate(value);
}

export function parseIsoDate(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIso() {
  return toIsoDate(new Date());
}

export function clampDate(date, min, max) {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

export function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

export function dateIndex(date, startDate = DEFAULT_DATE_INDEX_BASE) {
  return Math.round((parseIsoDate(date) - parseIsoDate(startDate)) / 86400000);
}

export function daysUntil(target, from) {
  return Math.max(0, Math.round((parseIsoDate(target) - parseIsoDate(from)) / 86400000));
}

export function formatDate(date) {
  const value = parseIsoDate(date);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
}

export function formatShortDate(date) {
  const value = parseIsoDate(date);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(value);
}
