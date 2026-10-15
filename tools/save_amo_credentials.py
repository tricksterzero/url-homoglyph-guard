"""AMO の API キーを、画面に表示せずに入力してリポジトリ外の JSON へ保存する。

使い方（自分のターミナルで実行する。Claude Code の `!` 経由では入力できない）:
    python tools/save_amo_credentials.py
保存先: ~/.amo/credentials.json

保存先フォルダは継承を外して現在のユーザーだけに権限を与える。そのうえで、フォルダの所有者が
現在のユーザーで、許可の規則が現在のユーザーのものだけであることを SID で確かめてから値を入力させる
（他者が所有するフォルダだと、所有者は後から権限を書き換えられるため）。ファイルは新しく作ってから置き換え、
置き換え前後の権限も同じ条件で確かめる。
"""
import base64
import getpass
import json
import os
import pathlib
import subprocess
import sys

CREDENTIALS = pathlib.Path.home() / ".amo" / "credentials.json"
CURRENT_USER = f"{os.environ['USERDOMAIN']}\\{os.environ['USERNAME']}"

# セキュリティ記述子を SID で読み出す。対象のパスは環境変数 ACL_TARGET で受け取る
ACL_SCRIPT = """
$ErrorActionPreference = 'Stop'
$sidType = [System.Security.Principal.SecurityIdentifier]
$acl = Get-Acl -LiteralPath $env:ACL_TARGET
$rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); inherited = $_.IsInherited }
})
@{
  current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  owner = $acl.GetOwner($sidType).Value
  protected = $acl.AreAccessRulesProtected
  rules = $rules
} | ConvertTo-Json -Compress -Depth 3
"""


def fail(message: str) -> "NoReturn":
    print(f"中止: {message}", file=sys.stderr)
    sys.exit(1)


def icacls(*args: str) -> None:
    result = subprocess.run(["icacls", *args], capture_output=True, text=True)
    if result.returncode != 0:
        fail(f"icacls {args[0]} が失敗しました（終了コード {result.returncode}）")


def read_acl(path: pathlib.Path) -> dict:
    encoded = base64.b64encode(ACL_SCRIPT.encode("utf-16-le")).decode("ascii")
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
        capture_output=True,
        text=True,
        env={**os.environ, "ACL_TARGET": str(path)},
    )
    if result.returncode != 0:
        fail(f"{path} の権限を読み取れませんでした")
    return json.loads(result.stdout)


def ensure_only_current_user(path: pathlib.Path, *, require_protected: bool) -> None:
    acl = read_acl(path)
    if acl["owner"] != acl["current"]:
        fail(f"{path} の所有者が現在のユーザーではありません（所有者 SID: {acl['owner']}）")
    if require_protected and not acl["protected"]:
        fail(f"{path} が親フォルダの権限を継承しています")
    others = sorted({r["sid"] for r in acl["rules"] if r["type"] == "Allow" and r["sid"] != acl["current"]})
    if others:
        fail(f"{path} に本人以外への許可が残っています（SID: {', '.join(others)}）")


def main() -> int:
    directory = CREDENTIALS.parent
    directory.mkdir(exist_ok=True)
    icacls(str(directory), "/inheritance:r", "/grant:r", f"{CURRENT_USER}:(OI)(CI)F")
    ensure_only_current_user(directory, require_protected=True)

    print("https://addons.mozilla.org/developers/addon/api/key/ で発行した値を入力してください。")
    api_key = input("JWT issuer (api_key, 例: user:12345:67): ").strip()
    api_secret = getpass.getpass("JWT secret (api_secret, 入力は表示されません): ").strip()
    if not api_key or not api_secret:
        fail("両方の値が必要です。")

    # 既存ファイルの権限に依存しないよう、新しいファイルに書いてから置き換える
    temporary = directory / f"credentials.{os.getpid()}.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps({"api_key": api_key, "api_secret": api_secret}))
    try:
        ensure_only_current_user(temporary, require_protected=False)
    except SystemExit:
        temporary.unlink(missing_ok=True)
        raise
    os.replace(temporary, CREDENTIALS)
    ensure_only_current_user(CREDENTIALS, require_protected=False)
    print(f"保存しました: {CREDENTIALS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
