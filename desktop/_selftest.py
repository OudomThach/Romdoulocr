"""Headless self-test of the non-GUI core: static serving, Lens-seed injection,
and API reverse-proxy. Points the proxy at the local nginx (127.0.0.1:8181) so it
doesn't depend on the Funnel being reachable."""
import re

import requests
import server

srv = server.LocalServer(
    webui_dir="webui",
    funnel_base="http://127.0.0.1:8181",
    backend="lens",
    port=0,
)
url = srv.start()
print("server:", url)
ok = True

# 1) index.html served + Lens-default seed injected
r = requests.get(url, timeout=10)
has_seed = "ocr.backend" in r.text and "'lens'" in r.text
print("GET /            ->", r.status_code, "| seed injected:", has_seed)
ok &= r.status_code == 200 and has_seed

# 2) a static asset (find one from index.html)
m = re.search(r'/assets/index-[A-Za-z0-9_-]+\.js', r.text)
if m:
    a = requests.get(url.rstrip("/") + m.group(0), timeout=10)
    print("GET", m.group(0), "->", a.status_code, a.headers.get("Content-Type"))
    ok &= a.status_code == 200 and "javascript" in (a.headers.get("Content-Type", ""))
else:
    print("!! no asset found in index.html")
    ok = False

# 3) API reverse-proxy -> lens adapter health
try:
    h = requests.get(url.rstrip("/") + "/api-lens/health", timeout=15)
    print("GET /api-lens/health ->", h.status_code, "|", h.text[:80])
    ok &= h.status_code == 200
except Exception as e:
    print("!! proxy failed:", e)
    ok = False

# 4) SPA fallback (unknown route -> index.html)
f = requests.get(url.rstrip("/") + "/history", timeout=10)
print("GET /history (SPA fallback) ->", f.status_code)
ok &= f.status_code == 200 and "ocr.backend" in f.text

srv.stop()
print("\nSELFTEST:", "PASS" if ok else "FAIL")
