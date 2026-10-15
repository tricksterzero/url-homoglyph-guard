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

const $ = (id) => document.getElementById(id);
const scriptLabel = (name) => SCRIPT_LABELS[name] ?? name;

function parseTarget() {
  const raw = new URLSearchParams(location.search).get("url");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// ASCII 以外の文字を <mark> で強調してホスト名を描く
function renderHighlightedHost(container, text) {
  for (const ch of text) {
    if (/^[\x00-\x7f]$/.test(ch)) {
      container.append(ch);
    } else {
      const mark = document.createElement("mark");
      mark.textContent = ch;
      mark.title = "U+" + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
      container.append(mark);
    }
  }
}

// 理由の文を組み立てる。ラベルは ASCII 以外の文字を強調し、Punycode 表記を併記する。
function renderReason(li, label, finding) {
  const appendLabel = () => {
    li.append("「");
    renderHighlightedHost(li, label.unicode);
    li.append(`」(${label.ascii})`);
  };
  switch (finding.type) {
    case "ascii-lookalike":
      appendLabel();
      li.append(`は、見た目が ASCII の「${finding.lookalike}」とほぼ同じですが、別の文字を含む別のドメインです。`);
      break;
    case "mixed-script":
      appendLabel();
      li.append(`には、${finding.scripts.map(scriptLabel).join("・")}が混在しています。正規のドメインではまれな組み合わせです。`);
      break;
    case "undecodable":
      li.append(`「${label.ascii}」は Punycode として正しく解読できませんでした。`);
      break;
    default:
      li.append(finding.type);
  }
}

function render(target, result) {
  const hasLookalike = result.labels.some((l) => l.findings.some((f) => f.type === "ascii-lookalike"));
  $("lead").textContent = hasLookalike
    ? "このドメインには、英字とよく似た別の文字が含まれています。よく知っているサイトに見えても、別のサイトの可能性があります。"
    : "このドメインには、通常は一緒に使われない文字体系が混在しています。";

  renderHighlightedHost($("unicode-host"), result.unicodeHostname);
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
  }

  for (const label of result.labels) {
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

  $("proceed-note").textContent =
    `開いた場合、ブラウザを閉じるまで ${result.hostname} への警告は表示しません。`;
}

async function goBack() {
  if (history.length > 1) {
    history.back();
    return;
  }
  const tab = await browser.tabs.getCurrent();
  if (tab) await browser.tabs.remove(tab.id);
}

async function proceed(target) {
  $("proceed").disabled = true;
  try {
    await browser.runtime.sendMessage({ type: "allow-host", hostname: target.hostname });
    location.replace(target.href);
  } catch (error) {
    $("proceed").disabled = false;
    $("error").hidden = false;
    $("error").textContent = `許可の登録に失敗しました: ${error.message}`;
  }
}

const target = parseTarget();
if (!target) {
  $("lead").textContent = "警告対象の URL を読み取れませんでした。";
  $("proceed").hidden = true;
} else {
  render(target, analyzeHostname(target.hostname));
  $("proceed").addEventListener("click", () => proceed(target));
}
$("back").addEventListener("click", goBack);
