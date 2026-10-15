// background.js を、browser API を模擬した環境で動かす単体テスト。
// 保存・削除の失敗やトークンの期限切れなど、実機の E2E では起こしにくい状況を確かめる。
// 使い方: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { domainToASCII } = require("node:url");

require("../extension/data/confusables.js");
require("../extension/data/scripts.js");
require("../extension/lib/punycode.js");
const detector = require("../extension/lib/detector.js");

const BACKGROUND = fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");
const EXTENSION_ORIGIN = "moz-extension://test-uuid/";
const WARNING_PAGE = `${EXTENSION_ORIGIN}warning/warning.html`;
const LOOKALIKE_URL = `http://${domainToASCII("аmazon.test")}/path`;
const LOOKALIKE_HOST = new URL(LOOKALIKE_URL).hostname;

function createBrowser(fail, localStore) {
  const store = {};
  const listeners = {};
  const check = (name) => {
    if (fail[name]) throw new Error(`storage.session.${name} failed`);
  };
  const browser = {
    runtime: {
      id: "url-homoglyph-guard@test",
      getURL: (p) => EXTENSION_ORIGIN + p,
      onMessage: { addListener: (f) => (listeners.message = f) },
      onInstalled: { addListener: (f) => (listeners.installed = f) },
    },
    webRequest: { onBeforeRequest: { addListener: (f) => (listeners.request = f) } },
    storage: {
      session: {
        async get(keys) {
          check("get");
          if (keys === null) return structuredClone(store);
          return Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        async set(items) {
          check("set");
          Object.assign(store, structuredClone(items));
        },
        async remove(keys) {
          check("remove");
          for (const k of [].concat(keys)) delete store[k];
        },
      },
      local: {
        async get(keys) {
          if (fail.localGet) throw new Error("storage.local.get failed");
          return Object.fromEntries([].concat(keys).filter((k) => k in localStore).map((k) => [k, localStore[k]]));
        },
      },
      onChanged: { addListener: (f) => (listeners.storageChanged = f) },
    },
    permissions: { contains: async () => true },
    extension: { isAllowedIncognitoAccess: async () => true },
    tabs: { create: async () => ({}) },
  };
  return { browser, store, listeners };
}

function loadBackground({ fail = {}, analyzeHostname = detector.analyzeHostname, local = {} } = {}) {
  const env = createBrowser(fail, local);
  const context = vm.createContext({
    browser: env.browser,
    URL,
    URLSearchParams,
    crypto: globalThis.crypto,
    UrlSanitizerDetector: { analyzeHostname },
  });
  vm.runInContext(BACKGROUND, context);
  return { ...env, fail };
}

// vm 内で作られたオブジェクトはプロトタイプが異なるので、比較前に通常のオブジェクトへ変換する
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const request = async (env, url = LOOKALIKE_URL, tabId = 5) => plain(await env.listeners.request({ url, tabId }));
const send = async (env, message, s) => plain(await env.listeners.message(message, s));
const tokenOf = (redirectUrl) => new URL(redirectUrl).searchParams.get("token");
const sender = (redirectUrl, overrides = {}) => ({
  id: "url-homoglyph-guard@test",
  frameId: 0,
  tab: { id: 5 },
  url: redirectUrl,
  ...overrides,
});
const tokenKeys = (env) => Object.keys(env.store).filter((k) => k.startsWith("token:"));

test("紛らわしいホストはトークン付きの警告ページへ転送し、それ以外は通す", async () => {
  const env = loadBackground();
  const result = await request(env);
  assert.ok(result.redirectUrl.startsWith(`${WARNING_PAGE}?`));
  assert.equal(new URL(result.redirectUrl).searchParams.get("url"), LOOKALIKE_URL);
  assert.match(tokenOf(result.redirectUrl), /^[0-9a-f-]{36}$/);
  assert.deepEqual(await request(env, "http://example.com/"), {});
  assert.deepEqual(await request(env, `http://${domainToASCII("日本語.test")}/`), {});
});

test("トークンを保存できないときは、トークンなしの警告ページへ転送する（読み込ませない）", async () => {
  for (const name of ["set", "get", "remove"]) {
    const env = loadBackground();
    await request(env, LOOKALIKE_URL, 9); // remove の失敗を起こすため、先に同じタブのトークンを作っておく
    env.fail[name] = true;
    const result = await request(env, LOOKALIKE_URL, 9);
    assert.ok(result.redirectUrl?.startsWith(`${WARNING_PAGE}?`), name);
    assert.equal(tokenOf(result.redirectUrl), null, name);
  }
});

test("判定処理が例外を投げても、読み込ませずに警告ページへ転送する", async () => {
  const env = loadBackground({
    analyzeHostname: () => {
      throw new Error("detector bug");
    },
  });
  const result = await request(env);
  assert.ok(result.redirectUrl.startsWith(`${WARNING_PAGE}?`));
  assert.equal(tokenOf(result.redirectUrl), null);
});

test("トークンは同じタブにつき 1 つだけ残り、期限切れは発行時に消える", async () => {
  const env = loadBackground();
  await request(env, LOOKALIKE_URL, 1);
  await request(env, LOOKALIKE_URL, 1);
  assert.equal(tokenKeys(env).length, 1);
  await request(env, LOOKALIKE_URL, 2);
  assert.equal(tokenKeys(env).length, 2);
  for (const key of tokenKeys(env)) env.store[key].issuedAt -= 2 * 60 * 60 * 1000; // 2 時間前に発行したことにする
  await request(env, LOOKALIKE_URL, 3);
  assert.equal(tokenKeys(env).length, 1);
});

test("check-token: 発行したタブの最上位フレームの警告ページからだけ有効", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  const token = tokenOf(redirectUrl);
  const ask = (s) => env.listeners.message({ type: "check-token", token }, s);
  assert.deepEqual(plain(await ask(sender(redirectUrl))), { valid: true, url: LOOKALIKE_URL });
  assert.deepEqual(plain(await ask(sender(redirectUrl, { tab: { id: 6 } }))), { valid: false });
  assert.equal(ask(sender(redirectUrl, { frameId: 3 })), undefined);
  assert.equal(ask(sender(redirectUrl, { url: `${EXTENSION_ORIGIN}setup/setup.html` })), undefined);
  assert.equal(ask(sender(redirectUrl, { id: "other@test" })), undefined);
  assert.equal(ask(sender(redirectUrl, { tab: undefined })), undefined);
});

