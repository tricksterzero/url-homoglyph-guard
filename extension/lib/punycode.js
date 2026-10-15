// RFC 3492 (Punycode) のデコード処理。
// webRequest に渡される URL のホスト名は Punycode 形式 (xn--...) なので、判定前に Unicode へ戻す。
(() => {
  const BASE = 36;
  const TMIN = 1;
  const TMAX = 26;
  const SKEW = 38;
  const DAMP = 700;
  const INITIAL_BIAS = 72;
  const INITIAL_N = 128;
  const MAX_INT = 0x7fffffff;

  function adapt(delta, numPoints, firstTime) {
    delta = firstTime ? Math.floor(delta / DAMP) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    let k = 0;
    while (delta > ((BASE - TMIN) * TMAX) >> 1) {
      delta = Math.floor(delta / (BASE - TMIN));
      k += BASE;
    }
    return k + Math.floor(((BASE - TMIN + 1) * delta) / (delta + SKEW));
  }

  function basicToDigit(code) {
    if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26; // 0-9
    if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z
    if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z
    return BASE;
  }

  // "xn--" を除いた Punycode 文字列を Unicode 文字列に戻す。不正な入力では例外を投げる。
  function decode(input) {
    const output = [];
    const basicEnd = Math.max(input.lastIndexOf("-"), 0);
    for (let j = 0; j < basicEnd; j++) {
      const code = input.charCodeAt(j);
      if (code >= 0x80) throw new RangeError("punycode: non-basic code point");
      output.push(code);
    }

    let n = INITIAL_N;
    let i = 0;
    let bias = INITIAL_BIAS;
    for (let pos = basicEnd > 0 ? basicEnd + 1 : 0; pos < input.length; ) {
      const oldI = i;
      for (let w = 1, k = BASE; ; k += BASE) {
        if (pos >= input.length) throw new RangeError("punycode: truncated input");
        const digit = basicToDigit(input.charCodeAt(pos++));
        if (digit >= BASE) throw new RangeError("punycode: invalid digit");
        if (digit > Math.floor((MAX_INT - i) / w)) throw new RangeError("punycode: overflow");
        i += digit * w;
        const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
        if (digit < t) break;
        if (w > Math.floor(MAX_INT / (BASE - t))) throw new RangeError("punycode: overflow");
        w *= BASE - t;
      }
      const length = output.length + 1;
      bias = adapt(i - oldI, length, oldI === 0);
      if (Math.floor(i / length) > MAX_INT - n) throw new RangeError("punycode: overflow");
      n += Math.floor(i / length);
      i %= length;
      if (n > 0x10ffff) throw new RangeError("punycode: code point out of range");
      output.splice(i, 0, n);
      i++;
    }
    return String.fromCodePoint(...output);
  }

  // ラベル 1 つを Unicode 表記にする。"xn--" で始まらないラベルはそのまま返す。
  function labelToUnicode(label) {
    return /^xn--/i.test(label) ? decode(label.slice(4)) : label;
  }

  const api = { decode, labelToUnicode };
  globalThis.UrlSanitizerPunycode = api;
  if (typeof module !== "undefined") module.exports = api;
})();
