// 警告ページ。開こうとした URL を ?url= で受け取り、判定結果を表示する。
// URL 由来の文字列はすべて textContent で挿入し、HTML として解釈させない。
const { analyzeHostname } = globalThis.UrlSanitizerDetector;
const { t, localizePage } = globalThis.UrlSanitizerI18n;

const MAX_CHARS_IN_SUMMARY = 3;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const isAscii = (text) => /^[\x00-\x7f]*$/.test(text);
// 文字体系の名前は messages.json の script_<名前> から引き、なければ Unicode の名前をそのまま使う
const scriptLabel = (name) => t(`script_${name}`) || name;
// 列挙はブラウザの言語の書き方に合わせる（英語: "Cyrillic and Latin"、日本語: "キリル文字、ラテン文字"）
const listFormat = new Intl.ListFormat(browser.i18n.getUILanguage(), { type: "conjunction" });
const scriptList = (names) => listFormat.format(names.map(scriptLabel));

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
      .map((c) => t("summaryChar", [c.char, c.codePoint, c.prototype, scriptLabel(c.scripts[0])]));
    const rest = chars.length - described.length;
    const detail = described.length
      ? described.join(t("summaryCharSeparator")) + (rest > 0 ? t("summaryMoreChars", rest) : "") + t("summaryCharsEnd")
      : t("summaryGenericLookalike");
    return detail + t("summaryDifferentSite", result.lookalikeHostname);
  }
  if (findingsOf(result, "ascii-lookalike-marks").length) {
    return t("summaryMarks", result.lookalikeHostname);
  }
  const mixed = findingsOf(result, "mixed-script")[0];
  if (mixed) return t("summaryMixed", scriptList(mixed.f.scripts));
  return t("summaryUndecodable");
}

function renderReason(li, label, finding) {
  const appendLabel = () => {
    li.append(t("quoteOpen"));
    appendHighlighted(li, label.unicode);
    li.append(t("quoteClose") + t("labelPunycode", label.ascii));
  };
  switch (finding.type) {
    case "ascii-lookalike":
      appendLabel();
      li.append(t("reasonLookalike", finding.lookalike));
      break;
    case "ascii-lookalike-marks":
      appendLabel();
      li.append(t("reasonMarks", finding.lookalike));
      break;
    case "mixed-script":
      appendLabel();
      li.append(t("reasonMixed", scriptList(finding.scripts)));
      break;
    case "undecodable":
      li.append(t("reasonUndecodable", label.ascii));
      break;
    default:
      li.append(finding.type);
  }
}

function render(target, result) {
  const hasLookalike =
    findingsOf(result, "ascii-lookalike").length + findingsOf(result, "ascii-lookalike-marks").length > 0;
  if (!hasLookalike) $("title").textContent = t("titleMixed");

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
        info.name ?? t("charNoData"),
        scriptList(info.scripts) || t("scriptCommon"),
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

  $("proceed-note").textContent = t("proceedNote", result.hostname);
}

function toggleDetails() {
  const open = $("details").hidden;
  $("details").hidden = !open;
  $("toggle-details").setAttribute("aria-expanded", String(open));
  $("toggle-details").textContent = t(open ? "buttonHideDetails" : "buttonDetails");
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
      disableProceed(t("proceedUnavailable"));
      return;
    }
    location.replace(url.href);
  } catch (error) {
    // トークンは消費済みの可能性があるので、再試行はさせずに開き直してもらう
    disableProceed(t("registerFailed"));
    showError(t("errorPrefix", error.message));
  }
}

async function init() {
  localizePage();
  $("back").addEventListener("click", goBack);
  $("toggle-details").addEventListener("click", toggleDetails);
  const target = parseTarget(params.get("url"));
  if (!target) {
    $("summary").textContent = t("urlUnreadable");
    $("proceed").hidden = true;
    return;
  }
  render(target, analyzeHostname(target.hostname));

  // 他のページに埋め込まれている場合は、重ねたボタンを押させる攻撃を避けるため操作させない
  if (window.top !== window) {
    $("back").hidden = true;
    disableProceed(t("framedNote"));
    return;
  }
  const token = params.get("token");
  const check = await browser.runtime.sendMessage({ type: "check-token", token }).catch(() => null);
  if (!check?.valid || check.url !== target.href) {
    disableProceed(t("invalidTokenNote"));
    return;
  }
  $("proceed").addEventListener("click", () => proceed(token));
}

init();
