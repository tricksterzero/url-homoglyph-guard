// E2E テスト（basic シナリオ）専用。run_e2e.py が拡張機能のコピーへ追加し、結果をローカルのログサーバーへ報告する。
// __LOG_URL__ は run_e2e.py が置き換える。
const LOG_URL = "__LOG_URL__";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function report(event, fields = {}) {
  return fetch(LOG_URL, {
    method: "POST",
    body: JSON.stringify({ event, ...fields }),
  }).catch(() => {});
}

async function tabUrl(tabId) {
  return (await browser.tabs.get(tabId)).url;
}

async function run() {
  try {
    await report("permission", { granted: await browser.permissions.contains({ origins: ["<all_urls>"] }) });
    // 一時プロファイルではプライベートウィンドウが未許可なので、インストール時に案内ページが開くはず
    const setupUrl = browser.runtime.getURL("setup/setup.html");
    const setupTabs = (await browser.tabs.query({})).filter((tab) => tab.url === setupUrl);
    await report("setup", { opened: setupTabs.length > 0 });
    for (const tab of setupTabs) await browser.tabs.remove(tab.id);

    const lookalike = await browser.tabs.create({ url: "http://аmazon.test:__PORT__/typed" });
    const japanese = await browser.tabs.create({ url: "http://日本語.test/typed" });
    const linkPage = await browser.tabs.create({ url: LOG_URL.replace("/log", "/start") });
    await sleep(5000);
    await report("urls", {
      lookalike: await tabUrl(lookalike.id),
      japanese: await tabUrl(japanese.id),
      linkPage: await tabUrl(linkPage.id),
    });

    // 警告ページの表示内容を読み、「危険を理解して開く」を押す
    const views = browser.extension.getViews({ type: "tab" });
    for (const view of views) {
      const doc = view.document;
      await report("view", {
        href: view.location.href,
        unicodeHost: doc.getElementById("unicode-host")?.textContent,
        lookalikeHost: doc.getElementById("lookalike-host")?.textContent,
        asciiHost: doc.getElementById("ascii-host")?.textContent,
        reasons: [...doc.querySelectorAll("#reasons li")].map((li) => li.textContent),
        chars: [...doc.querySelectorAll("#chars tr")].map((tr) => tr.textContent),
      });
    }
    await browser.tabs.update(lookalike.id, { active: true });
    await sleep(800);
    await report("screenshot", { dataUrl: await browser.tabs.captureVisibleTab() });

    const target = views.find((view) => view.location.href.includes("xn--mazon-3ve"));
    target?.document.getElementById("proceed").click();
    await sleep(3000);
    await report("afterProceed", { lookalike: await tabUrl(lookalike.id) });

    // 許可後は同じホストへ別のタブで開いても警告しない
    const again = await browser.tabs.create({ url: "http://аmazon.test:__PORT__/again" });
    await sleep(2000);
    await report("allowedAgain", { url: await tabUrl(again.id) });
  } catch (error) {
    await report("error", { message: String(error), stack: error.stack });
  } finally {
    await report("done");
    for (const win of await browser.windows.getAll()) await browser.windows.remove(win.id);
  }
}

browser.runtime.onInstalled.addListener(() => setTimeout(run, 1000));
