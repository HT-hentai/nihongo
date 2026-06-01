import { LEVEL_ORDER } from "./study-profile.mjs";

export async function catalogFromOutline(outline, pdf) {
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
  walk(outline || []);

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

export function parseEntryTitle(title) {
  if (/^\s*第\s*\d+\s*单元/.test(title)) return null;
  const match = title.match(/^\s*(?:第\s*)?(\d{1,3})[.．、]?\s*(.+)$/);
  if (!match) return null;
  return {
    number: Number(match[1]),
    title: cleanupTitle(match[2]),
  };
}

export function cleanupTitle(title) {
  return String(title || "")
    .replace(/\s+/g, " ")
    .replace(/[｜\u0000-\u001f]/g, "")
    .trim();
}

export async function pageFromDestination(pdf, dest) {
  if (!dest) return null;
  try {
    const explicitDest = Array.isArray(dest) ? dest : await pdf.getDestination(dest);
    if (!explicitDest || !explicitDest[0]) return null;
    const pageIndex = await pdf.getPageIndex(explicitDest[0]);
    return pageIndex + 1;
  } catch {
    return null;
  }
}

export function uniqueEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
  }
  return result;
}
