import json, statistics, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

import os
TOKEN = os.environ.get('TJ_TOKEN', '').strip()
KWS = ['法院','解釋','歷史','英國','檔案','民國','司法','年','第','臺']
BASE = 'http://127.0.0.1:3000/api/search/fulltext'

def call(i):
    kw = KWS[i % len(KWS)]
    url = f"{BASE}?q={urllib.parse.quote(kw)}&page={1 + i % 3}&size=20"
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {TOKEN}'})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = json.loads(r.read().decode())
        dt = (time.perf_counter() - t0) * 1000
        return dt, body.get('data', {}).get('total', -1)
    except Exception as e:
        return (time.perf_counter() - t0) * 1000, -1

def run(concurrency, total):
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        res = list(ex.map(call, range(total)))
    wall = time.perf_counter() - t0
    lat = sorted(r[0] for r in res)
    ok = sum(1 for r in res if r[1] >= 0)
    def pct(p): return lat[min(len(lat)-1, int(len(lat)*p))]
    print(f"并发{concurrency:>3} 请求{total:>4}: 成功{ok}/{total} "
          f"P50={pct(.5):6.0f}ms P95={pct(.95):6.0f}ms 最大={lat[-1]:6.0f}ms "
          f"吞吐={total/wall:5.1f} qps")

for c, n in [(1, 20), (10, 100), (20, 200), (50, 300)]:
    run(c, n)
    time.sleep(1)
