"""AMO で拡張機能に署名し（unlisted = 自分で配布）、署名済みの .xpi を dist/ に保存する。

使い方: python tools/sign.py [--credentials <認証情報 JSON のパス>]
事前に python tools/save_amo_credentials.py で認証情報を保存しておく。

安全のための方針:
- 認証情報は web-ext の子プロセスの環境変数 WEB_EXT_API_KEY / WEB_EXT_API_SECRET でだけ渡す。
  コマンドライン引数・画面出力・ファイルには書き出さない。
- web-ext の設定ファイルは読み込ませない（--no-config-discovery）。設定ファイルと値が競合すると
  web-ext がデバッグログに両方の値を出すため（web-ext/lib/config.js）。
  引き継いだ WEB_EXT_* / NODE_OPTIONS / NODE_PATH も取り除き、node.exe から web-ext.js を直接起動する。
- 署名する内容と提出するソースを一致させるため、HEAD を git archive で書き出し、
  展開したものの extension/ に署名する。同じ展開物から extension/data/ を再生成し、
  コミット済みの生成物と一致することを確かめる。
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
DIST_DIR = ROOT / "dist"
DEFAULT_CREDENTIALS = pathlib.Path.home() / ".amo" / "credentials.json"
APPROVAL_TIMEOUT_MS = 15 * 60 * 1000


def fail(message: str) -> "NoReturn":
    print(f"中止: {message}", file=sys.stderr)
    sys.exit(1)


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True, capture_output=True, text=True).stdout


def find_web_ext() -> tuple[str, pathlib.Path]:
    node = shutil.which("node")
    shim = shutil.which("web-ext")
    if not node or not shim:
        fail("node または web-ext が見つかりません。")
    script = pathlib.Path(shim).parent / "node_modules" / "web-ext" / "bin" / "web-ext.js"
    if not script.is_file():
        fail(f"web-ext.js が見つかりません: {script}")
    return node, script


def load_credentials(path: pathlib.Path) -> tuple[str, str]:
    # 値を含むメッセージや例外を出さないよう、入力の誤りはすべて固定の文言で止める
    path = path.resolve()
    if path.is_relative_to(ROOT):
        fail(f"認証情報のファイルはリポジトリの外に置いてください: {path}")
    if not path.is_file():
        fail(f"認証情報のファイルがありません: {path}（python tools/save_amo_credentials.py で作成）")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        fail(f"認証情報のファイルを JSON として読めません: {path}")
    if not isinstance(data, dict):
        fail(f"認証情報のファイルの形式が違います: {path}")
    api_key, api_secret = data.get("api_key"), data.get("api_secret")
    if not (isinstance(api_key, str) and api_key and isinstance(api_secret, str) and api_secret):
        fail(f"{path} に api_key と api_secret（空でない文字列）が必要です。")
    # AMO が発行する形式（mozilla/addons-server の src/olympia/api/models.py）と違えば、提出前に止める
    if not re.fullmatch(r"user:\d+:\d+", api_key) or not re.fullmatch(r"[0-9a-f]{64,}", api_secret):
        fail(f"{path} の値が AMO の API キーの形式と違います。tools/save_amo_credentials.py で保存し直してください。")
    return api_key, api_secret


def file_hashes(directory: pathlib.Path) -> dict[str, str]:
    return {
        str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(directory.rglob("*"))
        if p.is_file()
    }


def prepare_source(work_dir: pathlib.Path, commit: str, version: str) -> tuple[pathlib.Path, pathlib.Path]:
    source_zip = DIST_DIR / f"source-{version}-{commit[:7]}.zip"
    git("archive", "--format=zip", "-o", str(source_zip), commit)
    tree = work_dir / "source"
    with zipfile.ZipFile(source_zip) as archive:
        archive.extractall(tree)
    # 提出するソースから生成物を再現できることを確かめる（生成物以外も含め extension/ 全体を比較する）
    extension_dir = tree / "extension"
    before = file_hashes(extension_dir)
    subprocess.run([sys.executable, str(tree / "tools" / "build_data.py")], check=True, capture_output=True)
    if file_hashes(extension_dir) != before:
        fail("data/unicode/ から再生成した extension/ がコミット済みのものと一致しません。")
    return source_zip, extension_dir


def verify_xpi(xpi: pathlib.Path, extension_dir: pathlib.Path) -> None:
    # 署名済み .xpi の中身が、署名に出した extension/ と同じファイル構成・内容であることを確かめる
    # （META-INF/ は署名、ドットファイルは web-ext がパッケージから除外するので比較しない）
    expected = {
        p.relative_to(extension_dir).as_posix(): p.read_bytes()
        for p in extension_dir.rglob("*")
        if p.is_file() and not any(part.startswith(".") for part in p.relative_to(extension_dir).parts)
    }
    with zipfile.ZipFile(xpi) as archive:
        actual = {
            name: archive.read(name)
            for name in archive.namelist()
            if not name.endswith("/") and not name.startswith("META-INF/")
        }
    if actual != expected:
        missing, extra = expected.keys() - actual.keys(), actual.keys() - expected.keys()
        changed = {k for k in expected.keys() & actual.keys() if expected[k] != actual[k]}
        fail(f"署名済み .xpi の内容が一致しません（不足 {sorted(missing)}, 余分 {sorted(extra)}, 相違 {sorted(changed)}）")


def child_env(api_key: str, api_secret: str) -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.upper().startswith("WEB_EXT_") and k.upper() not in {"NODE_OPTIONS", "NODE_PATH"}
    }
    env["WEB_EXT_API_KEY"] = api_key
    env["WEB_EXT_API_SECRET"] = api_secret
    return env


def read_xpi_manifest(xpi: pathlib.Path) -> dict:
    with zipfile.ZipFile(xpi) as archive:
        return json.loads(archive.read("manifest.json"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--credentials", type=pathlib.Path, default=DEFAULT_CREDENTIALS)
    args = parser.parse_args()

    node, web_ext_script = find_web_ext()
    if git("status", "--porcelain", "--untracked-files=all"):
        fail("未コミットの変更があります。コミットしてから実行してください。")
    commit = git("rev-parse", "HEAD").strip()
    manifest = json.loads(git("show", f"{commit}:extension/manifest.json"))
    version, addon_id = manifest["version"], manifest["browser_specific_settings"]["gecko"]["id"]
    api_key, api_secret = load_credentials(args.credentials)

    DIST_DIR.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="url-sanitizer-sign-") as tmp:
        source_zip, extension_dir = prepare_source(pathlib.Path(tmp), commit, version)
        print(f"commit: {commit}\nversion: {version}\nid: {addon_id}\nsource archive: {source_zip}")
        started = time.time()
        result = subprocess.run(
            [
                node, str(web_ext_script), "sign",
                "--no-config-discovery",
                "--channel", "unlisted",
                "--source-dir", str(extension_dir),
                "--artifacts-dir", str(DIST_DIR),
                "--upload-source-code", str(source_zip),
                "--approval-timeout", str(APPROVAL_TIMEOUT_MS),
            ],
            env=child_env(api_key, api_secret),
        )

        # 今回ダウンロードされ、ID・版・中身が一致する .xpi があるときだけ成功とする
        new_xpis = [
            p for p in DIST_DIR.glob("*.xpi")
            if p.stat().st_mtime >= started
            and read_xpi_manifest(p).get("version") == version
            and read_xpi_manifest(p).get("browser_specific_settings", {}).get("gecko", {}).get("id") == addon_id
        ]
        if result.returncode == 0 and len(new_xpis) == 1:
            verify_xpi(new_xpis[0], extension_dir)
            print(f"署名済み: {new_xpis[0]}")
            return 0
    print(
        "署名済みの .xpi を取得できませんでした。"
        "web-ext のエラーが \"Upload failed\" なら、アップロードの段階で失敗しており提出されていません。"
        f"それ以外は提出済みの可能性があるため、再実行する前に AMO の開発者ハブで {addon_id} の {version} を確認してください。"
        "（同じ版番号は再提出できません）",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