test("check-token: 期限切れのトークンは無効", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  env.store[tokenKeys(env)[0]].issuedAt -= 2 * 60 * 60 * 1000;
  const result = await send(env, { type: "check-token", token: tokenOf(redirectUrl) }, sender(redirectUrl));
  assert.deepEqual(result, { valid: false });
});

test("allow-host: 許可するとトークンを消費し、同じホストを通す。同じトークンは再利用できない", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  const message = { type: "allow-host", token: tokenOf(redirectUrl) };
  assert.deepEqual(await send(env, message, sender(redirectUrl)), { ok: true, url: LOOKALIKE_URL });
  assert.equal(env.store[`allowed:${LOOKALIKE_HOST}`], true);
  assert.equal(tokenKeys(env).length, 0);
  assert.deepEqual(await request(env), {});
  assert.deepEqual(await send(env, message, sender(redirectUrl)), { ok: false });
});

test("allow-host: トークンを消費できないときは許可しない", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  env.fail.remove = true;
  await assert.rejects(env.listeners.message({ type: "allow-host", token: tokenOf(redirectUrl) }, sender(redirectUrl)));
  env.fail.remove = false;
  assert.equal(env.store[`allowed:${LOOKALIKE_HOST}`], undefined);
  assert.ok((await request(env)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});

test("allow-host: 許可を保存できないときは許可しない（トークンは消費済みで再利用できない）", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  env.fail.set = true;
  const message = { type: "allow-host", token: tokenOf(redirectUrl) };
  await assert.rejects(env.listeners.message(message, sender(redirectUrl)));
  env.fail.set = false;
  assert.equal(env.store[`allowed:${LOOKALIKE_HOST}`], undefined);
  assert.deepEqual(await send(env, message, sender(redirectUrl)), { ok: false });
  assert.ok((await request(env)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});

test("allow-host: 形式の違うトークンや別タブからは許可しない", async () => {
  const env = loadBackground();
  const { redirectUrl } = await request(env);
  for (const [token, s] of [
    ["not-a-uuid", sender(redirectUrl)],
    [crypto.randomUUID(), sender(redirectUrl)],
    [tokenOf(redirectUrl), sender(redirectUrl, { tab: { id: 99 } })],
  ]) {
    assert.deepEqual(await send(env, { type: "allow-host", token }, s), { ok: false });
  }
  assert.equal(env.store[`allowed:${LOOKALIKE_HOST}`], undefined);
});

// 「記号を除くと ASCII に見える」だけのホスト（ラテン文字のアクセントによるもの）
const MARKS_ONLY_URL = `http://${domainToASCII("amazọn.test")}/path`;

test("設定: アクセント付きの紛らわしいドメインは、既定では警告する", async () => {
  const env = loadBackground();
  assert.ok((await request(env, MARKS_ONLY_URL)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});

test("設定: warnOnMarks が false なら、アクセントだけのドメインは通し、ほかの判定は今までどおり警告する", async () => {
  const env = loadBackground({ local: { warnOnMarks: false } });
  assert.deepEqual(await request(env, MARKS_ONLY_URL), {});
  assert.ok((await request(env)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});

test("設定: 変更はすぐに反映される", async () => {
  const env = loadBackground();
  await request(env, MARKS_ONLY_URL); // 設定の読み込みを済ませる
  env.listeners.storageChanged({ warnOnMarks: { newValue: false } }, "local");
  assert.deepEqual(await request(env, MARKS_ONLY_URL), {});
  env.listeners.storageChanged({ warnOnMarks: { newValue: true } }, "local");
  assert.ok((await request(env, MARKS_ONLY_URL)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});

test("設定: 読み込めないときは警告する側に倒す", async () => {
  const env = loadBackground({ fail: { localGet: true }, local: { warnOnMarks: false } });
  assert.ok((await request(env, MARKS_ONLY_URL)).redirectUrl.startsWith(`${WARNING_PAGE}?`));
});