// 拡張機能のページの多言語対応。文言は _locales/<言語>/messages.json にあり、ブラウザの言語で選ばれる。
// HTML の data-i18n 属性を持つ要素には、その名前の文言を textContent で入れる。
(() => {
  function t(key, substitutions) {
    const values = substitutions === undefined ? undefined : [].concat(substitutions).map(String);
    return browser.i18n.getMessage(key, values);
  }

  function localizePage() {
    document.documentElement.lang = browser.i18n.getUILanguage();
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.textContent = t(element.dataset.i18n);
    }
  }

  globalThis.UrlSanitizerI18n = { t, localizePage };
})();
