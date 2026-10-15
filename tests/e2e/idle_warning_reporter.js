// E2E テスト（休止シナリオ）専用。警告ページに追加し、表示されたことを報告して次の手順を進める。
// 拡張機能のページを開いている間はバックグラウンドが休止しないため、以降の遷移は通常の Web ページに任せる。
(async () => {
  const LOG_URL = "__LOG_URL__";
  const report = (event, fields = {}) =>
    fetch(LOG_URL, { method: "POST", body: JSON.stringify({ event, ...fields }) }).catch(() => {});
  const target = new URLSearchParams(location.search).get("url") ?? "";
  await report("warningShown", { url: target });

  if (target.includes("/shutdown")) {
    await report("done");
    for (const win of await browser.windows.getAll()) await browser.windows.remove(win.id);
    return;
  }
  if (target.includes("/after-idle")) {
    // 休止後に同じホストへ遷移するページと、最後に終了させるページを開いてから「開く」を押す
    await browser.tabs.create({ url: LOG_URL.replace("/log", "/step-second"), active: false });
    await browser.tabs.create({ url: LOG_URL.replace("/log", "/step-shutdown"), active: false });
    document.getElementById("proceed").click();
  }
})();
