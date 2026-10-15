// ページ本体の読み込み (main_frame) を開始前に捕まえ、紛らわしいドメインなら警告ページへ転送する。
const { analyzeHostname } = globalThis.UrlSanitizerDetector;

const WARNING_PAGE = browser.runtime.getURL("warning/warning.html");
const ALLOWED_KEY = "allowedHosts";

// 「このまま開く」を選んだホスト。storage.session に置き、ブラウザを閉じるまで有効にする。
// バックグラウンドが停止・再開しても失われないよう、メモリ上の Set は storage から復元する。
const allowedHosts = new Set();
const allowedLoaded = browser.storage.session
  .get(ALLOWED_KEY)
  .then((stored) => (stored[ALLOWED_KEY] ?? []).forEach((host) => allowedHosts.add(host)))
  .catch(() => {});

async function allowHost(hostname) {
  await allowedLoaded;
  allowedHosts.add(hostname);
  await browser.storage.session.set({ [ALLOWED_KEY]: [...allowedHosts] });
}
globalThis.allowHost = allowHost;

function onBeforeRequest(details) {
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return {};
  }
  // ブラウザは国際化ドメインを Punycode 形式 (xn--) で渡すので、それ以外は判定しない
  if (!hostname.includes("xn--")) return {};
  if (!analyzeHostname(hostname).suspicious) return {};
  return allowedLoaded.then(() => {
    if (allowedHosts.has(hostname)) return {};
    return { redirectUrl: `${WARNING_PAGE}?url=${encodeURIComponent(details.url)}` };
  });
}

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["blocking"]
);

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "allow-host" && typeof message.hostname === "string") {
    return allowHost(message.hostname).then(() => ({ ok: true }));
  }
  return undefined;
});

// MV3 ではユーザーがホスト権限を外せる。権限がないと判定が動かないので、案内ページを開く。
async function ensureHostPermission() {
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  if (!granted) await browser.tabs.create({ url: browser.runtime.getURL("setup/setup.html") });
}
browser.runtime.onInstalled.addListener(ensureHostPermission);
