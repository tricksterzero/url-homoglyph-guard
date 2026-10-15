// E2E テスト（休止シナリオ）専用。バックグラウンドが起動するたびに報告する。
// 休止後に再び起動したことを確かめるため、タイマーや待機は一切持たない。
fetch("__LOG_URL__", {
  method: "POST",
  body: JSON.stringify({ event: "bgStarted" }),
}).catch(() => {});
