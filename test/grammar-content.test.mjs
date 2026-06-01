import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeEntryText,
  grammarContentBlocks,
  rubyText,
  splitGrammarExample,
} from "../src/grammar-content.mjs";

test("grammar examples stop before the next furigana prelude", () => {
  const blocks = grammarContentBlocks(`
1.～ず（に）
接续
动词「ない形」＋ず（に）
例文
きのういそがよるじゅうじなにたはたら
△昨日は忙しくて、夜10時まで何も食べずに働いた。【2009年真题】/昨天太忙了，什么都没吃一直工作到晚上十点。
じしょつかにほんごしんぶんよ
△辞書を使わずに日本語の新聞を読むことができますか。【2007年真题】/你不查词典的话能读日语报纸吗？
注意
「～ず」表示否定。
  `);
  const examples = blocks.filter((block) => block.type === "example");
  assert.equal(examples.length, 2);
  assert.equal(examples[0].furigana, "きのういそがよるじゅうじなにたはたら");
  assert.equal(examples[0].translation, "昨天太忙了，什么都没吃一直工作到晚上十点。");
  assert.equal(examples[0].source, "【2009年真题】");
  assert.equal(examples[1].furigana, "じしょつかにほんごしんぶんよ");
  assert.equal(examples[1].japanese, "辞書を使わずに日本語の新聞を読むことができますか。");
});

test("inline ruby markup keeps kana suffixes out of readings", () => {
  const blocks = grammarContentBlocks(`
例文
△[[ruby:昨日|きのう]]は[[ruby:忙|いそが]]しくて、[[ruby:夜|よる]][[ruby:10|じゅう]][[ruby:時|じ]]まで[[ruby:何|なに]]も[[ruby:食|た]]べずに[[ruby:働|はたら]]いた。/昨天太忙了。
  `);
  const example = blocks.find((block) => block.type === "example");
  assert.equal(example.japanese, "昨日は忙しくて、夜10時まで何も食べずに働いた。");
  assert.deepEqual(example.rubySpans.map(({ text, reading }) => [text, reading]), [
    ["昨日", "きのう"],
    ["忙", "いそが"],
    ["夜", "よる"],
    ["10", "じゅう"],
    ["時", "じ"],
    ["何", "なに"],
    ["食", "た"],
    ["働", "はたら"],
  ]);
  assert.equal(example.translation, "昨天太忙了。");
});

test("ruby text strips internal markup to plain text", () => {
  assert.deepEqual(rubyText("[[ruby:辞書|じしょ]]を[[ruby:使|つか]]わずに"), {
    text: "辞書を使わずに",
    rubySpans: [
      { start: 0, end: 2, text: "辞書", reading: "じしょ" },
      { start: 3, end: 4, text: "使", reading: "つか" },
    ],
  });
});

test("dirty cached translations defensively drop trailing kana prelude", () => {
  const example = splitGrammarExample("昨日は忙しくて、何も食べずに働いた。/昨天太忙了。じしょつかにほんごしんぶんよ");
  assert.equal(example.translation, "昨天太忙了。");
});

test("entry analysis reports marker and truncation warnings", () => {
  const current = { level: "N4", number: 1, title: "～ず（に）" };
  const next = { level: "N4", number: 2, title: "～たがる" };
  const analysis = analyzeEntryText(`
前置噪音
1.～ず（に）
接续
动词「ない形」＋ず（に）
2.～たがる
接续
动词ます形
  `, current, next);
  assert.equal(analysis.text, "1.～ず（に）\n接续\n动词「ない形」＋ず（に）");
  assert.deepEqual(analysis.warnings, []);

  const missing = analyzeEntryText("只有正文，没有下一条", current, next);
  assert.deepEqual(missing.warnings, ["start_marker_missing", "next_marker_missing"]);
});
