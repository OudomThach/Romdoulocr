"""
Metadata API smoke test — verifies every endpoint works without real OCR.
Run: python smoke_test.py
"""
from metadata import MetadataClient

USER = "admin"
PASS = "romdoul-v1cgt5jkq492dhzymlwr"

c = MetadataClient(USER, PASS)
print(f"1. health: {c.health()['status']}")

s = c.stats()
print(f"2. stats: total={s['total']} edited={s['edited']}")

r = c.list_records(page_size=2, sort="created_at:desc")
print(f"3. list: total={r['total']}")

rec = c.get_record(r['items'][0]['id'])
print(f"4. detail: type={rec['type']} status={rec['status']}")

h = c.record_history(r['items'][0]['id'])
print(f"5. history: {len(h)} events")

csv_out = c.export_csv(page_size=2)
print(f"6. csv: {len(csv_out)} bytes")

jx = c.export_json(page_size=1)
print(f"7. json: {len(jx)} records")

meta = c.meta()
print(f"8. meta: types={meta['types']}")

print("ALL 8 TESTS PASSED")
