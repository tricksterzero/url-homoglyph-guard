// 文言ファイル（_locales/*/messages.json）の整合性を確かめる。
// 使い方: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXTENSION = path.join(__dirname, "../extension");
const LOCALES = ["en", "ja"];
const messages = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(fs.readFileSync(path.join(EXTENSION, "_locales", locale, "messages.json"), "utf8")),
  ])
);

function placeholderNames(entry) {
  return [...entry.message.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1].toLowerCase()).sort();
}

test("英語と日本語で同じ文言の項目がそろっている", () => {
  assert.deepEqual(Object.keys(messages.ja).sort(), Object.keys(messages.en).sort());
});

test("差し込み位置がすべて定義され、言語間で同じ内容を差し込む", () => {
  for (const key of Object.keys(messages.en)) {
    for (const locale of LOCALES) {
      const entry = messages[locale][key];
      const used = placeholderNames(entry);
      const defined = Object.keys(entry.placeholders ?? {}).sort();
      assert.deepEqual([...new Set(used)].sort(), defined, `${locale}.${key}`);
    }
    const content = (locale) =>
      Object.fromEntries(Object.entries(messages[locale][key].placeholders ?? {}).map(([n, p]) => [n, p.content]));
    assert.deepEqual(content("ja"), content("en"), key);
  }
});

test("ページとスクリプトが使う文言がすべて定義されている", () => {
  const used = new Set();
  for (const file of ["warning/warning.html", "setup/setup.html"]) {
    const html = fs.readFileSync(path.join(EXTENSION, file), "utf8");
    for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) used.add(m[1]);
  }
  for (const file of ["warning/warning.js", "setup/setup.js"]) {
    const js = fs.readFileSync(path.join(EXTENSION, file), "utf8");
    for (const m of js.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    for (const m of js.matchAll(/t\(\s*\w+\s*\?\s*"([A-Za-z0-9_]+)"\s*:\s*"([A-Za-z0-9_]+)"/g)) {
      used.add(m[1]);
      used.add(m[2]);
    }
  }
  const manifest = fs.readFileSync(path.join(EXTENSION, "manifest.json"), "utf8");
  for (const m of manifest.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  const missing = [...used].filter((key) => !(key in messages.en));
  assert.deepEqual(missing, []);
  assert.ok(used.size > 30, `検出した文言が少なすぎる: ${used.size}`);
});
