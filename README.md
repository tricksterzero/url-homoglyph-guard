# URL Homoglyph Guard

見た目が紛らわしい国際化ドメインを、ページを開く前に警告する Firefox 拡張機能（Manifest V3）。

例: `аmazon.com` の先頭はキリル文字の `а`（U+0430）で、実際のドメインは `xn--mazon-3ve.com`。`amazon.com` とは別のサイトになる。

## 仕組み

- `webRequest.onBeforeRequest`（`"blocking"`、`types: ["main_frame"]`）で、ページ本体の読み込みを開始前に捕まえる。ネットワーク要求の段階で捕まえるため、遷移の起点（アドレスバーへの入力、ブックマーク、他のアプリから開いたリンクなど）を問わない想定。実機で確認したのは、拡張機能からのタブ作成とページ内リンクのクリックの 2 通り。
- Firefox はリスナーにホスト名を Punycode 形式（`xn--...`）で渡す（Firefox 158 で確認）。`xn--` を含むホストだけをデコードして判定する。
- 紛らわしいと判定したら警告ページ（`extension/warning/warning.html`）へ転送する。警告ページは Firefox 自身の警告画面に近い作りで、主な操作は「戻る（推奨）」。文字の一覧と「リスクを理解して開く」は「詳細」の中にある。開くことを選んだホストは、ブラウザを閉じるまで（`storage.session`）警告しない。
- HTTP リダイレクトの転送先も同じように捕まえる（302 で確認）。警告中は相手のサーバーに要求が届かない。
- MV3 のバックグラウンドは数秒操作がないと休止する（Firefox の既定は 30 秒）。休止中でも、ページ本体の読み込みでバックグラウンドが起動して転送されること、休止・再開後も許可が残ることを E2E テストで確認した。
- 外部への通信は一切しない（`data_collection_permissions: none`）。
- プライベートウィンドウでは、Firefox の既定で拡張機能が動かない。インストール時に許可されていなければ案内ページ（`extension/setup/`、アドオンの設定からも開ける）を表示する。

### 警告ページの保護

警告ページは転送先にするため web_accessible_resources に載せており、Web ページからもリンク・埋め込みができる（[MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/web_accessible_resources)）。偽の警告ページで「開く」を押させて許可リストを汚染されないよう、次の対策をしている。

- 転送するたびに、そのタブと URL に結び付けた使い捨てのトークン（有効期限 1 時間）を発行する。トークンが有効なときだけ「開く」を表示し、許可と移動先の URL はバックグラウンドの記録から決める。
- バックグラウンドは、タブの最上位フレームに表示された自分の警告ページからのメッセージだけを受け付ける。
- 他のページに埋め込まれた場合は操作ボタンを出さない。CSP に `frame-ancestors 'none'` も指定している（Firefox が拡張機能ページの CSP でこれを有効にするかは未確認。E2E テストでは埋め込んだ警告ページは実行されなかった）。
- 移動先にリファラーを渡さない（`no-referrer`）。
- blocking リスナーで例外や reject が起きると、Firefox は要求をそのまま続行する（`toolkit/components/extensions/webrequest/WebRequest.sys.mjs` の `applyChanges`）。そのため、判定やトークンの保存に失敗した場合は、トークンなし（＝そこからは開けない）の警告ページへ転送し、読み込ませない。
- トークンはタブごとに 1 つだけ残し、期限切れは発行時に消す。許可はトークンを消費してから保存し、どちらかが失敗したら許可しない。

## 判定ルール

