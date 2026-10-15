// 見た目の紛らわしいドメインを判定する。
// 根拠: UTS #39 Unicode Security Mechanisms v18.0.0 (docs/sources/tr39.html)
//   - skeleton: 4 Confusable Detection（internalSkeleton の定義）
//   - 文字体系の判定: 5.1 Mixed-Script Detection, 5.2 Restriction-Level Detection
// 読み込み順: data/confusables.js, data/scripts.js, (任意) data/names.js, lib/punycode.js の後。
(() => {
  const data = globalThis.UrlSanitizerData;
  const { labelToUnicode } = globalThis.UrlSanitizerPunycode;

  const ASCII_ONLY = /^[\x00-\x7f]*$/;
  const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
  // 文字ごとの Script_Extensions は正規表現のプロパティエスケープで求める。
  // ブラウザの Unicode 版が古く、未対応の文字体系名は RegExp の生成で失敗するので除外する。
  const SCRIPT_TESTS = data.scriptNames.flatMap((name) => {
    try {
      return [[name, new RegExp(`^\\p{Script_Extensions=${name}}$`, "u")]];
    } catch {
      return [];
    }
  });
  const ALL = null; // Common / Inherited を含む集合は「すべての文字体系」として扱う

  // 5.1 の augmented script set。Hanb / Hntl / Jpan / Kore は複数の文字体系からなる書記体系。
  const AUGMENT = {
    Han: ["Hanb", "Hntl", "Jpan", "Kore"],
    Hiragana: ["Jpan"],
    Katakana: ["Jpan"],
    Hangul: ["Kore"],
    Bopomofo: ["Hanb"],
    Latin: ["Hntl"],
  };

  function scriptExtensions(ch) {
    return SCRIPT_TESTS.filter(([, re]) => re.test(ch)).map(([name]) => name);
  }

  function augmentedScriptSet(ch) {
    const scripts = scriptExtensions(ch);
    if (scripts.includes("Common") || scripts.includes("Inherited")) return ALL;
    const set = new Set(scripts.length ? scripts : ["Unknown"]);
    for (const script of scripts) for (const extra of AUGMENT[script] ?? []) set.add(extra);
    return set;
  }

  // internalSkeleton。bidiSkeleton の並べ替えは省略している（右から左へ書く文字を含むラベルでは近似）。
  function skeleton(text) {
    let out = "";
    for (const ch of text.normalize("NFD")) {
      if (DEFAULT_IGNORABLE.test(ch)) continue;
      out += data.prototypes[ch] ?? ch;
    }
    return out.normalize("NFD");
  }

  // 表示用: ASCII 以外の文字だけを似ている文字に置き換えた文字列（例: "аmazon" -> "amazon"）。
  // skeleton は "m" -> "rn" のように ASCII 同士も置き換えるため、表示にはこちらを使う。
  function lookalike(text) {
    let out = "";
    for (const ch of text.normalize("NFD")) {
      if (DEFAULT_IGNORABLE.test(ch)) continue;
      out += ASCII_ONLY.test(ch) ? ch : data.prototypes[ch] ?? ch;
    }
    return out.normalize("NFC");
  }

  // 5.2 の Restriction Level。識別子プロファイルの検査は IDNA 側の制約に任せて省略する。
  // Highly Restrictive より緩いもの（Moderately 以下）は区別せず "less-restrictive" とする。
  function restrictionLevel(text) {
    if (ASCII_ONLY.test(text)) return "ascii-only";
    const soss = [];
    for (const ch of text) {
      const set = augmentedScriptSet(ch);
      if (set !== ALL) soss.push(set);
    }
    if (soss.length === 0) return "single-script";
    const resolved = soss.reduce((acc, set) => new Set([...acc].filter((s) => set.has(s))));
    if (resolved.size > 0) return "single-script";
    const nonLatin = soss.filter((set) => !set.has("Latin"));
    if (["Kore", "Hanb", "Jpan"].some((cover) => nonLatin.every((set) => set.has(cover)))) {
      return "highly-restrictive";
    }
    return "less-restrictive";
  }

  function describeChar(ch) {
    const cp = ch.codePointAt(0);
    const scripts = scriptExtensions(ch).filter((s) => s !== "Common" && s !== "Inherited");
    return {
      char: ch,
      codePoint: "U+" + cp.toString(16).toUpperCase().padStart(4, "0"),
      name: data.names?.[ch] ?? null,
      scripts,
      prototype: data.prototypes[ch] ?? null,
    };
  }

  function analyzeLabel(asciiLabel) {
    let unicode;
    try {
      unicode = labelToUnicode(asciiLabel);
    } catch {
      return {
        ascii: asciiLabel,
        unicode: asciiLabel,
        isIdn: true,
        findings: [{ type: "undecodable" }],
        chars: [],
      };
    }
    const isIdn = !ASCII_ONLY.test(unicode);
    const findings = [];
    if (isIdn) {
      if (ASCII_ONLY.test(skeleton(unicode))) {
        findings.push({ type: "ascii-lookalike", lookalike: lookalike(unicode) });
      }
      if (restrictionLevel(unicode) === "less-restrictive") {
        const scripts = new Set();
        for (const ch of unicode) for (const s of describeChar(ch).scripts) scripts.add(s);
        findings.push({ type: "mixed-script", scripts: [...scripts] });
      }
    }
    const chars = isIdn ? [...unicode].filter((ch) => !ASCII_ONLY.test(ch)).map(describeChar) : [];
    return { ascii: asciiLabel, unicode, isIdn, findings, chars };
  }

  // ホスト名（Punycode 形式でも Unicode 形式でもよい）を判定する。
  function analyzeHostname(hostname) {
    const labels = hostname.toLowerCase().split(".").map(analyzeLabel);
    return {
      hostname,
      unicodeHostname: labels.map((l) => l.unicode).join("."),
      lookalikeHostname: labels.map((l) => lookalike(l.unicode)).join("."),
      suspicious: labels.some((l) => l.findings.length > 0),
      labels,
    };
  }

  const api = { analyzeHostname, skeleton, lookalike, restrictionLevel };
  globalThis.UrlSanitizerDetector = api;
  if (typeof module !== "undefined") module.exports = api;
})();
