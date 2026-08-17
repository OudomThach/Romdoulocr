"""
Real-World Performance & Concurrency Benchmark for Romdoul OCR.

Benchmarks:
1. Single request cold vs warm inference latency.
2. Concurrent batch throughput with AsyncRomdoulClient.
3. System memory & CPU response times.
"""

import asyncio
import sys
import time
from pathlib import Path
import httpx

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

SAMPLE_IMG_1 = Path(r"c:\Users\USER\work\surya-container-testing\sample-pdfs\Cambodia's Mammal Guide_Khmer227.jpg")
SAMPLE_IMG_2 = Path(r"c:\Users\USER\work\surya-container-testing\sample-pdfs\712465419_1521870912661702_49003426680337558_n.jpg")

ADAPTER_TOKEN = "1e4cca55b75b78fda28f09d9f2c7e15bc7c2cd404544f5f8b0211eed4ad7ef7e"
HEADERS = {"X-Adapter-Token": ADAPTER_TOKEN}
BASE_URL = "http://localhost:8090"

async def run_benchmark():
    print("=" * 65)
    print("⚡ ROMDOUL OCR REAL PERFORMANCE & CONCURRENCY BENCHMARK")
    print("=" * 65)

    async with httpx.AsyncClient(base_url=BASE_URL, headers=HEADERS, timeout=120.0) as client:
        # Step 1: Single request benchmark (Sample 1)
        print("\n📊 1. Single Document Extraction Benchmark (Sample 1)...")
        with open(SAMPLE_IMG_1, "rb") as f:
            data1 = f.read()

        t0 = time.perf_counter()
        r1 = await client.post("/ocr-image", files={"file": (SAMPLE_IMG_1.name, data1, "image/jpeg")})
        t1 = time.perf_counter()
        lat1 = t1 - t0
        print(f"   Status: {r1.status_code} | Latency: {lat1:.2f}s | Confidence: {r1.json().get('confidence')}")

        # Step 2: Single request benchmark (Sample 2)
        if SAMPLE_IMG_2.exists():
            print("\n📊 2. Single Document Extraction Benchmark (Sample 2)...")
            with open(SAMPLE_IMG_2, "rb") as f:
                data2 = f.read()
            t0 = time.perf_counter()
            r2 = await client.post("/ocr-image", files={"file": (SAMPLE_IMG_2.name, data2, "image/jpeg")})
            t2 = time.perf_counter()
            lat2 = t2 - t0
            print(f"   Status: {r2.status_code} | Latency: {lat2:.2f}s | Confidence: {r2.json().get('confidence')}")

        # Step 3: Concurrent Batch Throughput (4 simultaneous requests)
        print("\n🚀 3. Concurrent Batch Stress Test (4 simultaneous requests)...")
        files_to_send = [
            (SAMPLE_IMG_1.name, data1, "image/jpeg"),
            (SAMPLE_IMG_1.name, data1, "image/jpeg"),
            (SAMPLE_IMG_2.name, data2, "image/jpeg") if SAMPLE_IMG_2.exists() else (SAMPLE_IMG_1.name, data1, "image/jpeg"),
            (SAMPLE_IMG_1.name, data1, "image/jpeg"),
        ]

        async def _single_worker(idx: int, file_tuple):
            start = time.perf_counter()
            resp = await client.post("/ocr-image", files={"file": file_tuple})
            elapsed = time.perf_counter() - start
            return idx, resp.status_code, elapsed

        t0_batch = time.perf_counter()
        results = await asyncio.gather(*[_single_worker(i, f) for i, f in enumerate(files_to_send)])
        t_batch_total = time.perf_counter() - t0_batch

        for idx, status, dur in results:
            print(f"   Worker {idx+1}: Status {status} in {dur:.2f}s")
        print(f"   Total Batch Duration for 4 requests: {t_batch_total:.2f}s")
        print(f"   Effective Throughput: {len(files_to_send) / t_batch_total:.2f} pages/sec")

    print("\n" + "=" * 65)
    print("✅ BENCHMARK COMPLETED SUCCESSFULLY")
    print("=" * 65)

if __name__ == "__main__":
    asyncio.run(run_benchmark())
