// 警告ページ。開こうとした URL を ?url= で受け取り、判定結果を表示する。
// URL 由来の文字列はすべて textContent で挿入し、HTML として解釈させない。
const { analyzeHostname } = globalThis.UrlSanitizerDetector;

const SCRIPT_LABELS = {
  Latin: "ラテン文字",
  Cyrillic: "キリル文字",
  Greek: "ギリシャ文字",
  Armenian: "アルメニア文字",
  Cherokee: "チェロキー文字",
  Georgian: "ジョージア文字",
  Han: "漢字",
  Hiragana: "ひらがな",
  Katakana: "カタカナ",
  Hangul: "ハングル",
  Arabic: "アラビア文字",
  Hebrew: "ヘブライ文字",
};
const MAX_CHARS_IN_SUMMARY = 3;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const scriptLabel = (name) => SCRIPT_LABELS[name] ?? name;
const isAscii = (text) => /^[\x00-\x7f]*$/.test(text);

function parseTarget(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// ASCII 以外の文字を <mark> で強調して書き込む
function appendHighlighted(container, text) {
  for (const ch of text) {
    if (isAscii(ch)) {
      container.append(ch);
    } else {
      const mark = document.createElement("mark");
      mark.textContent = ch;
      mark.title = "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      container.append(mark);
    }
  }
}

function findingsOf(result, type) {
  return result.labels.flatMap((label) => label.findings.filter((f) => f.type === type).map((f) => ({ label, f })));
}

// 冒頭の一文。実際の文字から「どの文字が何なのか」を具体的に書く
function summaryText(result) {
  const chars = result.labels.flatMap((l) => l.chars);
  if (findingsOf(result, "ascii-lookalike").length) {
    const described = chars
      .filter((c) => c.prototype && isAscii(c.prototype) && c.scripts.length)
      .slice(0, MAX_CHARS_IN_SUMMARY)
      .map((c) => `「${c.char}」（${c.codePoint}）は英字の ${c.prototype} ではなく${scriptLabel(c.scripts[0])}`);
    const rest = chars.length - described.length;
    const detail = described.length
      ? `${described.join("、")}${rest > 0 ? `（ほか ${rest} 文字）` : ""}です。`
      : "英字によく似た別の文字を含みます。";
    return `${detail}${result.lookalikeHostname} とは別のサイトです。`;
  }
  if (findingsOf(result, "ascii-lookalike-marks").length) {
    return `アクセントなどの小さな記号が付いた文字を含みます。記号を除くと ${result.lookalikeHostname} と同じ見た目ですが、別のサイトです。`;
  }
  const mixed = findingsOf(result, "mixed-script")[0];
  if (mixed) {
    return `${mixed.f.scripts.map(scriptLabel).join("・")}が混ざっています。正規のドメインではまれな組み合わせです。`;
  }
  return "このドメインの表記（Punycode）を正しく読み取れませんでした。";
}

function renderReason(li, label, finding) {
  const appendLabel = () => {
    li.append("「");
    appendHighlighted(li, label.unicode);
    li.append(`」（${label.ascii}）`);
  };
  switch (finding.type) {
    case "ascii-lookalike":
      appendLabel();
      li.append(`は、英字以外の文字を含みますが、見た目は「${finding.lookalike}」とほぼ同じです。`);
      break;
    case "ascii-lookalike-marks":
      appendLabel();
      li.append(`は、記号を除くと「${finding.lookalike}」と同じに見えます。`);
      break;
    case "mixed-script":
      appendLabel();
      li.append(`には、${finding.scripts.map(scriptLabel).join("・")}が混在しています。`);
      break;
    case "undecodable":
      li.append(`「${label.ascii}」は Punycode として読み取れません。`);
      break;
    default:
      li.append(finding.type);
  }
}

function render(target, result) {
  const hasLookalike =
    findingsOf(result, "ascii-lookalike").length + findingsOf(result, "ascii-lookalike-marks").length > 0;
  if (!hasLookalike) $("title").textContent = "通常は一緒に使われない文字を含むドメインです";

  appendHighlighted($("unicode-host"), result.unicodeHostname);
  $("summary").textContent = summaryText(result);
  if (hasLookalike) {
    $("lookalike-host").textContent = result.lookalikeHostname;
  } else {
    $("lookalike-term").hidden = true;
    $("lookalike-desc").hidden = true;
  }
  $("ascii-host").textContent = result.hostname;
  $("full-url").textContent = target.href;

  for (const label of result.labels) {
    for (const finding of label.findings) {
      const li = document.createElement("li");
      renderReason(li, label, finding);
      $("reasons").append(li);
    }
    for (const info of label.chars) {
      const tr = document.createElement("tr");
      const cells = [
        info.char,
        info.codePoint,
        info.name ?? "（データなし）",
        info.scripts.map(scriptLabel).join("・") || "共通",
        info.prototype ?? "―",
      ];
      cells.forEach((value, index) => {
        const td = document.createElement("td");
        td.textContent = value;
        if (index === 0 || index === 4) td.className = "glyph";
        tr.append(td);
      });
      $("chars").append(tr);
    }
  }

  $("proceed-note").textContent = `開くと、ブラウザを閉じるまで ${result.hostname} では警告しません。`;
}

function toggleDetails() {
  const open = $("details").hidden;
  $("details").hidden = !open;
  $("toggle-details").setAttribute("aria-expanded", String(open));
  $("toggle-details").textContent = open ? "詳細を閉じる" : "詳細";
}

async function goBack() {
  if (history.length > 1) {
    history.back();
    return;
  }
  const tab = await browser.tabs.getCurrent();
  if (tab) await browser.tabs.remove(tab.id);
}

function disableProceed(reason) {
  $("proceed").hidden = true;
  $("proceed-note").textContent = reason;
}

function showError(message) {
  $("error").hidden = false;
  $("error").textContent = message;
}

// 許可は、拡張機能がこのタブのために発行したトークンと引き換えにだけ行う。
// 移動先もバックグラウンドが記録した URL を使い、このページの URL パラメーターは信用しない。
async function proceed(token) {
  $("proceed").disabled = true;
  try {
    const response = await browser.runtime.sendMessage({ type: "allow-host", token });
    const url = parseTarget(response?.url);
    if (!response?.ok || !url) {
      disableProceed("この警告ページからは開けません。もう一度リンクを開き直してください。");
      return;
    }
    location.replace(url.href);
  } catch (error) {
    // トークンは消費済みの可能性があるので、再試行はさせずに開き直してもらう
    disableProceed("許可を登録できませんでした。開く場合は、もう一度リンクを開き直してください。");
    showError(`エラー: ${error.message}`);
  }
}

async function init() {
  $("back").addEventListener("click", goBack);
  $("toggle-details").addEventListener("click", toggleDetails);
  const target = parseTarget(params.get("url"));
  if (!target) {
    $("summary").textContent = "警告対象の URL を読み取れませんでした。";
    $("proceed").hidden = true;
    return;
  }
  render(target, analyzeHostname(target.hostname));

  // 他のページに埋め込まれている場合は、重ねたボタンを押させる攻撃を避けるため操作させない
  if (window.top !== window) {
    $("back").hidden = true;
    disableProceed("このページは他のページに埋め込まれているため、ここからは操作できません。");
    return;
  }
  const token = params.get("token");
  const check = await browser.runtime.sendMessage({ type: "check-token", token }).catch(() => null);
  if (!check?.valid || check.url !== target.href) {
    disableProceed("この警告ページは拡張機能が表示したものではないか、有効期限が切れています。ここからは開けません。");
    return;
  }
  $("proceed").addEventListener("click", () => proceed(token));
}

init();
