"""一時プロファイルの Firefox に拡張機能を読み込み、実際の遷移で動作を確かめる。

使い方: python tests/e2e/run_e2e.py [--firefox <firefox.exe のパス>] [--screenshot <保存先.png>]
前提: web-ext (npm) と Firefox。普段使っているプロファイルには触れない（web-ext が一時プロファイルを作る）。

シナリオ:
  basic: 起動直後に遷移し、転送・警告ページの表示・「開く」操作・許可の記憶を確かめる。
  idle : バックグラウンドの休止時間を 1 秒にし、休止中の遷移でも転送されること、
         休止して再開した後も許可が残ることを確かめる。
"""
import argparse
import base64
import http.server
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXTENSION_DIR = ROOT / "extension"
HERE = pathlib.Path(__file__).resolve().parent


def page(script: str) -> bytes:
    # テスト用の Web ページ。report() は同じオリジンのログサーバーへ記録する
    return (
        '<!doctype html><meta charset="utf-8"><title>e2e</title>\n<script>\n'
        "const report = (event) => fetch('/log', {method: 'POST', body: JSON.stringify({event})});\n"
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n"
        f"{script}\n</script>\n"
    ).encode("utf-8")


PAGES = {
    "/start": page(
        "document.write('<a id=\"link\" href=\"http://gοοgle.test/from-link\">link</a>');\n"
        "setTimeout(() => document.getElementById('link').click(), 1000);"
    ),
    "/idle-start": page(
        "(async () => { await sleep(4000); await report('navigateFirst');"
        " location.href = 'http://аmazon.test/after-idle'; })();"
    ),
    "/step-second": page(
        "(async () => { await sleep(4000); await report('navigateSecond');"
        " location.href = 'http://аmazon.test/second'; })();"
    ),
    "/step-shutdown": page(
        "(async () => { await sleep(9000); await report('navigateShutdown');"
        " location.href = 'http://gοοgle.test/shutdown'; })();"
    ),
}


class LogServer(http.server.ThreadingHTTPServer):
    # Windows では再利用を許すと使用中のポートにも bind できてしまうため無効にする
    allow_reuse_address = False

    def __init__(self):
        self.events = []
        super().__init__(("127.0.0.1", 0), LogHandler)


class LogHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.events.append(json.loads(body))
        self._reply(b"ok", "text/plain")

    def do_GET(self):
        if self.path in PAGES:
            self._reply(PAGES[self.path], "text/html; charset=utf-8")
        else:
            self.send_response(404)
            self.end_headers()

    def _reply(self, body, ctype):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def add_script(ext_dir: pathlib.Path, src_name: str, dest_name: str, log_url: str) -> None:
    text = (HERE / src_name).read_text(encoding="utf-8").replace("__LOG_URL__", log_url)
    (ext_dir / dest_name).write_text(text, encoding="utf-8", newline="\n")


def prepare_extension(work_dir: pathlib.Path, scenario: str, log_url: str) -> pathlib.Path:
    ext_dir = work_dir / scenario / "extension"
    shutil.copytree(EXTENSION_DIR, ext_dir)
    manifest_path = ext_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["permissions"].append("tabs")
    if scenario == "basic":
        add_script(ext_dir, "reporter.js", "e2e-reporter.js", log_url)
        manifest["background"]["scripts"].append("e2e-reporter.js")
    else:
        add_script(ext_dir, "idle_background_reporter.js", "e2e-reporter.js", log_url)
        manifest["background"]["scripts"].append("e2e-reporter.js")
        add_script(ext_dir, "idle_warning_reporter.js", "warning/e2e-warning-reporter.js", log_url)
        warning_html = ext_dir / "warning" / "warning.html"
        html = warning_html.read_text(encoding="utf-8").replace(
            "</body>", '  <script src="e2e-warning-reporter.js"></script>\n</body>'
        )
        warning_html.write_text(html, encoding="utf-8", newline="\n")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return ext_dir


def run_firefox(ext_dir: pathlib.Path, firefox: str, extra_args: list[str]) -> None:
    web_ext = shutil.which("web-ext") or shutil.which("web-ext.cmd")
    subprocess.run(
        [web_ext, "run", "--source-dir", str(ext_dir), "--firefox", firefox, "--no-reload", "--no-input", *extra_args],
        check=True,
        timeout=120,
    )


class Checker:
    def __init__(self, scenario: str, events: list[dict]):
        self.scenario = scenario
        self.events = events
        self.results = []

    def first(self, name: str) -> dict:
        return next((e for e in self.events if e["event"] == name), {})

    def index(self, predicate) -> int:
        return next((i for i, e in enumerate(self.events) if predicate(e)), -1)

    def expect(self, name: str, condition, detail=None) -> None:
        self.results.append((f"[{self.scenario}] {name}", bool(condition), detail))


