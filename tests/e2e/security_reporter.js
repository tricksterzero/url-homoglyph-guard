// E2E テスト（security シナリオ）専用。警告ページの偽造・埋め込み・トークンの再利用・リダイレクトを試す。
// __LOG_URL__ と __TARGET__（紛らわしいホストの "http://<punycode>:<port>"）は run_e2e.py が置き換える。
const LOG_URL = "__LOG_URL__";
const BASE = LOG_URL.replace("/log", "");
const TARGET = "__TARGET__";
const WARNING_URL = browser.runtime.getURL("warning/warning.html");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = (event, fields = {}) =>
  fetch(LOG_URL, { method: "POST", body: JSON.stringify({ event, ...fields }) }).catch(() => {});
const tabUrl = async (tabId) => (await browser.tabs.get(tabId)).url;
const viewFor = (fragment) =>
  browser.extension.getViews({ type: "tab" }).find((view) => view.location.href.includes(fragment));

async function run() {
  try {
    const setupUrl = browser.runtime.getURL("setup/setup.html");
    for (const tab of await browser.tabs.query({})) if (tab.url === setupUrl) await browser.tabs.remove(tab.id);

    // 1. 通常の URL から 302 で紛らわしいドメインへリダイレクト
    const redirect = await browser.tabs.create({ url: `${BASE}/redirect` });
    await sleep(2500);
    await report("redirect", { url: await tabUrl(redirect.id) });

    // 2. トークンのない（偽造した）警告ページ
    const forgedUrl = `${WARNING_URL}?url=${encodeURIComponent(`${TARGET}/forged`)}`;
    const forged = await browser.tabs.create({ url: forgedUrl });
    await sleep(1500);
    const forgedView = viewFor("forged"); // 警告ページの URL では "/" が %2F にエンコードされている
    const forgedResponse = await forgedView.browser.runtime
      .sendMessage({ type: "allow-host", token: crypto.randomUUID() })
      .catch((error) => ({ error: String(error) }));
    await report("forged", {
      proceedHidden: forgedView.document.getElementById("proceed").hidden,
      note: forgedView.document.getElementById("proceed-note").textContent,
      response: forgedResponse,
    });
    await browser.tabs.remove(forged.id);
    const afterForged = await browser.tabs.create({ url: `${TARGET}/after-forged` });
    await sleep(1500);
    await report("afterForged", { url: await tabUrl(afterForged.id) });

    // 3. Web ページの iframe に埋め込んだ警告ページ（結果は警告ページ側の probe が報告する）
    await browser.tabs.create({ url: `${BASE}/frame?src=${encodeURIComponent(forgedUrl)}` });
    await sleep(2500);

    // 4. 通常の警告 → 「開く」。警告前に要求が届かず、許可後に届くこと
    const landing = await browser.tabs.create({ url: `${TARGET}/landing` });
    await sleep(2000);
    const landingView = viewFor("landing");
    const landingWarningUrl = landingView.location.href;
    await report("beforeProceed", { url: await tabUrl(landing.id) });
    landingView.document.getElementById("proceed").click();
    await sleep(2500);
    await report("afterProceed", { url: await tabUrl(landing.id) });
    const again = await browser.tabs.create({ url: `${TARGET}/again` });
    await sleep(1500);
    await report("allowedAgain", { url: await tabUrl(again.id) });

    // 5. 使用済みトークンを、発行されたのと同じタブで再利用する（タブの違いではなく消費済みで拒否されること）
    await browser.tabs.update(landing.id, { url: landingWarningUrl });
    await sleep(1500);
    await report("reuse", { proceedHidden: viewFor("landing").document.getElementById("proceed").hidden });

    // 6. 未使用の有効なトークンを、別のタブで使う
    const gTarget = TARGET.replace("xn--mazon-3ve", "xn--ggle-0nda");
    const owner = await browser.tabs.create({ url: `${gTarget}/owner` });
    await sleep(1500);
    const ownerView = viewFor("owner");
    const ownerWarningUrl = ownerView.location.href;
    const thief = await browser.tabs.create({ url: ownerWarningUrl });
    await sleep(1500);
    const views = browser.extension.getViews({ type: "tab" }).filter((v) => v.location.href === ownerWarningUrl);
    await report("otherTab", {
      views: views.length,
      // 発行元のタブでは表示され、別のタブでは表示されないこと
      hidden: views.map((v) => v.document.getElementById("proceed").hidden).sort(),
    });
    await browser.tabs.remove(thief.id);
    await browser.tabs.remove(owner.id);
  } catch (error) {
    await report("error", { message: String(error), stack: error.stack });
  } finally {
    await report("done");
    for (const win of await browser.windows.getAll()) await browser.windows.remove(win.id);
  }
}

browser.runtime.onInstalled.addListener(() => setTimeout(run, 1000));
