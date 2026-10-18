# URL Homoglyph Guard

[English](README.md)

見た目が紛らわしい国際化ドメインを、ページを開く前に警告する Firefox 拡張機能（Manifest V3）。画面は英語と日本語に対応し、ブラウザの言語に合わせて表示する。

例: `аmazon.com` の先頭はキリル文字の `а`（U+0430）で、実際のドメインは `xn--mazon-3ve.com`。`amazon.com` とは別のサイトになる。

## 仕組み

- `webRequest.onBeforeRequest`（`"blocking"`、`types: ["main_frame"]`）で、ページ本体の読み込みが始まる前に要求を捕まえる。ネットワーク要求の段階で捕まえるため、遷移の起点（アドレスバーへの入力、ブックマーク、他のアプリから開いたリンクなど）を問わない想定。実機で確認したのは、拡張機能からのタブ作成、ページ内リンクのクリック、アドレスバーへの入力の 3 通り。
- Firefox はリスナーにホスト名を Punycode 形式（`xn--...`）で渡す（Firefox 158 で確認）。`xn--` を含むホストだけをデコードして判定する。
- 紛らわしいと判定したら警告ページ（`extension/warning/warning.html`）へ転送する。警告ページは Firefox 自身の警告画面に近い作りで、主な操作は「戻る（推奨）」。文字の一覧と「リスクを理解して開く」は「詳細」の中にある。開くことを選んだホストは、ブラウザを閉じるまで（`storage.session`）警告しない。
- HTTP リダイレクトの転送先も同じように捕まえる（302 で確認）。警告中は相手のサーバーに要求が届かない。
- MV3 のバックグラウンドは、しばらく操作がないと休止する（Firefox の既定は 30 秒）。休止中でも、ページ本体の読み込みでバックグラウンドが起動して転送されること、休止・再開後も許可が残ることを E2E テストで確認した。
- 外部への通信は一切しない（`data_collection_permissions: none`）。
- 設定ページ（`extension/setup/`）で、アクセント付きの紛らわしいドメインを警告するかを切り替えられる。既定は警告する。設定は `storage.local` に保存する。設定ページはアドオンの管理画面からも開ける。
- プライベートウィンドウでは、Firefox の既定で拡張機能が動かない。インストール時に許可されていなければ設定ページを開いて案内する。

### 警告ページの保護

警告ページは転送先にするため web_accessible_resources に載せており、Web ページからもリンク・埋め込みができる（[MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources)）。偽の警告ページで「開く」を押させて許可リストを汚染されないよう、次の対策をしている。

- 転送するたびに、そのタブと URL に結び付けた使い捨てのトークン（有効期限 1 時間）を発行する。トークンが有効なときだけ「開く」を表示し、許可と移動先の URL はバックグラウンドの記録から決める。
- バックグラウンドは、タブの最上位フレームに表示された自分の警告ページからのメッセージだけを受け付ける。
- 他のページに埋め込まれた場合は操作ボタンを出さない。CSP に `frame-ancestors 'none'` も指定している（Firefox が拡張機能ページの CSP でこれを有効にするかは未確認。E2E テストでは埋め込んだ警告ページは実行されなかった）。
- 移動先にリファラーを渡さない（`no-referrer`）。
- blocking リスナーで例外や reject が起きると、Firefox は要求をそのまま続行する（`toolkit/components/extensions/webrequest/WebRequest.sys.mjs` の `applyChanges`）。そのため、判定やトークンの保存に失敗した場合は、トークンのない警告ページへ転送し、ページを読み込ませない。トークンがないので、その警告ページからはサイトを開けない。設定を読み込めない場合も警告する。
- トークンはタブごとに 1 つだけ残し、期限切れは発行時に消す。許可はトークンを消費してから保存し、どちらかが失敗したら許可しない。

## 判定ルール

