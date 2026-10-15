"""一時プロファイルの Firefox に拡張機能を読み込み、実際の遷移で動作を確かめる。

使い方: python tests/e2e/run_e2e.py [--firefox <firefox.exe のパス>] [--screenshot <保存先.png>]
前提: web-ext (npm) と Firefox。普段使っているプロファイルには触れない（web-ext が一時プロファイルを作る）。

紛らわしいホスト（аmazon.test など）は network.dns.localDomains でこのスクリプトのログサーバー
（127.0.0.1）に向け、要求が届いたかどうかで「警告前に読み込まれない」「許可後は届く」を確かめる。

シナリオ:
  basic   : 転送、警告ページの表示、「開く」操作、許可の記憶、インストール時の案内ページ。
  security: リダイレクト経由の転送、偽造・埋め込み・トークン再利用した警告ページからは許可できないこと。
  idle    : バックグラウンドの休止時間を 1 秒にし、休止中の転送と、休止・再開後の許可の保持。
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
import urllib.parse
from html import escape as html_escape

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXTENSION_DIR = ROOT / "extension"
HERE = pathlib.Path(__file__).resolve().parent

LOOKALIKE_HOSTS = ["аmazon.test", "gοοgle.test"]
PUNYCODE_HOSTS = [host.encode("idna").decode("ascii") for host in LOOKALIKE_HOSTS]
AMAZON = PUNYCODE_HOSTS[0]  # xn--mazon-3ve.test


def page(script: str) -> bytes:
    # テスト用の Web ページ。report() はログサーバーへ記録する
    return (
        '<!doctype html><meta charset="utf-8"><title>e2e</title>\n<script>\n'
        "const report = (event, fields = {}) => fetch('http://127.0.0.1:' + __PORT__ + '/log',"
        " {method: 'POST', body: JSON.stringify({event, ...fields})});\n"
        "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n"
        f"{script}\n</script>\n"
    )


PAGES = {
    "/start": page(
        "document.write('<a id=\"link\" href=\"http://gοοgle.test/from-link\">link</a>');\n"
        "setTimeout(() => document.getElementById('link').click(), 1000);"
    ),
    "/idle-start": page(
        "(async () => { await sleep(4000); await report('navigateFirst');"
        " location.href = 'http://аmazon.test:' + __PORT__ + '/after-idle'; })();"
    ),
    "/step-second": page(
        "(async () => { await sleep(4000); await report('navigateSecond');"
        " location.href = 'http://аmazon.test:' + __PORT__ + '/second'; })();"
    ),
    "/step-shutdown": page(
        "(async () => { await sleep(9000); await report('navigateShutdown');"
        " location.href = 'http://gοοgle.test:' + __PORT__ + '/shutdown'; })();"
    ),
    # 紛らわしいホストで開いたページ。届いた時点のリファラーを報告する
    "landing": page("report('landing', {href: location.href, referrer: document.referrer});"),
}


class LogServer(http.server.ThreadingHTTPServer):
    # Windows では再利用を許すと使用中のポートにも bind できてしまうため無効にする
    allow_reuse_address = False

    def __init__(self):
        self.events = []
        super().__init__(("127.0.0.1", 0), LogHandler)

    @property
    def port(self) -> int:
        return self.server_address[1]


class LogHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        self.server.events.append(json.loads(body))
        self._reply(b"ok", "text/plain")

    def do_GET(self):
        port = self.server.port
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if self.path == "/favicon.ico":
            self.send_response(404)
            self.end_headers()
            return
        self.server.events.append(
            {"event": "GET", "host": host, "path": self.path, "referer": self.headers.get("Referer")}
        )
        if host in PUNYCODE_HOSTS:
            self._reply(PAGES["landing"].replace("__PORT__", str(port)).encode("utf-8"), "text/html; charset=utf-8")
        elif self.path == "/redirect":
            self.send_response(302)
            self.send_header("Location", f"http://{AMAZON}:{port}/redirected")
            self.end_headers()
        elif self.path.startswith("/frame?src="):
            src = html_escape(urllib.parse.unquote(self.path.split("=", 1)[1]))
            html = f'<!doctype html><meta charset="utf-8"><iframe src="{src}" width="900" height="700"></iframe>'
            self._reply(html.encode("utf-8"), "text/html; charset=utf-8")
        elif self.path in PAGES:
            self._reply(PAGES[self.path].replace("__PORT__", str(port)).encode("utf-8"), "text/html; charset=utf-8")
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


def add_script(ext_dir: pathlib.Path, src_name: str, dest_name: str, replacements: dict[str, str]) -> None:
    text = (HERE / src_name).read_text(encoding="utf-8")
    for key, value in replacements.items():
        text = text.replace(key, value)
    (ext_dir / dest_name).write_text(text, encoding="utf-8", newline="\n")


def inject_into_warning_page(ext_dir: pathlib.Path, script_name: str) -> None:
    warning_html = ext_dir / "warning" / "warning.html"
    html = warning_html.read_text(encoding="utf-8").replace(
        "</body>", f'  <script src="{script_name}"></script>\n</body>'
    )
    warning_html.write_text(html, encoding="utf-8", newline="\n")


def prepare_extension(work_dir: pathlib.Path, scenario: str, server: LogServer) -> pathlib.Path:
    ext_dir = work_dir / scenario / "extension"
    shutil.copytree(EXTENSION_DIR, ext_dir)
    log_url = f"http://127.0.0.1:{server.port}/log"
    replacements = {
        "__LOG_URL__": log_url,
        "__TARGET__": f"http://{AMAZON}:{server.port}",
        "__PORT__": str(server.port),
    }
    manifest_path = ext_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["permissions"].append("tabs")
    # テスト用の報告スクリプトがログサーバーへ送れるよう、コピーの CSP にだけ接続先を足す
    manifest["content_security_policy"]["extension_pages"] += f"; connect-src 'self' http://127.0.0.1:{server.port}"
    background = manifest["background"]["scripts"]
    if scenario == "basic":
        add_script(ext_dir, "reporter.js", "e2e-reporter.js", replacements)
        background.append("e2e-reporter.js")
    elif scenario == "security":
        add_script(ext_dir, "security_reporter.js", "e2e-reporter.js", replacements)
        background.append("e2e-reporter.js")
        add_script(ext_dir, "warning_probe.js", "warning/e2e-probe.js", replacements)
        inject_into_warning_page(ext_dir, "e2e-probe.js")
    else:
        add_script(ext_dir, "idle_background_reporter.js", "e2e-reporter.js", replacements)
        background.append("e2e-reporter.js")
        add_script(ext_dir, "idle_warning_reporter.js", "warning/e2e-warning-reporter.js", replacements)
        inject_into_warning_page(ext_dir, "e2e-warning-reporter.js")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
    return ext_dir


def run_firefox(ext_dir: pathlib.Path, firefox: str, prefs: dict[str, str], extra_args: list[str]) -> bool:
    """web-ext で Firefox を起動し、テスト用スクリプトがウィンドウを閉じるまで待つ。時間切れなら False。"""
    web_ext = shutil.which("web-ext") or shutil.which("web-ext.cmd")
    pref_args = [arg for key, value in prefs.items() for arg in ("--pref", f"{key}={value}")]
    process = subprocess.Popen(
        [web_ext, "run", "--source-dir", str(ext_dir), "--firefox", firefox, "--no-reload", "--no-input",
         *pref_args, *extra_args]
    )
    try:
        process.wait(timeout=180)
        return True
    except subprocess.TimeoutExpired:
        # web-ext.cmd -> node -> firefox と子プロセスが続くので、プロセスツリーごと終了させる
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True)
        return False


class Checker:
    def __init__(self, scenario: str, events: list[dict]):
        self.scenario = scenario
        self.events = events
        self.results = []

    def first(self, name: str) -> dict:
        return next((e for e in self.events if e["event"] == name), {})

    def index(self, predicate) -> int:
        return next((i for i, e in enumerate(self.events) if predicate(e)), -1)

    def got(self, path: str, start: int = 0, end: int | None = None) -> bool:
        # 紛らわしいホストへの要求がサーバーに届いたか
        return any(
            e["event"] == "GET" and e["host"] in PUNYCODE_HOSTS and e["path"] == path
            for e in self.events[start:end]
        )

    def expect(self, name: str, condition, detail=None) -> None:
        self.results.append((f"[{self.scenario}] {name}", bool(condition), detail))


def is_warning(url: str) -> bool:
    return url.startswith("moz-extension://") and "/warning/warning.html?" in url


def check_basic(events: list[dict]) -> Checker:
    c = Checker("basic", events)
    c.expect("エラーなく完了", c.first("done") and not c.first("error"), c.first("error"))
    c.expect("ホスト権限が付与されている", c.first("permission").get("granted"), c.first("permission"))
    c.expect("プライベートウィンドウ未許可のため案内ページを開く", c.first("setup").get("opened"), c.first("setup"))
    urls = c.first("urls")
    c.expect("аmazon.test は警告ページへ転送", is_warning(urls.get("lookalike", "")), urls.get("lookalike"))
    c.expect("日本語.test は転送しない", urls.get("japanese", "").startswith("http://xn--wgv71a119e.test/"), urls.get("japanese"))
    c.expect("リンクから開いた gοοgle.test も転送", is_warning(urls.get("linkPage", "")), urls.get("linkPage"))
    views = {v.get("asciiHost"): v for v in events if v["event"] == "view"}
    amazon = views.get(AMAZON, {})
    c.expect("警告ページに Unicode 表記を表示", amazon.get("unicodeHost") == "аmazon.test", amazon.get("unicodeHost"))
    c.expect("警告ページに似ているドメインを表示", amazon.get("lookalikeHost") == "amazon.test", amazon.get("lookalikeHost"))
    c.expect(
        "警告ページに U+0430 の行を表示",
        any("U+0430" in row and "CYRILLIC SMALL LETTER A" in row for row in amazon.get("chars", [])),
        amazon.get("chars"),
    )
    after = c.first("afterProceed").get("lookalike", "")
    c.expect("「リスクを理解して開く」で元の URL へ進む", after.startswith(f"http://{AMAZON}:") and c.got("/typed"), after)
    again = c.first("allowedAgain").get("url", "")
    c.expect("許可したホストは再度警告しない", again.startswith(f"http://{AMAZON}:") and c.got("/again"), again)
    return c


def check_security(events: list[dict]) -> Checker:
    c = Checker("security", events)
    c.expect("エラーなく完了", c.first("done") and not c.first("error"), c.first("error"))
    c.expect("302 リダイレクト先の紛らわしいドメインも転送", is_warning(c.first("redirect").get("url", "")), c.first("redirect"))
    c.expect("リダイレクト先には要求が届かない", not c.got("/redirected"), None)
    forged = c.first("forged")
    c.expect("トークンのない警告ページでは「開く」を出さない", forged.get("proceedHidden"), forged)
    c.expect("偽のトークンでは許可されない", forged.get("response", {}).get("ok") is False, forged.get("response"))
    c.expect(
        "偽造ページの操作後も同じホストは警告される",
        is_warning(c.first("afterForged").get("url", "")) and not c.got("/after-forged"),
        c.first("afterForged"),
    )
    framed = [e for e in events if e["event"] == "warningProbe" and e.get("framed")]
    c.expect(
        "iframe に埋め込まれた警告ページでは操作できない"
        f"（埋め込みで実行された警告ページ: {len(framed)} 件。0 件なら読み込み自体が阻止された）",
        all(e["proceedHidden"] and e["backHidden"] for e in framed),
        framed or "埋め込みは読み込まれなかった",
    )
    before_index = c.index(lambda e: e["event"] == "beforeProceed")
    c.expect("警告中は要求が届かない", is_warning(c.first("beforeProceed").get("url", "")) and not c.got("/landing", 0, before_index), c.first("beforeProceed"))
    c.expect("「開く」の後に要求が届く", c.got("/landing", before_index), c.first("afterProceed"))
    landing = c.first("landing")
    c.expect("移動先にリファラーを渡さない", landing.get("referrer") == "" and not any(
        e["event"] == "GET" and e["path"] == "/landing" and e["referer"] for e in events), landing)
    c.expect("許可したホストへは警告なしで要求が届く", c.got("/again"), c.first("allowedAgain"))
    c.expect("使用済みトークンは同じタブでも「開く」を出さない", c.first("reuse").get("proceedHidden"), c.first("reuse"))
    other = c.first("otherTab")
    c.expect(
        "有効なトークンも別のタブでは「開く」を出さない（発行元のタブでは出す）",
        other.get("views") == 2 and other.get("hidden") == [False, True],
        other,
    )
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
        and any(is_bg(e) for e in events[first_nav:first_warn])
        and not c.got("/after-idle", 0, first_warn),
        events,
    )
    c.expect(
        "休止・再開後も許可が残り、同じホストへ警告なしで要求が届く",
        second_nav >= 0 and shutdown_nav > second_nav
        and any(is_bg(e) for e in events[second_nav:shutdown_nav])
        and c.got("/second", second_nav, shutdown_nav)
        and not any(e["event"] == "warningShown" and "/second" in e["url"] for e in events),
        events,
    )
    return c


SCENARIOS = {
    "basic": (check_basic, {"extensions.background.idle.timeout": "300000"}, lambda port: []),
    "security": (check_security, {"extensions.background.idle.timeout": "300000"}, lambda port: []),
    "idle": (
        check_idle,
        {"extensions.background.idle.timeout": "1000"},
        lambda port: ["--start-url", f"http://127.0.0.1:{port}/idle-start"],
    ),
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox", default=r"C:\Program Files\Mozilla Firefox\firefox.exe")
    parser.add_argument("--screenshot", type=pathlib.Path, help="警告ページのスクリーンショットの保存先 (.png)")
    parser.add_argument("--only", choices=SCENARIOS.keys(), help="指定したシナリオだけ実行する")
    parser.add_argument(
        "--pref", action="append", default=[], metavar="KEY=VALUE", help="Firefox の設定を追加する（繰り返し可）"
    )
    args = parser.parse_args()
    extra_prefs = dict(item.split("=", 1) for item in args.pref)

    checkers = []
    with tempfile.TemporaryDirectory(prefix="url-homoglyph-guard-e2e-") as tmp:
        for scenario, (check, prefs, extra) in SCENARIOS.items():
            if args.only and scenario != args.only:
                continue
            server = LogServer()
            threading.Thread(target=server.serve_forever, daemon=True).start()
            ext_dir = prepare_extension(pathlib.Path(tmp), scenario, server)
            prefs = {**prefs, "network.dns.localDomains": ",".join(PUNYCODE_HOSTS), **extra_prefs}
            finished = run_firefox(ext_dir, args.firefox, prefs, extra(server.port))
            server.shutdown()
            if not finished:
                print(f"[{scenario}] 時間切れ。記録されたイベント:")
                print(json.dumps(
                    [{k: v for k, v in e.items() if k != "dataUrl"} for e in server.events], ensure_ascii=False, indent=2
                ))

            # "<指定した名前>-<画面名>.png" に保存する（例: shot.png -> shot-summary.png, shot-details.png）
            shots = [e for e in server.events if e["event"] == "screenshot"]
            for index, event in enumerate(shots):
                data_url = event.pop("dataUrl")
                if args.screenshot:
                    dest = args.screenshot.with_stem(f"{args.screenshot.stem}-{event.get('name', index)}")
                    dest.write_bytes(base64.b64decode(data_url.split(",", 1)[1]))
                    print(f"screenshot: {dest}")
            checkers.append(check(server.events))

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
