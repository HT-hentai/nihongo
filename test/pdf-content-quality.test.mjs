import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { catalogFromOutline } from "../src/pdf-catalog.mjs";
import {
  analyzeEntryText,
  grammarContentBlocks,
  normalizeExtractedText,
} from "../src/grammar-content.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PDF_PATH = resolve(ROOT, "public/materials/bluebooks/bluebook-n1-n5-grammar.pdf");

test("bluebook PDF catalog and extracted grammar content stay usable", { timeout: 60000 }, async () => {
  const pdf = await loadPdf();
  const catalog = await catalogFromOutline(await pdf.getOutline(), pdf);
  assert.equal(catalog.length, 739);
  assert.deepEqual(countByLevel(catalog), {
    N1: 198,
    N2: 152,
    N3: 139,
    N4: 130,
    N5: 120,
  });

  const pageCache = new Map();
  const stats = {
    empty: [],
    warnings: [],
    noExamples: [],
    examples: 0,
  };

  for (let index = 0; index < catalog.length; index += 1) {
    const entry = catalog[index];
    const next = catalog[index + 1]?.level === entry.level ? catalog[index + 1] : null;
    const text = await rawEntryText(pdf, entry, next, pageCache);
    const analysis = analyzeEntryText(text, entry, next);
    const blocks = grammarContentBlocks(analysis.text);
    const examples = blocks.filter((block) => block.type === "example").length;

    stats.examples += examples;
    if (!analysis.text.trim()) stats.empty.push(entry.id);
    if (analysis.warnings.length) stats.warnings.push({ ref: entry.id, warnings: analysis.warnings });
    if (!examples) stats.noExamples.push(entry.id);
  }

  assert.deepEqual(stats.empty, []);
  assert.deepEqual(stats.warnings, []);
  assert.deepEqual(stats.noExamples, ["N5-13", "N5-14", "N5-15", "N5-16", "N5-17", "N5-18", "N5-23"]);
  assert.ok(stats.examples >= 2400, `expected at least 2400 examples, got ${stats.examples}`);
});

async function loadPdf() {
  const pdfjs = await import("../public/vendor/pdfjs/pdf.mjs");
  const data = new Uint8Array(readFileSync(PDF_PATH));
  return pdfjs.getDocument({ data, disableWorker: true }).promise;
}

function countByLevel(entries) {
  return entries.reduce((counts, entry) => {
    counts[entry.level] = (counts[entry.level] || 0) + 1;
    return counts;
  }, {});
}

async function rawEntryText(pdf, entry, next, pageCache) {
  const startPage = clampNumber(entry.page || 1, 1, pdf.numPages);
  const endPage = next?.page
    ? clampNumber(Math.max(startPage, next.page), startPage, pdf.numPages)
    : clampNumber(startPage + 2, startPage, pdf.numPages);
  const texts = [];
  for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
    texts.push(await pageText(pdf, pageNumber, pageCache));
  }
  return texts.join("\n\n");
}

async function pageText(pdf, pageNumber, pageCache) {
  if (!pageCache.has(pageNumber)) {
    pageCache.set(pageNumber, extractPageText(await pdf.getPage(pageNumber)));
  }
  return pageCache.get(pageNumber);
}

async function extractPageText(page) {
  const content = await page.getTextContent();
  const items = content.items
    .map((item) => ({
      text: normalizeInlineText(item.str || ""),
      x: item.transform ? item.transform[4] : 0,
      y: item.transform ? item.transform[5] : 0,
    }))
    .filter((item) => item.text);
  items.sort((a, b) => Math.round(b.y) - Math.round(a.y) || a.x - b.x);

  const lines = [];
  for (const item of items) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - item.y) > 3) {
      lines.push({ y: item.y, parts: [item] });
    } else {
      last.parts.push(item);
    }
  }

  return normalizeExtractedText(lines
    .map((line) => line.parts.sort((a, b) => a.x - b.x).map((part) => part.text).join(""))
    .join("\n"));
}

function normalizeInlineText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