[UTS #39 Unicode Security Mechanisms](https://www.unicode.org/reports/tr39/) v18.0.0（原本: `docs/sources/tr39.html`）に基づき、ドメインのラベルごとに判定する。

| 判定 | 内容 | 例 |
|---|---|---|
| ASCII に見える | ASCII 以外の文字を含むのに、skeleton がすべて ASCII になる | `аmazon`、`аррӏе`（すべてキリル文字）、`gοοgle`（ギリシャ文字の ο） |
| 記号を除くと ASCII に見える | skeleton から結合記号（アクセントなど）を除くとすべて ASCII になる（UTS #39 の外側で追加した判定） | `аррӏе` + U+0301、`amazọn`、`münchen` |
| 文字体系の混在 | Restriction Level が Highly Restrictive より緩い | `pаypal-ログイン`（ラテン文字 + キリル文字 + カタカナ） |
| デコード不能 | `xn--` ラベルを Punycode として解読できない | |

- ラテン文字と日本語・中国語・韓国語の組み合わせ（`abc漢字`、`ひらがなabc`）は Highly Restrictive に含まれるので警告しない。
- Firefox 自身も混在したラベルを Punycode で表示するが、すべて同じ文字体系で書かれた紛らわしいドメイン（例: `ѕсоре`）は許している（[MozillaWiki: IDN Display Algorithm](https://wiki.mozilla.org/IDN_Display_Algorithm)、最終更新 2017 年。現行の Firefox の動作は未確認）。この拡張機能は、そうしたドメインも ASCII に見えるかどうかで検出する。
- 既知の誤検知: すべての文字が ASCII と見分けにくいキリル文字の正規ドメイン（例: `сбер.рф` → `c6ep`、`рус.рф` → `pyc`）と、アクセント付きのラテン文字の正規ドメイン（例: `münchen.de`）。警告から開くことはできる。後者はアクセントによる偽装（`amazọn`）を防ぐために意図して警告している。
- 実装上の省略: skeleton の bidi 並べ替え（右から左へ書く文字を含むラベルでは近似）、識別子プロファイルの検査（IDNA 側の制約に任せる）、5.3 Mixed-Number Detection。

## 未検証の点

- 警告ページの「戻る（推奨）」ボタン
- 案内ページ（`extension/setup/`）の権限要求ボタンと表示（インストール時に開くことだけ確認済み）
- プライベートウィンドウを許可した場合の実機での動作
- アドレスバーへの入力・ブックマーク・他のアプリから開いた場合の実機での動作
- 署名して常用インストールした状態での動作（`tools/sign.py` の AMO への提出部分も未実行）

## 使い方

### 試す（一時インストール）

1. Firefox で `about:debugging` を開き、「This Firefox」を選ぶ。
2. 「Load Temporary Add-on」で `extension/manifest.json` を選ぶ。

ボタン名は [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) の英語表記（日本語版 Firefox での表示名は未確認）。一時インストールした拡張機能は、削除するか Firefox を再起動するまで有効。

### 常用する（署名してインストール）

リリース版の Firefox では、Mozilla の署名が必要。AMO に公開せず自分だけで使う（unlisted）場合も署名を受けられる（[Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)）。

1. https://addons.mozilla.org/developers/addon/api/key/ で API キー（JWT issuer と JWT secret）を発行する。
2. 自分のターミナルで `python tools/save_amo_credentials.py` を実行し、2 つの値を入力する。シークレットは画面に表示されない。保存先は `~/.amo/credentials.json` で、`~/.amo` は現在のユーザーだけがアクセスできる権限になる。フォルダやファイルの所有者が自分でない、または本人以外への許可が残っている場合は、値を入力する前（ファイルは置き換える前）に中止する。
3. 変更をすべてコミットしてから `python tools/sign.py` を実行する。HEAD を `git archive` で書き出し、展開したものの `extension/` に署名する。ソース一式（`dist/source-<版>-<コミット>.zip`）も一緒に提出する。署名済みの `.xpi` は `dist/` に保存される。
4. Firefox の「アドオンとテーマ」（about:addons）を開き、歯車メニューの「Install Add-on From File」で `.xpi` を選び、「Add」を押す（手順は [Installing self-distributed extensions](https://extensionworkshop.com/documentation/publish/install-self-distributed/) の英語表記）。

注意:

- 同じ版番号は再提出できない。更新するときは `extension/manifest.json` の `version` を上げてコミットする。
- `update_url` を付けていないので自動更新はされない。新しい版は同じ手順でインストールし直す。
- 拡張機能の ID（`url-homoglyph-guard@local.invalid`）は署名すると変えられない（変えると別の拡張機能になる）。

### 審査担当者向けのビルド手順（提出ソースに含まれる）

- 環境: Windows 11、Python 3.14（標準ライブラリのみ）。
- `extension/data/*.js` は、同梱の `data/unicode/*.txt`（Unicode 18.0.0 の原本）から `python tools/build_data.py` で生成する。原本は再取得しない（`tools/fetch_unicode_data.py` は原本の更新用）。
- 生成後の `extension/` ディレクトリをそのまま ZIP にしたものが拡張機能のパッケージ（`web-ext build --source-dir extension` と同じ）。ほかに変換・圧縮・バンドルはしていない。

## 開発

```powershell
# Unicode データの原本を取得（data/unicode/, docs/sources/）
python tools/fetch_unicode_data.py
# 拡張機能が読み込む JS データを生成（extension/data/）
python tools/build_data.py
# 単体テスト（判定ロジック・Punycode、browser API を模擬したバックグラウンドの異常系）
node --test tests/detector.test.js tests/background.test.js
# E2E テスト（web-ext が一時プロファイルで Firefox を 3 回起動する。普段のプロファイルには触れない）
#   紛らわしいホストは network.dns.localDomains でテスト用サーバー（127.0.0.1）に向け、要求が届いたかも確かめる
#   basic   : 転送・警告ページの表示・「開く」操作・許可の記憶・インストール時の案内ページ
#   security: リダイレクト経由の転送、偽造・埋め込み・トークン再利用した警告ページからは許可できないこと、リファラー
#   idle    : バックグラウンドの休止時間を 1 秒にして、休止中の転送と許可の保持
python tests/e2e/run_e2e.py --screenshot <保存先.png>   # --only <シナリオ> で 1 つだけ実行
# manifest などの検査
web-ext lint --source-dir extension
```

## ライセンス

`extension/data/` と `data/unicode/` の Unicode データは Unicode License v3（`extension/LICENSE-unicode.txt`）に従う。
