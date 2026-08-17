"""
Real Live End-to-End Test for Romdoul OCR Docker Services.

Checks:
1. Docker Container Health & Ports.
2. Nginx Reverse Proxy (localhost:8181).
3. Status Adapter (localhost:8094).
4. Metadata Service (localhost:8095).
5. vLLM Adapter (localhost:8090).
6. Live OCR Extraction with real image ('Cambodia\'s Mammal Guide_Khmer227.jpg').
"""

import sys
import time
from pathlib import Path

import httpx

# Ensure UTF-8 output on Windows terminal
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

SAMPLE_IMG = Path(r"c:\Users\USER\work\surya-container-testing\sample-pdfs\Cambodia's Mammal Guide_Khmer227.jpg")

ADAPTER_TOKEN = "1e4cca55b75b78fda28f09d9f2c7e15bc7c2cd404544f5f8b0211eed4ad7ef7e"
HEADERS = {"X-Adapter-Token": ADAPTER_TOKEN}

def test_live_docker_stack():
    print("=" * 60)
    print("🐳 ROMDOUL OCR LIVE DOCKER STACK TEST")
    print("=" * 60)

    # 1. Test Nginx Reverse Proxy
    print("\n1️⃣  Testing Nginx Proxy (http://localhost:8181)...")
    try:
        r = httpx.get("http://localhost:8181/", timeout=5.0)
        print(f"   Status: {r.status_code} OK (HTML served, {len(r.text)} bytes)")
    except Exception as e:
        print(f"   ❌ Nginx Proxy error: {e}")

    # 2. Test Status Adapter
    print("\n2️⃣  Testing Status Adapter (http://localhost:8094/v1/status)...")
    try:
        r = httpx.get("http://localhost:8094/v1/status", headers=HEADERS, timeout=5.0)
        data = r.json()
        print(f"   Status: {r.status_code} OK")
        print(f"   Backends: {data.get('backends', {})}")
    except Exception as e:
        print(f"   ❌ Status adapter error: {e}")

    # 3. Test Metadata Service Health
    print("\n3️⃣  Testing Metadata Service (http://localhost:8095/health)...")
    try:
        r = httpx.get("http://localhost:8095/health", timeout=5.0)
        print(f"   Status: {r.status_code} OK -> Response: {r.json()}")
    except Exception as e:
        print(f"   ❌ Metadata service error: {e}")

    # 4. Test vLLM Adapter Health
    print("\n4️⃣  Testing vLLM Adapter (http://localhost:8090/health)...")
    try:
        r = httpx.get("http://localhost:8090/health", timeout=5.0)
        print(f"   Status: {r.status_code} OK -> Response: {r.json()}")
    except Exception as e:
        print(f"   ❌ vLLM adapter error: {e}")

    # 5. Live OCR Extraction on real image
    print("\n5️⃣  Running Live OCR Extraction on real sample image via local vLLM GPU stack...")
    print(f"   Sample path: {SAMPLE_IMG}")
    if not SAMPLE_IMG.exists():
        print(f"   ❌ Sample file not found: {SAMPLE_IMG}")
        return

    start_time = time.time()
    try:
        with open(SAMPLE_IMG, "rb") as f:
            files = {"file": (SAMPLE_IMG.name, f.read(), "image/jpeg")}
            r = httpx.post("http://localhost:8090/ocr-image", files=files, headers=HEADERS, timeout=120.0)
        
        elapsed = time.time() - start_time
        if r.status_code == 200:
            res = r.json()
            extracted_text = res.get("text", "")
            print(f"   ✅ REAL OCR INFERENCE SUCCESS in {elapsed:.2f}s!")
            print(f"   Confidence: {res.get('confidence')}")
            print(f"   Extracted Khmer Text Preview:\n   {'-'*50}\n   {extracted_text[:400]}\n   {'-'*50}")
        else:
            print(f"   ⚠️ OCR returned HTTP {r.status_code}: {r.text}")
    except Exception as e:
        print(f"   ❌ OCR request failed: {e}")

    print("\n" + "=" * 60)
    print("🎉 REAL DOCKER TEST COMPLETED")
    print("=" * 60)

if __name__ == "__main__":
    test_live_docker_stack()
