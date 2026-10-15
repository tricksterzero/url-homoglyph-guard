// 使い方: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const { domainToASCII, domainToUnicode } = require("node:url");

require("../extension/data/confusables.js");
require("../extension/data/scripts.js");
require("../extension/data/names.js");
const { decode, labelToUnicode } = require("../extension/lib/punycode.js");
const { analyzeHostname, restrictionLevel } = require("../extension/lib/detector.js");

// 以降のテストは Unicode 表記で書き、Node の URL 実装で Punycode 形式に変換してから判定する
// （ブラウザから渡されるホスト名は Punycode 形式だと実機で確認済み）。
function analyze(unicodeHost) {
  return analyzeHostname(domainToASCII(unicodeHost));
}

test("punycode: Node の domainToUnicode と同じ結果になる", () => {
  const hosts = [
    "аmazon.com",
    "аррӏе.com",
    "日本語.jp",
    "münchen.de",
    "例え.テスト",
    "pаypal-ログイン.com",
    "😀.example",
    "ελληνικά.gr",
    "مثال.إختبار",
  ];
  for (const host of hosts) {
    const ascii = domainToASCII(host);
    assert.ok(ascii.includes("xn--"), `${host} -> ${ascii}`);
    const decoded = ascii.split(".").map(labelToUnicode).join(".");
    assert.equal(decoded, domainToUnicode(ascii), ascii);
  }
});

test("punycode: RFC 3492 7.1 のサンプル (A) アラビア語", () => {
  assert.equal(
    decode("egbpdaj6bu4bxfgehfvwxn"),
    "ليهمابتكلموشعربي؟"
  );
});

test("punycode: 不正な入力は例外になる", () => {
  assert.throws(() => decode("mazon-3v!"));
  assert.throws(() => decode("mazon-3"));
});

test("キリル文字の a が混ざった amazon を検出する", () => {
  const result = analyze("аmazon.com");
  assert.equal(result.suspicious, true);
  assert.equal(result.unicodeHostname, "аmazon.com");
  assert.equal(result.lookalikeHostname, "amazon.com");
  const types = result.labels[0].findings.map((f) => f.type);
  assert.deepEqual(types, ["ascii-lookalike", "mixed-script"]);
  assert.deepEqual(result.labels[0].chars, [
    {
      char: "а",
      codePoint: "U+0430",
      name: "CYRILLIC SMALL LETTER A",
      scripts: ["Cyrillic"],
      prototype: "a",
    },
  ]);
});

test("キリル文字だけで書かれた apple を検出する（Firefox が通す whole-script confusable）", () => {
  const result = analyze("аррӏе.com");
  assert.equal(result.suspicious, true);
  assert.equal(result.lookalikeHostname, "apple.com");
  assert.equal(restrictionLevel("аррӏе"), "single-script");
  assert.deepEqual(result.labels[0].findings.map((f) => f.type), ["ascii-lookalike"]);
});

test("ギリシャ文字のオミクロンが混ざった google を検出する", () => {
  const result = analyze("gοοgle.com");
  assert.equal(result.suspicious, true);
  assert.equal(result.lookalikeHostname, "google.com");
});

test("ASCII に見えなくても、ラテン文字とキリル文字が日本語と混ざれば検出する", () => {
  const result = analyze("pаypal-ログイン.com");
  assert.equal(result.suspicious, true);
  assert.deepEqual(result.labels[0].findings.map((f) => f.type), ["mixed-script"]);
  assert.deepEqual(result.labels[0].findings[0].scripts.sort(), ["Cyrillic", "Katakana", "Latin"]);
});

test("結合記号を足しただけで ASCII に見えるラベルを検出する", () => {
  // キリル文字だけの apple に U+0301 を足すと、skeleton も文字体系の判定もすり抜けていた（Codex の指摘）
  const cyrillic = analyze("аррӏе́.com");
  assert.equal(cyrillic.suspicious, true);
  assert.deepEqual(cyrillic.labels[0].findings.map((f) => f.type), ["ascii-lookalike-marks"]);
  assert.equal(cyrillic.lookalikeHostname, "apple.com");
  assert.ok(cyrillic.labels[0].chars.some((c) => c.codePoint === "U+0301"));
  // ラテン文字のアクセントによる偽装も同じ扱い（正規のドメインでも警告する）
  for (const [host, expected] of [["amazọn.com", "amazon.com"], ["münchen.de", "munchen.de"]]) {
    const result = analyze(host);
    assert.equal(result.suspicious, true, host);
    assert.equal(result.lookalikeHostname, expected);
  }
});

test("通常の国際化ドメインは警告しない", () => {
  for (const host of ["日本語.jp", "例え.テスト", "ばびぶ.jp", "ελληνικά.gr", "abc漢字.jp", "ひらがなabc.jp"]) {
    const result = analyze(host);
    assert.equal(result.suspicious, false, `${host}: ${JSON.stringify(result.labels.map((l) => l.findings))}`);
  }
});

test("ASCII だけのホスト名は警告しない", () => {
  for (const host of ["amazon.com", "example.co.jp", "localhost", "192.168.0.1"]) {
    assert.equal(analyzeHostname(host).suspicious, false, host);
  }
});

test("デコードできない xn-- ラベルは警告する", () => {
  const result = analyzeHostname("xn--mazon-3v!.com");
  assert.equal(result.suspicious, true);
  assert.equal(result.labels[0].findings[0].type, "undecodable");
});
