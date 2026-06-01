export function analyzeEntryText(text, entry, next) {
  let value = normalizeExtractedText(text);
  const warnings = [];
  const start = findEntryMarker(value, entry);
  const startFound = start >= 0;
  if (startFound) {
    value = value.slice(start);
  } else {
    warnings.push("start_marker_missing");
  }

  let nextFound = false;
  if (next) {
    const searchOffset = Math.min(value.length, 20);
    const nextIndex = findEntryMarker(value.slice(searchOffset), next);
    if (nextIndex >= 0) {
      value = value.slice(0, searchOffset + nextIndex);
      nextFound = true;
    } else {
      warnings.push("next_marker_missing");
    }
  }

  value = normalizeExtractedText(value);
  if (!value) warnings.push("empty_text");
  return { text: value, warnings, startFound, nextFound };
}

export function grammarContentBlocks(text) {
  const lines = normalizeExtractedText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const blocks = [];
  let exampleIndex = 0;
  let pendingFurigana = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] || "";
    if (isFuriganaPrelude(line, next)) {
      pendingFurigana = normalizeInlineText(line);
      continue;
    }
    if (isGrammarSectionHeading(line)) {
      blocks.push({ type: "heading", text: line });
      pendingFurigana = "";
      continue;
    }
    if (/^△/.test(line)) {
      const exampleLines = [line.replace(/^△\s*/, "")];
      while (index + 1 < lines.length) {
        const candidate = lines[index + 1];
        const following = lines[index + 2] || "";
        if (shouldStopExampleBeforeLine(exampleLines, candidate, following)) break;
        index += 1;
        exampleLines.push(lines[index]);
      }
      const example = splitGrammarExample(exampleLines.join(""));
      blocks.push({
        type: "example",
        exampleIndex,
        furigana: example.rubySpans.length ? "" : pendingFurigana,
        ...example,
      });
      pendingFurigana = "";
      exampleIndex += 1;
      continue;
    }
    if (!isLikelyNoiseLine(line)) {
      blocks.push({ type: "paragraph", text: line });
      pendingFurigana = "";
    }
  }
  return mergeParagraphBlocks(blocks);
}

export function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitGrammarExample(text) {
  const value = normalizeInlineText(text);
  const slashIndex = value.indexOf("/");
  const japanese = stripExampleSource(slashIndex >= 0 ? value.slice(0, slashIndex) : value);
  const translation = slashIndex >= 0 ? value.slice(slashIndex + 1) : "";
  const japaneseText = rubyText(japanese.text);
  return {
    japanese: normalizeInlineText(japaneseText.text),
    rubySpans: japaneseText.rubySpans,
    translation: cleanExampleTranslation(translation),
    source: japanese.source,
  };
}

export function rubyText(value) {
  const rubySpans = [];
  let text = "";
  let cursor = 0;
  const pattern = /\[\[ruby:([^|\]]+)\|([^\]]+)\]\]/g;
  for (const match of String(value || "").matchAll(pattern)) {
    const before = value.slice(cursor, match.index);
    text += before;
    const base = normalizeInlineText(match[1]);
    const reading = normalizeInlineText(match[2]);
    const start = text.length;
    text += base;
    if (base && reading) {
      rubySpans.push({ start, end: start + base.length, text: base, reading });
    }
    cursor = match.index + match[0].length;
  }
  text += String(value || "").slice(cursor);
  return { text, rubySpans };
}

export function findEntryMarker(text, entry) {
  const number = Number(entry?.number);
  if (!Number.isInteger(number)) return -1;
  const match = new RegExp(`(^|\\n)\\s*${number}\\s*[.．、]\\s*`, "m").exec(String(text || ""));
  return match ? match.index + match[1].length : -1;
}

function shouldStopExampleBeforeLine(exampleLines, candidate, following) {
  if (!candidate) return true;
  if (isGrammarSectionHeading(candidate) || /^△/.test(candidate) || looksEntryMarker(candidate)) return true;
  if (collectedHasTranslation(exampleLines) && isFuriganaPrelude(candidate, following)) return true;
  return false;
}

function collectedHasTranslation(exampleLines) {
  return /\/\s*\S/.test(exampleLines.join(""));
}

function cleanExampleTranslation(text) {
  return normalizeInlineText(text)
    .replace(/([。！？!?])\s*[ぁ-んァ-ヶー]{4,}$/u, "$1")
    .trim();
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
  return /^\d{1,3}\s*[.．、]\s*～/.test(line);
}

function isFuriganaPrelude(line, next) {
  return looksLikeFuriganaPreludeLine(line) && /^△/.test(next);
}

function looksLikeFuriganaPreludeLine(line) {
  const value = normalizeInlineText(line);
  return value.length >= 4
    && /^[ぁ-んァ-ヶー\s]+$/u.test(value)
    && !/[。！？/「」『』【】]/.test(value);
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
