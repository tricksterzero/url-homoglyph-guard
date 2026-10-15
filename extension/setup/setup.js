const { t, localizePage } = globalThis.UrlSanitizerI18n;

const ORIGINS = { origins: ["<all_urls>"] };
// 設定は storage.local に保存する。既定（未保存）は警告する
const WARN_ON_MARKS_KEY = "warnOnMarks";

const hostStatus = document.getElementById("host-status");
const incognitoStatus = document.getElementById("incognito-status");
const grant = document.getElementById("grant");
const warnOnMarks = document.getElementById("warn-on-marks");

async function refresh() {
  const granted = await browser.permissions.contains(ORIGINS);
  grant.hidden = granted;
  hostStatus.textContent = t(granted ? "hostGranted" : "hostNotGranted");
  const incognito = await browser.extension.isAllowedIncognitoAccess();
  incognitoStatus.textContent = t(incognito ? "incognitoAllowed" : "incognitoNotAllowed");
  const stored = await browser.storage.local.get(WARN_ON_MARKS_KEY);
  warnOnMarks.checked = stored[WARN_ON_MARKS_KEY] !== false;
}

grant.addEventListener("click", async () => {
  // permissions.request はユーザー操作の中で呼ぶ必要がある
  await browser.permissions.request(ORIGINS);
  await refresh();
});

warnOnMarks.addEventListener("change", async () => {
  await browser.storage.local.set({ [WARN_ON_MARKS_KEY]: warnOnMarks.checked });
});

localizePage();
refresh();
