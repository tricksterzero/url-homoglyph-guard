const ORIGINS = { origins: ["<all_urls>"] };
const status = document.getElementById("status");
const grant = document.getElementById("grant");

async function refresh() {
  const granted = await browser.permissions.contains(ORIGINS);
  grant.disabled = granted;
  status.textContent = granted ? "許可されています。このタブは閉じてかまいません。" : "まだ許可されていません。";
}

grant.addEventListener("click", async () => {
  // permissions.request はユーザー操作の中で呼ぶ必要がある
  await browser.permissions.request(ORIGINS);
  await refresh();
});

refresh();
