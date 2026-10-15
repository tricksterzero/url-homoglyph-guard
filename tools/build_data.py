"""data/unicode/ の原本から、拡張機能が読み込む JS データを生成する。

使い方: python tools/build_data.py
生成物: extension/data/confusables.js, extension/data/names.js, extension/data/scripts.js
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "data" / "unicode"
OUT_DIR = ROOT / "extension" / "data"

# 例: "0430 ;\t0061 ;\tMA\t# ( а → a ) CYRILLIC SMALL LETTER A → LATIN SMALL LETTER A\t# "
CONFUSABLE_LINE = re.compile(r"^([0-9A-F]+) ;\t([0-9A-F ]+) ;\tMA\t#\*? (.*)$")
# コメント中の "( 元 → 先 ) 元の名前 → 先の名前" から元の文字の名前を取り出す
SOURCE_NAME = re.compile(r"\) ([A-Z0-9][A-Z0-9 \-]*?) → ")
SCRIPT_LINE = re.compile(r"^[0-9A-F.]+\s*; (\w+) #")
VERSION_LINE = re.compile(r"^# Version: (\S+)")


def to_str(hex_seq: str) -> str:
    return "".join(chr(int(cp, 16)) for cp in hex_seq.split())


def parse_confusables():
    prototypes, names, version = {}, {}, None
    with (SRC_DIR / "confusables.txt").open(encoding="utf-8-sig") as f:
        for line in f:
            if version is None and (m := VERSION_LINE.match(line)):
                version = m.group(1)
            m = CONFUSABLE_LINE.match(line.rstrip("\n"))
            if not m:
                continue
            source = to_str(m.group(1))
            prototypes[source] = to_str(m.group(2))
            if n := SOURCE_NAME.search(m.group(3)):
                names[source] = n.group(1)
    return version, prototypes, names


def parse_script_names():
    names = set()
    with (SRC_DIR / "Scripts.txt").open(encoding="utf-8") as f:
        first = f.readline()
        for line in f:
            if m := SCRIPT_LINE.match(line):
                names.add(m.group(1))
    return first.strip("# \n"), sorted(names)


def write_js(path: pathlib.Path, source_note: str, key: str, value) -> None:
    body = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)
    text = (
        f"// {source_note} から tools/build_data.py で生成。手で編集しない。\n"
        "// Copyright (c) 1991-2026 Unicode, Inc. Unicode License v3 (LICENSE-unicode.txt) に従う。\n"
        f"(globalThis.UrlSanitizerData ??= {{}}).{key} = {body};\n"
    )
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"{path.relative_to(ROOT)}: {len(value)} entries, {len(text.encode())} bytes")


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    version, prototypes, names = parse_confusables()
    write_js(OUT_DIR / "confusables.js", f"confusables.txt {version}", "prototypes", prototypes)
    write_js(OUT_DIR / "names.js", f"confusables.txt {version}", "names", names)
    scripts_file, script_names = parse_script_names()
    write_js(OUT_DIR / "scripts.js", scripts_file, "scriptNames", script_names)
    license_src = (SRC_DIR / "license.txt").read_bytes()
    (ROOT / "extension" / "LICENSE-unicode.txt").write_bytes(license_src)


if __name__ == "__main__":
    main()
