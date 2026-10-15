"""AMO の API キーを、画面に表示せずに入力してリポジトリ外の JSON へ保存する。

使い方（自分のターミナルで実行する。Claude Code の `!` 経由では入力できない）:
    python tools/save_amo_credentials.py
保存先: ~/.amo/credentials.json
保存先フォルダは継承を外し、現在のユーザーだけがアクセスできる権限にする（icacls）。
"""
import getpass
import json
import os
import pathlib
import subprocess
import sys

CREDENTIALS = pathlib.Path.home() / ".amo" / "credentials.json"


def restrict_to_current_user(directory: pathlib.Path) -> None:
    user = f"{os.environ['USERDOMAIN']}\\{os.environ['USERNAME']}"
    subprocess.run(
        ["icacls", str(directory), "/inheritance:r", "/grant:r", f"{user}:(OI)(CI)F"],
        check=True,
        stdout=subprocess.DEVNULL,
    )


def main() -> int:
    print("https://addons.mozilla.org/developers/addon/api/key/ で発行した値を入力してください。")
    api_key = input("JWT issuer (api_key, 例: user:12345:67): ").strip()
    api_secret = getpass.getpass("JWT secret (api_secret, 入力は表示されません): ").strip()
    if not api_key or not api_secret:
        print("中止: 両方の値が必要です。", file=sys.stderr)
        return 1

    CREDENTIALS.parent.mkdir(exist_ok=True)
    restrict_to_current_user(CREDENTIALS.parent)
    CREDENTIALS.write_text(json.dumps({"api_key": api_key, "api_secret": api_secret}), encoding="utf-8")
    print(f"保存しました: {CREDENTIALS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
