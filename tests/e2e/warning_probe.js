// E2E テスト（security シナリオ）専用。警告ページに追加し、表示された場所と操作できる状態かを報告する。
// iframe に埋め込まれた場合、拡張機能側からは様子が見えないため、このページ自身に報告させる。
setTimeout(() => {
  fetch("__LOG_URL__", {
    method: "POST",
    body: JSON.stringify({
      event: "warningProbe",
      href: location.href,
      framed: window.top !== window,
      proceedHidden: document.getElementById("proceed").hidden,
      backHidden: document.getElementById("back").hidden,
    }),
  }).catch(() => {});
}, 1000);
