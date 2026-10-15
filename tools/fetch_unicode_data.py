"""Unicode の判定用データと出典資料を取得して、原本のまま保存する。

使い方: python tools/fetch_unicode_data.py
"""
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UNICODE_VERSION = "18.0.0"

TARGETS = {
    # 拡張機能に同梱するデータ
    f"data/unicode/confusables.txt": f"https://www.unicode.org/Public/{UNICODE_VERSION}/security/confusables.txt",
    f"data/unicode/Scripts.txt": f"https://www.unicode.org/Public/{UNICODE_VERSION}/ucd/Scripts.txt",
    "data/unicode/license.txt": "https://www.unicode.org/license.txt",
    # 判定方法の根拠
    "docs/sources/tr39.html": "https://www.unicode.org/reports/tr39/",
}


def main() -> None:
    for rel_path, url in TARGETS.items():
        dest = ROOT / rel_path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=60) as response:
            body = response.read()
        dest.write_bytes(body)
        print(f"{len(body):>9} bytes  {rel_path}  <- {url}")


if __name__ == "__main__":
    main()
