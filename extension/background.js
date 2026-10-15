// ページ本体の読み込み (main_frame) を開始前に捕まえ、紛らわしいドメインなら警告ページへ転送する。
const { analyzeHostname } = globalThis.UrlSanitizerDetector;

const WARNING_PAGE = browser.runtime.getURL("warning/warning.html");
// storage.session（ブラウザを閉じるまで保持）のキー。1 件ずつ別のキーにして、読み書きの競合を避ける。
const ALLOWED_PREFIX = "allowed:"; // allowed:<hostname> = true
const TOKEN_PREFIX = "token:"; // token:<uuid> = { url, hostname, tabId, issuedAt }
const TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// 「このまま開く」を選んだホスト。バックグラウンドが休止・再開しても失われないよう storage から復元する。
const allowedHosts = new Set();
const allowedLoaded = browser.storage.session
  .get(null)
  .then((stored) => {
    for (const key of Object.keys(stored)) {
      if (key.startsWith(ALLOWED_PREFIX)) allowedHosts.add(key.slice(ALLOWED_PREFIX.length));
    }
  })
  .catch(() => {});

async function allowHost(hostname) {
  await allowedLoaded;
  // 保存に成功してから有効にする（保存に失敗したのに警告だけ消える状態を作らない）
  await browser.storage.session.set({ [ALLOWED_PREFIX + hostname]: true });
  allowedHosts.add(hostname);
}

// 警告ページを開くたびに、そのタブと URL に結び付けた使い捨てのトークンを発行する。
// 警告ページは Web ページからもリンク・埋め込みできるため、トークンのない警告ページからは許可させない。
// 期限切れのトークンと、同じタブの古いトークンは発行前に消し、保存量がタブ数を超えて増えないようにする。
async function issueToken(details, hostname) {
  const stored = await browser.storage.session.get(null);
  const stale = Object.entries(stored)
    .filter(([key, entry]) =>
      key.startsWith(TOKEN_PREFIX) && (entry.tabId === details.tabId || Date.now() - entry.issuedAt > TOKEN_TTL_MS)
    )
    .map(([key]) => key);
  if (stale.length) await browser.storage.session.remove(stale);
  const token = crypto.randomUUID();
  await browser.storage.session.set({
    [TOKEN_PREFIX + token]: { url: details.url, hostname, tabId: details.tabId, issuedAt: Date.now() },
  });
  return token;
}

function warningUrl(url, token) {
  const query = new URLSearchParams({ url });
  if (token) query.set("token", token);
  return `${WARNING_PAGE}?${query}`;
}

// blocking リスナーで例外や reject が起きると、Firefox は要求をそのまま続行する
// （toolkit/components/extensions/webrequest/WebRequest.sys.mjs の applyChanges）。
// そのため、途中で失敗したらトークンなし（＝ここからは開けない）の警告ページへ転送し、読み込ませない。
async function decide(details, hostname) {
  await allowedLoaded;
  if (allowedHosts.has(hostname)) return {};
  try {
    return { redirectUrl: warningUrl(details.url, await issueToken(details, hostname)) };
  } catch {
    return { redirectUrl: warningUrl(details.url) };
  }
}

function onBeforeRequest(details) {
  let hostname;
  try {
    hostname = new URL(details.url).hostname;
  } catch {
    return {};
  }
  // ブラウザは国際化ドメインを Punycode 形式 (xn--) で渡すので、それ以外は判定しない
  if (!hostname.includes("xn--")) return {};
  try {
    if (!analyzeHostname(hostname).suspicious) return {};
  } catch {
    return { redirectUrl: warningUrl(details.url) };
  }
  return decide(details, hostname).catch(() => ({ redirectUrl: warningUrl(details.url) }));
}

browser.webRequest.onBeforeRequest.addListener(
  onBeforeRequest,
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame"] },
  ["blocking"]
);

// 送信元が、タブの最上位フレームに表示された自分の警告ページであることを確かめる
function isWarningPageSender(sender) {
  if (sender.id !== browser.runtime.id || sender.frameId !== 0 || !sender.tab || typeof sender.url !== "string") {
    return false;
  }
  // クエリとフラグメントを除いた URL で比べる（moz-extension: の URL.origin は実装によって "null" になりうるため使わない）
  return sender.url.split(/[?#]/)[0] === WARNING_PAGE;
}

async function findToken(token, sender) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const key = TOKEN_PREFIX + token;
  const entry = (await browser.storage.session.get(key))[key];
  if (!entry || entry.tabId !== sender.tab.id || Date.now() - entry.issuedAt > TOKEN_TTL_MS) return null;
  return { key, entry };
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!isWarningPageSender(sender)) return undefined;
  if (message?.type === "check-token") {
    return findToken(message.token, sender).then((found) =>
      found ? { valid: true, url: found.entry.url } : { valid: false }
    );
  }
  if (message?.type === "allow-host") {
    return findToken(message.token, sender).then(async (found) => {
      if (!found) return { ok: false };
      // 先にトークンを消費する。どちらかが失敗すれば reject し、許可されていない状態のまま警告ページに失敗を伝える
      await browser.storage.session.remove(found.key);
      await allowHost(found.entry.hostname);
      return { ok: true, url: found.entry.url };
    });
  }
  return undefined;
});

// MV3 ではユーザーがホスト権限を外せる。プライベートウィンドウでは既定で動かない。
// どちらかが足りなければ、インストール時に案内ページを開く。
async function checkSetup(details) {
  if (details.reason !== "install") return;
  const granted = await browser.permissions.contains({ origins: ["<all_urls>"] });
  const incognito = await browser.extension.isAllowedIncognitoAccess();
  if (!granted || !incognito) await browser.tabs.create({ url: browser.runtime.getURL("setup/setup.html") });
}
browser.runtime.onInstalled.addListener(checkSetup);
