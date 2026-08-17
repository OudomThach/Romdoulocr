"""
Local static + reverse-proxy server for the portable app.

Why this exists:
  * The built SPA uses ABSOLUTE asset paths (/assets/...), so it must be served
    from an http origin, not file://.
  * The SPA calls its backends at RELATIVE paths (/api, /api-vllm, /api-lens,
    /api-tidy) expecting nginx to route them. Here we reverse-proxy those paths
    to the home nginx (via the Tailscale Funnel), so the desktop app behaves
    exactly like the website — the home nginx still injects the adapter token,
    so no secret ever lives in the client.
  * We seed localStorage['ocr.backend'] into index.html so the portable build
    defaults to Google Lens, without modifying the web app's source.

Runs on a background thread; serves 127.0.0.1 only.
"""
from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# Paths that are proxied to the home nginx rather than served from disk.
PROXY_PREFIXES = ("/api-vllm", "/api-lens", "/api-tidy", "/api")

# Hop-by-hop headers we must not forward.
_STRIP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
          "te", "trailer", "upgrade", "proxy-authorization", "proxy-authenticate"}


def _seed_script(backend: str) -> str:
    # Injected into <head> before the app boots (desktop build only):
    #  * romdoul.session='guest' EVERY load → never shows the welcome/login gate.
    #  * ocr.backend default only if unset, so the user's in-app switch persists.
    #  * a floating "Updates" button in the main interface that calls the local
    #    /desktop/check-update endpoint (GitHub Releases) — see _check_update.
    import version
    releases = version.RELEASES_PAGE
    return (
        "<script>try{"
        "localStorage.setItem('romdoul.session','guest');"
        "if(!localStorage.getItem('ocr.backend'))"
        f"localStorage.setItem('ocr.backend','{backend}');"
        "}catch(e){}</script>"
        "<script>(function(){function add(){"
        "if(document.getElementById('rd-upd'))return;"
        "var b=document.createElement('button');b.id='rd-upd';b.textContent='\\u27f3 Updates';"
        "b.title='Check for updates';"
        "b.style.cssText='position:fixed;right:14px;bottom:14px;z-index:2147483647;"
        "background:#0b1220;color:#00e5ff;border:1px solid #00e5ff;border-radius:10px;"
        "padding:8px 12px;font:600 12px Segoe UI,system-ui,sans-serif;cursor:pointer;"
        "opacity:.85;box-shadow:0 2px 10px rgba(0,0,0,.4)';"
        "b.onmouseenter=function(){b.style.opacity='1'};"
        "b.onmouseleave=function(){b.style.opacity='.85'};"
        "b.onclick=async function(){var old=b.textContent;b.textContent='Checking\\u2026';try{"
        "var j=await (await fetch('/desktop/check-update')).json();"
        "if(j.status==='update'){if(confirm('Version '+j.latest+' is available. Download now?'))"
        "window.open(j.url,'_blank');}"
        "else if(j.status==='current'){alert(\"You're on the latest version (\"+j.latest+\").\");}"
        "else{if(confirm(\"Couldn't check automatically. Open the releases page?\"))"
        f"window.open('{releases}','_blank');}}}}catch(e){{window.open('{releases}','_blank');}}"
        "b.textContent=old;};"
        "document.body.appendChild(b);}"
        "if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',add);else add();"
        "})();</script>"
    )


class LocalServer:
    def __init__(self, webui_dir: str, funnel_base: str, backend: str, port: int = 0):
        self.webui_dir = os.path.abspath(webui_dir)
        self.funnel_base = funnel_base.rstrip("/")
        self.backend = backend
        self._httpd: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.port = port

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def start(self) -> str:
        server = _build_handler(self.webui_dir, self.funnel_base, self.backend)
        self._httpd = ThreadingHTTPServer(("127.0.0.1", self.port), server)
        self.port = self._httpd.server_address[1]
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()
        return self.url

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()


def _build_handler(webui_dir: str, funnel_base: str, backend: str):
    class Handler(BaseHTTPRequestHandler):
        # Silence the default stderr request logging.
        def log_message(self, *_args):  # noqa: D401
            pass

        def _is_proxy(self) -> bool:
            path = self.path.split("?", 1)[0]
            return any(path == p or path.startswith(p + "/") for p in PROXY_PREFIXES)

        def do_GET(self):
            if self.path.split("?", 1)[0] == "/desktop/check-update":
                self._check_update()
            elif self._is_proxy():
                self._proxy("GET")
            else:
                self._static()

        # ---- desktop-only: 'Check for updates' from the main interface -------
        def _check_update(self):
            import json as _json

            import version as _version
            try:
                import updater as _updater
                res = _updater.check(_version.VERSION)
            except Exception as exc:  # noqa: BLE001
                res = {"status": "error", "error": str(exc)}
            res.setdefault("releases", _version.RELEASES_PAGE)
            res.setdefault("current", _version.VERSION)
            body = _json.dumps(res).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if self._is_proxy():
                self._proxy("POST")
            else:
                self.send_error(405)

        def do_OPTIONS(self):
            if self._is_proxy():
                self._proxy("OPTIONS")
            else:
                self.send_error(405)

        # ---- reverse proxy to the home nginx (via Funnel) -------------------
        def _proxy(self, method: str):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            fwd = {k: v for k, v in self.headers.items() if k.lower() not in _STRIP}
            url = funnel_base + self.path
            try:
                resp = requests.request(
                    method, url, data=body, headers=fwd, timeout=180, stream=True
                )
            except requests.RequestException as exc:
                self.send_error(502, f"proxy error: {exc}")
                return
            self.send_response(resp.status_code)
            for k, v in resp.headers.items():
                if k.lower() in _STRIP or k.lower() == "content-encoding":
                    continue
                self.send_header(k, v)
            content = resp.content
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        # ---- static files from webui/ --------------------------------------
        def _static(self):
            path = self.path.split("?", 1)[0]
            if path == "/" or path == "":
                path = "/index.html"
            rel = path.lstrip("/")
            full = os.path.normpath(os.path.join(webui_dir, rel))
            # Prevent path traversal outside webui/.
            if not full.startswith(webui_dir):
                self.send_error(403)
                return
            # SPA fallback: unknown non-asset routes serve index.html.
            if not os.path.isfile(full):
                if "." in os.path.basename(rel):
                    self.send_error(404)
                    return
                full = os.path.join(webui_dir, "index.html")

            if os.path.basename(full) == "index.html":
                self._serve_index(full)
                return

            ctype = _content_type(full)
            with open(full, "rb") as fh:
                data = fh.read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _serve_index(self, full: str):
            with open(full, encoding="utf-8") as fh:
                html = fh.read()
            html = html.replace("<head>", "<head>" + _seed_script(backend), 1)
            data = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    return Handler


_CT = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff": "font/woff",
    ".woff2": "font/woff2", ".ttf": "font/ttf", ".map": "application/json",
    ".wasm": "application/wasm", ".ico": "image/x-icon",
}


def _content_type(path: str) -> str:
    return _CT.get(os.path.splitext(path)[1].lower(), "application/octet-stream")