def check_basic(events: list[dict]) -> Checker:
    c = Checker("basic", events)
    c.expect("エラーなく完了", c.first("done") and not c.first("error"), c.first("error"))
    c.expect("ホスト権限が付与されている", c.first("permission").get("granted"), c.first("permission"))
    urls = c.first("urls")
    c.expect("аmazon.test は警告ページへ転送", "warning/warning.html?url=" in urls.get("lookalike", ""), urls.get("lookalike"))
    c.expect("日本語.test は転送しない", urls.get("japanese", "").startswith("http://xn--wgv71a119e.test/"), urls.get("japanese"))
    c.expect("リンクから開いた gοοgle.test も転送", "warning/warning.html?url=" in urls.get("linkPage", ""), urls.get("linkPage"))
    views = {v.get("asciiHost"): v for v in events if v["event"] == "view"}
    amazon = views.get("xn--mazon-3ve.test", {})
    c.expect("警告ページに Unicode 表記を表示", amazon.get("unicodeHost") == "аmazon.test", amazon.get("unicodeHost"))
    c.expect("警告ページに似ているドメインを表示", amazon.get("lookalikeHost") == "amazon.test", amazon.get("lookalikeHost"))
    c.expect(
        "警告ページに U+0430 の行を表示",
        any("U+0430" in row and "CYRILLIC SMALL LETTER A" in row for row in amazon.get("chars", [])),
        amazon.get("chars"),
    )
    after = c.first("afterProceed").get("lookalike", "")
    c.expect("「危険を理解して開く」で元の URL へ進む", after.startswith("http://xn--mazon-3ve.test/typed"), after)
    again = c.first("allowedAgain").get("url", "")
    c.expect("許可したホストは再度警告しない", again.startswith("http://xn--mazon-3ve.test/again"), again)
    return c


def check_idle(events: list[dict]) -> Checker:
    c = Checker("idle", events)
    is_bg = lambda e: e["event"] == "bgStarted"
    first_nav = c.index(lambda e: e["event"] == "navigateFirst")
    first_warn = c.index(lambda e: e["event"] == "warningShown" and "/after-idle" in e["url"])
    second_nav = c.index(lambda e: e["event"] == "navigateSecond")
    shutdown_nav = c.index(lambda e: e["event"] == "navigateShutdown")
    c.expect("エラーなく完了", c.first("done"), None)
    c.expect(
        "休止中の遷移でバックグラウンドが再起動し、警告ページへ転送",
        first_nav >= 0 and first_warn > first_nav
        and any(is_bg(e) for e in events[first_nav:first_warn]),
        events,
    )
    c.expect(
        "休止・再開後も許可が残り、同じホストを再度警告しない",
        second_nav >= 0 and shutdown_nav > second_nav
        and any(is_bg(e) for e in events[second_nav:shutdown_nav])
        and not any(e["event"] == "warningShown" and "/second" in e["url"] for e in events),
        events,
    )
    return c


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", default=r"C:\Program Files\Mozilla Firefox\firefox.exe")
    parser.add_argument("--screenshot", type=pathlib.Path, help="警告ページのスクリーンショットの保存先 (.png)")
    args = parser.parse_args()

    checkers = []
    with tempfile.TemporaryDirectory(prefix="url-sanitizer-e2e-") as tmp:
        for scenario in ("basic", "idle"):
            server = LogServer()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            base_url = f"http://127.0.0.1:{server.server_address[1]}"
            ext_dir = prepare_extension(pathlib.Path(tmp), scenario, f"{base_url}/log")
            if scenario == "basic":
                run_firefox(ext_dir, args.firefox, [])
            else:
                run_firefox(
                    ext_dir,
                    args.firefox,
                    ["--pref", "extensions.background.idle.timeout=1000", "--start-url", f"{base_url}/idle-start"],
                )
            server.shutdown()

            for event in server.events:
                if event["event"] == "screenshot":
                    data_url = event.pop("dataUrl")
                    if args.screenshot:
                        args.screenshot.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
                        print(f"screenshot: {args.screenshot}")
            checkers.append((check_basic if scenario == "basic" else check_idle)(server.events))

    failed = False
    for checker in checkers:
        for name, ok, detail in checker.results:
            print(f"{'PASS' if ok else 'FAIL'}  {name}")
            if not ok:
                failed = True
                print(json.dumps(detail, ensure_ascii=False, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
