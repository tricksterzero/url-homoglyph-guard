// E2E テスト（休止シナリオ）専用。バックグラウンドが起動するたびに報告する。
// 休止後に再び起動したことを確かめるため、遷移の待機などは持たない。
fetch("__LOG_URL__", {
  method: "POST",
  body: JSON.stringify({ event: "bgStarted" }),
}).catch(() => {});

// インストール時に開く案内ページは拡張機能のページで、開いている間はバックグラウンドが休止しないため閉じる
browser.runtime.onInstalled.addListener(() => {
  setTimeout(async () => {
    const setupUrl = browser.runtime.getURL("setup/setup.html");
    for (const tab of await browser.tabs.query({})) if (tab.url === setupUrl) await browser.tabs.remove(tab.id);
  }, 500);
});