[UTS #39 Unicode Security Mechanisms](https://www.unicode.org/reports/tr39/) v18.0.0（原本: `docs/sources/tr39.html`）に基づき、ドメインのラベルごとに判定する。

| 判定 | 内容 | 例 |
|---|---|---|
| ASCII に見える | ASCII 以外の文字を含むのに、skeleton がすべて ASCII になる | `аmazon`、`аррӏе`（すべてキリル文字）、`gοοgle`（ギリシャ文字の ο） |
| 記号を除くと ASCII に見える | skeleton から結合記号（アクセントなど）を除くとすべて ASCII になる（UTS #39 の外側で追加した判定。設定で無効にできる） | `аррӏе` + U+0301、`amazọn`、`münchen` |
| 文字体系の混在 | Restriction Level が Highly Restrictive より緩い | `pаypal-ログイン`（ラテン文字 + キリル文字 + カタカナ） |
| デコード不能 | `xn--` ラベルを Punycode として解読できない | |

- ラテン文字と日本語・中国語・韓国語の組み合わせ（`abc漢字`、`ひらがなabc`）は Highly Restrictive に含まれるので警告しない。
- Firefox 自身も混在したラベルを Punycode で表示するが、すべて同じ文字体系で書かれた紛らわしいドメイン（例: `ѕсоре`）は許している。出典は [MozillaWiki: IDN Display Algorithm](https://wiki.mozilla.org/IDN_Display_Algorithm)（最終更新 2017 年）で、現行の Firefox の動作は未確認。この拡張機能は、そうしたドメインも ASCII に見えるかどうかで検出する。
- 既知の誤検知: すべての文字が ASCII と見分けにくいキリル文字の正規ドメイン（例: `сбер.рф` → `c6ep`、`рус.рф` → `pyc`）と、アクセント付きのラテン文字の正規ドメイン（例: `münchen.de`。設定で無効にできる）。警告から開くことはできる。
- 実装上の省略: skeleton の bidi 並べ替え（右から左へ書く文字を含むラベルでは近似）、識別子プロファイルの検査（IDNA 側の制約に任せる）、5.3 Mixed-Number Detection。

## 未検証の点

- 警告ページの「戻る（推奨）」ボタン
- 設定ページの権限要求ボタン（表示とインストール時に開くことは確認済み）
- プライベートウィンドウを許可した場合の実機での動作
- ブックマーク・他のアプリから開いた場合の実機での動作

## 使い方

### インストール

[Firefox Add-ons（AMO）](https://addons.mozilla.org/ja/firefox/addon/url-homoglyph-guard/)からインストールできる。

### 試す（一時インストール）

1. Firefox で `about:debugging` を開き、「This Firefox」を選ぶ。
2. 「Load Temporary Add-on」で `extension/manifest.json` を選ぶ。

ボタン名は [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) の英語表記（日本語版 Firefox での表示名は未確認）。一時インストールした拡張機能は、削除するか Firefox を再起動するまで有効。

### 署名する（自分で配布・AMO で公開）

リリース版の Firefox では、Mozilla の署名が必要（[Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)）。

1. https://addons.mozilla.org/developers/addon/api/key/ で API キー（JWT issuer と JWT secret）を発行する。発行済みのキーの画面では JWT secret が伏せ字（先頭と末尾の 16 進数の間が `.`）で表示されるので、伏せ字のない値は再生成した直後に取得する。
2. 自分のターミナルで `python tools/save_amo_credentials.py` を実行し、2 つの値を入力する。シークレットは画面に表示されない。保存先は `~/.amo/credentials.json` で、`~/.amo` は現在のユーザーだけがアクセスできる権限になる。所有者や権限、値の形式（AMO の発行形式）が想定と違えば保存しない。
3. 変更をすべてコミットしてから実行する。
   - 自分で配布: `python tools/sign.py`
   - AMO で一般公開: `python tools/sign.py --channel listed`（`amo/metadata.json` の掲載情報も送る）

   HEAD を `git archive` で書き出し、展開したものの `extension/` に署名する。ソース一式（`dist/source-<版>-<コミット>.zip`）も一緒に提出する。署名済みの `.xpi` は `dist/` に保存され、提出した `extension/` と一致するかを照合する（`manifest.json` は署名時に書式が変わるため JSON の内容で比べる）。
4. 自分で配布する場合は、Firefox の「アドオンとテーマ」（about:addons）の歯車メニューの「Install Add-on From File」で `.xpi` を選ぶ（手順は [Installing self-distributed extensions](https://extensionworkshop.com/documentation/publish/install-self-distributed/) の英語表記）。

#### 注意

- 同じバージョン番号は再提出できない。更新するときは `extension/manifest.json` の `version` を上げてコミットする。
- 拡張機能の ID（`url-homoglyph-guard@local.invalid`）は署名すると変えられない（変えると別の拡張機能になる）。

## 開発

```powershell
# Unicode データの原本を取得（data/unicode/, docs/sources/）
python tools/fetch_unicode_data.py
# 拡張機能が読み込む JS データを生成（extension/data/）
python tools/build_data.py
# 単体テスト（判定ロジック・Punycode、browser API を模擬したバックグラウンドの異常系・設定、文言ファイルの整合性）
node --test tests/detector.test.js tests/background.test.js tests/i18n.test.js
# E2E テスト（web-ext が一時プロファイルで Firefox を 3 回起動する。普段のプロファイルには触れない）
#   紛らわしいホストは network.dns.localDomains でテスト用サーバー（127.0.0.1）に向け、要求が届いたかも確かめる
#   basic   : 転送・警告ページの表示・「開く」操作・許可の記憶・インストール時の設定ページ
#   security: リダイレクト経由の転送、偽造・埋め込み・トークン再利用した警告ページからは許可できないこと、リファラー
#   idle    : バックグラウンドの休止時間を 1 秒にして、休止中の転送と許可の保持
python tests/e2e/run_e2e.py --screenshot <保存先.png>   # --only <シナリオ>、--pref <設定>=<値>（繰り返し可）
# 例: 英語・明るい表示で撮影
python tests/e2e/run_e2e.py --only basic --pref intl.locale.requested=en-US --pref layout.css.prefers-color-scheme.content-override=1 --screenshot en.png
# manifest などの検査
web-ext lint --source-dir extension
```

文言は `extension/_locales/en/messages.json`（既定）と `extension/_locales/ja/messages.json` にある。HTML では `data-i18n` 属性、スクリプトでは `UrlSanitizerI18n.t()`（`extension/lib/i18n.js`）で使う。

## ライセンス

MIT（`LICENSE`）。ただし `data/unicode/` と、そこから生成した `extension/data/` の Unicode データは Unicode License v3（`data/unicode/license.txt`、`extension/LICENSE-unicode.txt`）に従う。
