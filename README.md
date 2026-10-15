# URL Homoglyph Guard

見た目が紛らわしい国際化ドメインを、ページを開く前に警告する Firefox 拡張機能（Manifest V3）。

例: `аmazon.com` の先頭はキリル文字の `а`（U+0430）で、実際のドメインは `xn--mazon-3ve.com`。`amazon.com` とは別のサイトになる。

## 仕組み

- `webRequest.onBeforeRequest`（`"blocking"`、`types: ["main_frame"]`）で、ページ本体の読み込みを開始前に捕まえる。ネットワーク要求の段階で捕まえるため、遷移の起点（アドレスバーへの入力、ブックマーク、他のアプリから開いたリンクなど）を問わない想定。実機で確認したのは、拡張機能からのタブ作成とページ内リンクのクリックの 2 通り。
- Firefox はリスナーにホスト名を Punycode 形式（`xn--...`）で渡す（Firefox 158 で確認）。`xn--` を含むホストだけをデコードして判定する。
- 紛らわしいと判定したら警告ページ（`extension/warning/warning.html`）へ転送する。「危険を理解して開く」を選んだホストは、ブラウザを閉じるまで（`storage.session`）警告しない。
- MV3 のバックグラウンドは数秒操作がないと休止する（Firefox の既定は 30 秒）。休止中でも、ページ本体の読み込みでバックグラウンドが起動して転送されること、休止・再開後も許可が残ることを E2E テストで確認した。
- 外部への通信は一切しない（`data_collection_permissions: none`）。

## 判定ルール

[UTS #39 Unicode Security Mechanisms](https://www.unicode.org/reports/tr39/) v18.0.0（原本: `docs/sources/tr39.html`）に基づき、ドメインのラベルごとに判定する。

| 判定 | 内容 | 例 |
|---|---|---|
| ASCII に見える | ASCII 以外の文字を含むのに、skeleton がすべて ASCII になる | `аmazon`、`аррӏе`（すべてキリル文字）、`gοοgle`（ギリシャ文字の ο） |
| 文字体系の混在 | Restriction Level が Highly Restrictive より緩い | `pаypal-ログイン`（ラテン文字 + キリル文字 + カタカナ） |
| デコード不能 | `xn--` ラベルを Punycode として解読できない | |

- ラテン文字と日本語・中国語・韓国語の組み合わせ（`abc漢字`、`ひらがなabc`）は Highly Restrictive に含まれるので警告しない。
- Firefox 自身も混在したラベルを Punycode で表示するが、すべて同じ文字体系で書かれた紛らわしいドメイン（例: `ѕсоре`）は許している（[MozillaWiki: IDN Display Algorithm](https://wiki.mozilla.org/IDN_Display_Algorithm)、最終更新 2017 年。現行の Firefox の動作は未確認）。この拡張機能は、そうしたドメインも ASCII に見えるかどうかで検出する。
- 既知の誤検知: すべての文字が ASCII と見分けにくいキリル文字の正規ドメイン（例: `сбер.рф` → `c6ep`、`рус.рф` → `pyc`）。警告から開くことはできる。
- 実装上の省略: skeleton の bidi 並べ替え（右から左へ書く文字を含むラベルでは近似）、識別子プロファイルの検査（IDNA 側の制約に任せる）、5.3 Mixed-Number Detection。

## 未検証の点

- 警告ページの「開かずに戻る」ボタン
- ホスト権限が外れているときの案内ページ（`extension/setup/`）
- アドレスバーへの入力・ブックマーク・他のアプリから開いた場合の実機での動作
- 署名して常用インストールした状態での動作

## 使い方

### 試す（一時インストール）

1. Firefox で `about:debugging` を開き、「This Firefox」を選ぶ。
2. 「Load Temporary Add-on」で `extension/manifest.json` を選ぶ。

ボタン名は [Temporary installation in Firefox](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/) の英語表記（日本語版 Firefox での表示名は未確認）。一時インストールした拡張機能は、削除するか Firefox を再起動するまで有効。

### 常用する

リリース版の Firefox では、Mozilla の署名が必要。AMO に公開せず自分だけで使う（unlisted）場合も署名を受けられる（[Signing and distribution overview](https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/)）。

## 開発

```powershell
# Unicode データの原本を取得（data/unicode/, docs/sources/）
python tools/fetch_unicode_data.py
# 拡張機能が読み込む JS データを生成（extension/data/）
python tools/build_data.py
# 単体テスト（判定ロジック・Punycode）
node --test tests/detector.test.js
# E2E テスト（web-ext が一時プロファイルで Firefox を 2 回起動する。普段のプロファイルには触れない）
#   basic: 転送・警告ページの表示・「開く」操作・許可の記憶
#   idle : バックグラウンドの休止時間を 1 秒にして、休止中の転送と許可の保持
python tests/e2e/run_e2e.py --screenshot <保存先.png>
# manifest などの検査
web-ext lint --source-dir extension
```

## ライセンス

`extension/data/` と `data/unicode/` の Unicode データは Unicode License v3（`extension/LICENSE-unicode.txt`）に従う。
