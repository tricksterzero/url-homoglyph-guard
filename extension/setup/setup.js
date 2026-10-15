const ORIGINS = { origins: ["<all_urls>"] };
const hostStatus = document.getElementById("host-status");
const incognitoStatus = document.getElementById("incognito-status");
const grant = document.getElementById("grant");

async function refresh() {
  const granted = await browser.permissions.contains(ORIGINS);
  grant.hidden = granted;
  hostStatus.textContent = granted ? "許可されています。" : "まだ許可されていません。警告は表示されません。";
  const incognito = await browser.extension.isAllowedIncognitoAccess();
  incognitoStatus.textContent = incognito
    ? "プライベートウィンドウでも動作します。"
    : "プライベートウィンドウでは動作しません（許可すると次に開いたときに反映されます）。";
}

grant.addEventListener("click", async () => {
  // permissions.request はユーザー操作の中で呼ぶ必要がある
  await browser.permissions.request(ORIGINS);
  await refresh();
});

refresh();
