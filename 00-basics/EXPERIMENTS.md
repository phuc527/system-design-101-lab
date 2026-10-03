# Experiments: System Design Basics

Each experiment follows the same loop: **predict → run → observe → explain**. Write your prediction down *before* running. Being wrong is how you learn.

> **Numbers below were measured on a Windows laptop (8 logical CPUs, Docker Desktop).** Your absolute numbers will differ. Focus on the *ratios and shapes*: what doubles, what stays flat, what explodes.

## Setup

```bash
cd 00-basics
npm install
docker compose up --build -d     # 3 containers on ports 3001 / 3002 / 3003
docker compose ps                # wait until all show "(healthy)"
```

Shell: use **Git Bash** on Windows (PowerShell's `curl` is an alias for `Invoke-WebRequest` and behaves differently. Use `curl.exe` there if you must).

Reset stats between experiments so old numbers don't pollute new ones:

```bash
curl -s -X POST localhost:3001/metrics/reset
```

---

## How to read benchmark output

`npx autocannon -c 100 -d 10 URL` opens **100 connections** (`-c`) and hammers the URL for **10 seconds** (`-d`). Each connection sends a new request as soon as the previous one returns.

```text
┌─────────┬────────┬────────┬────────┬────────┬────────┬──────────┬────────┐
│ Stat    │ 2.5%   │ 50%    │ 97.5%  │ 99%    │ Avg    │ Stdev    │ Max    │
│ Latency │ 104 ms │ 122 ms │ 328 ms │ 492 ms │ 143 ms │ 69.27 ms │ 713 ms │
├─────────┴────────┴────────┴────────┴────────┴────────┴──────────┴────────┤
│ Req/Sec   │ 342    │ 342    │ 767    │ 844    │ 696.3  │ ...               │
```

| Term | Meaning | In this output |
|---|---|---|
| **Latency 50% (p50 / median)** | Half the requests were faster than this | 122ms |
| **97.5% / 99% (p97.5 / p99)** | The slow tail: 1 in 100 requests is slower than p99 | 492ms |
| **Avg** | Mean. Skewed by outliers, so don't trust it alone | 143ms |
| **Stdev** | How spread out latencies are. High = unpredictable | 69ms |
| **Max** | The single worst request (often a GC pause or a cold start) | 713ms |
| **Req/Sec (RPS)** | Throughput, completed requests per second | ~700 avg |
| **Bytes/Sec** | Network throughput actually used | 224 kB/s |
| **Errors / non-2xx** | Printed at the bottom if any. Error rate = errors / total | none |

**Rule of thumb:** a system is "healthy" under load when RPS grows with concurrency and p99 stays within your target. When adding concurrency stops increasing RPS and only increases latency, you've hit **saturation**.

---

## Experiment 1: Latency: sequential vs parallel

**Question:** a request needs 3 independent 100ms calls (user, orders, recommendations). How long does it take?

**Predict:** sequential = ___ms, parallel = ___ms

```bash
curl -s "localhost:3001/api/latency/sequential?calls=3&ms=100"
curl -s "localhost:3001/api/latency/parallel?calls=3&ms=100"

# Measure client-side latency too (includes the network):
curl -s -o /dev/null -w "client total: %{time_total}s\n" "localhost:3001/api/latency/parallel?calls=3&ms=100"
```

**Observed:**
```json
{"strategy":"sequential","calls":3,"msPerCall":100,"serverMs":307.98}
{"strategy":"parallel","calls":3,"msPerCall":100,"serverMs":106.36}
```

**Explain:** `await` in a loop waits for each call before starting the next, so latency = **sum**. `Promise.all` starts all three at once, so latency = **max**. Try `calls=10`: sequential grows to ~1000ms, parallel stays ~100ms.

**Lesson:** in real code, look for independent `await`s in a row. It's the cheapest latency win there is.

---

## Experiment 2: Tail latency: why p99 matters

**Question:** 98% of requests take 50ms, 2% take 1000ms (a slow DB query, a GC pause). What do average, p50, p95 and p99 show?

**Predict:** avg ≈ ___, p50 ≈ ___, p99 ≈ ___

```bash
curl -s -X POST localhost:3002/metrics/reset
npx autocannon -c 50 -d 10 "http://localhost:3002/api/latency?ms=50&tailRate=0.02&tailMs=1000"
curl -s localhost:3002/metrics | grep -o '"latencyMs":{[^}]*}'
```

**Observed:**
```text
autocannon: p50 = 55ms   p97.5 = 130ms   p99 = 1004ms   avg = 75.6ms
/metrics:   {"samples":1000,"min":49.72,"avg":70.45,"p50":51.84,"p95":57,"p99":1001.5,"max":1009.62}
```

**Explain:** the average (70ms) describes *nobody*: no request took 70ms. Typical users got ~52ms (p50), and 1 in 50 waited a full second (p99). If a page makes 20 such calls, the chance that **at least one** is slow is `1 − 0.98²⁰ ≈ 33%`. Tail latency compounds with fan-out.

**Try:** `tailRate=0.005` (0.5%). p99 drops back to ~50ms but max stays ~1000ms. That's why big systems also track p99.9.

---

## Experiment 3: I/O-bound throughput and Little's Law

**Question:** each request waits 100ms on I/O. With 100 concurrent connections, what's the max RPS?

**Predict with Little's Law:** `throughput = concurrency / latency = 100 / 0.1s = ____ RPS`

```bash
npx autocannon -c 100 -d 10 "http://localhost:3001/api/io?ms=100"
```

**Observed:**
```text
Latency p50 = 122ms   p99 = 492ms
Req/Sec avg = 696
7k requests in 10.12s
```

**Explain:** theory says 1000 RPS. We got ~700 because real latency was ~140ms on average, not 100ms. The extra ~40ms is Docker Desktop's network forwarding on Windows plus HTTP overhead. Plug the *measured* latency into Little's Law: `100 / 0.143 ≈ 700`. ✅ The law holds.

**Now change one variable at a time:**
```bash
npx autocannon -c 200 -d 10 "http://localhost:3001/api/io?ms=100"   # 2× concurrency → ~2× RPS (until something saturates)
npx autocannon -c 100 -d 10 "http://localhost:3001/api/io?ms=200"   # 2× latency → ~½ RPS
```

**Lesson:** for I/O-bound services, **latency limits throughput** at a given concurrency. A slow database (higher latency) directly cuts how many requests each server can handle. A single Node process handles hundreds or thousands of concurrent waits on 1 CPU, because waiting is free.

---

## Experiment 4: CPU-bound throughput and event-loop blocking

**Question:** what happens to *other* requests while one request does heavy computation?

```bash
# 1. How long does one fib(38) take?
curl -s "localhost:3001/api/cpu?n=38"

# 2. In terminal A: keep the process busy with CPU work
npx autocannon -c 2 -d 15 "http://localhost:3001/api/cpu?n=38"

# 3. In terminal B, WHILE terminal A runs: time a trivial health check
for i in 1 2 3 4 5; do curl -s -o /dev/null -w "health: %{time_total}s\n" localhost:3001/health; done
curl -s localhost:3001/metrics | grep -o '"eventLoopDelayMs":{[^}]*}'
```

**Observed:**
```text
health: 2.488s     ← normally 0.005s
health: 1.998s
eventLoopDelayMs: {"p50":10.2,"p99":1060.6,"max":1168.1}
```

**Explain:** `/health` does almost nothing, yet took 2.5 seconds. Node runs JavaScript on **one thread**, so while `fibonacci(38)` runs, the event loop can't even *read* the incoming health-check request. Event-loop delay p99 jumped from ~10ms (the idle baseline, equal to the sampling resolution) to over 1 second.

**Why this matters in production:** Kubernetes or a load balancer would see health checks timing out and mark this instance dead, even though it's "just busy". One endpoint that parses a 50MB JSON file can take down an entire service.

**Fixes:** move CPU work to `worker_threads`, a separate service, or a background queue (lab 08). Or scale out (experiment 5).

---

## Experiment 5: Vertical vs horizontal scaling

**Question:** which handles more CPU-bound RPS: 1 process on 1 CPU, 1 process on 2 CPUs, or 2 processes on 2 CPUs?

**Predict:** baseline = X RPS → vertical = ___ × X, horizontal = ___ × X

```bash
curl -s "localhost:3001/api/cpu?n=34"    # note serverMs: the cost of one request

for port in 3001 3002 3003; do
  echo "=== port $port ==="
  npx autocannon -c 4 -d 15 "http://localhost:$port/api/cpu?n=34" 2>&1 | grep -E "Latency|Req/Sec|requests in"
done
```

**Check that the horizontal container really uses 2 processes**, alternating between them:

```bash
for i in 1 2 3 4; do curl -s "localhost:3003/api/cpu?n=20" | grep -o '"pid":[0-9]*'; done
```

**Observed (one run, c=4, fib(34) ≈ 68ms):**
```text
3001 baseline   (1 CPU, 1 proc):   ~10 RPS
3002 vertical   (2 CPU, 1 proc):   ~10 RPS   ← extra CPU unused
3003 horizontal (2 CPU, 2 proc):   ~13 RPS   ← more, but not 2×
pids alternate: 14, 15, 14, 15     ← round-robin across workers
docker stats during load: horizontal CPU = 199%  (both cores busy)
```

**Explain:**
- **Vertical ≈ baseline.** One Node process executes JavaScript on one thread, so the second CPU sits idle. *Vertical scaling alone doesn't help single-threaded runtimes.*
- **Horizontal > baseline**, but on this laptop only ~1.3×, not the theoretical 2×. Why? Run `curl -s "localhost:3003/api/cpu?n=34"` during load: `serverMs` rose from ~68ms to 90–175ms. Each request got slower when two ran at once, because:
  - the 2 "CPUs" Docker gives you may be **hyperthreads** sharing one physical core,
  - laptops lower clock speed when more cores are busy (**turbo/thermal limits**),
  - the load generator (autocannon) runs on the same machine and competes for CPU.
- **Scaling is rarely linear.** Real-world scaling efficiency of 70–90% per added node is normal. Coordination, shared resources and contention eat the rest. That's why you **measure** instead of multiplying.

**Try:** `docker stats` in another terminal during each run. Baseline caps near 100% CPU, vertical also ~100% (out of 200% available), horizontal reaches ~200%.

**Try:** start locally with all cores: `WORKERS=0 npm run dev`, then benchmark port 3000.

---

## Experiment 6: Bandwidth and compression

**Question:** how many bytes does a 200 KB JSON response actually send? And how long does a download take on a slow link?

```bash
# Size on the wire without and with gzip:
curl -s -o /dev/null -w "plain: %{size_download} bytes in %{time_total}s\n" "localhost:3001/api/payload?kb=200"
curl -s --compressed -o /dev/null -w "gzip:  %{size_download} bytes in %{time_total}s\n" "localhost:3001/api/payload?kb=200"

# A simulated 50 KB/s link: predict the time for 100 KB, then 200 KB
curl -s -o /dev/null -w "%{size_download} bytes in %{time_total}s\n" "localhost:3001/api/download?kb=100&kbps=50"
curl -s -o /dev/null -w "%{size_download} bytes in %{time_total}s\n" "localhost:3001/api/download?kb=200&kbps=50"
```

**Observed:**
```text
plain:    204840 bytes
gzip:       9220 bytes        ← 95.5% smaller
download: 102400 bytes in 2.06s   (100 KB / 50 KB/s = 2s)
```

**Explain:** `time ≈ latency + size / bandwidth`. On a fast local link the payload difference barely changes time, but on a 3G phone (~50–200 KB/s) the uncompressed 200 KB costs ~2–4 seconds and the gzipped one costs ~0.1s. Repetitive JSON (same keys over and over) compresses extremely well.

**Try:** `kbps=500` and compare. Bandwidth-bound transfers scale linearly with size, while latency-bound ones don't.

---

## Experiment 7: Availability and reliability under failure

**Question:** if the server fails 20% of requests, what availability do users see? What if the client retries up to 2 times?

**Predict:** no retry = ___%, 2 retries = ___% (hint: `1 − 0.2³`), extra load = ___%

```bash
curl -s -X POST localhost:3001/chaos -H "Content-Type: application/json" -d '{"failureRate":0.2}'

npm run probe -- --url http://localhost:3001/api/hello --n 500
npm run probe -- --url http://localhost:3001/api/hello --n 500 --retries 2

curl -s -X POST localhost:3001/chaos/reset
```

**Observed:**
```text
retries=0   succeeded: 393/500   availability: 78.60%   HTTP calls: 500 (1.00 per request)   p99 = 68ms
retries=2   succeeded: 492/500   availability: 98.40%   HTTP calls: 629 (1.26 per request)   p99 = 114ms
```

**Explain:**
- Theory: `1 − 0.2³ = 99.2%` success, `1 + 0.2 + 0.04 = 1.24` calls per request. Measured: 98.4% and 1.26. ✅
- Retries turned an **unreliable server** into a **mostly reliable client experience**: fault tolerance at the client.
- **But:** 26% more load hit a server that was already failing, and p99 latency nearly doubled. If failures are caused by *overload*, retries make it worse (retry storm). That's why lab 19 adds exponential backoff + jitter, and lab 18 adds circuit breakers.

**Also try: availability math on paper.**
```bash
curl -s "localhost:3001/availability?percent=99.9&replicas=2&dependencies=3"
```
```text
single 99.9%     → 8h 45m downtime/year
3 deps in series → 99.7%   → 1d 2h/year        ← dependencies hurt
2 replicas       → 99.9999% → 32s/year          ← redundancy helps (if failures are independent)
```

**Try: slow dependency.** `{"extraLatencyMs":300}`, then re-run experiment 3. Little's Law says RPS drops to ~`100 / 0.4 = 250`.

---

## Experiment 8: CAP theorem: CP vs AP

**Question:** two replicas lose contact. A customer buys the last item via node A while another customer checks stock via node B. What should B say?

```bash
B=localhost:3002
J='-H Content-Type:application/json'
curl -s -X POST $B/cap/reset

# 1. Healthy network: writes replicate to both nodes
curl -s -X PUT $B/cap/nodes/A/keys/stock $J -d '{"value":"10"}'
curl -s $B/cap/nodes/B/keys/stock                       # value "10" on B too

# 2. Cut the network. Default mode is CP.
curl -s -X POST $B/cap/partition
curl -s -X PUT $B/cap/nodes/A/keys/stock $J -d '{"value":"9"}' -w "  [HTTP %{http_code}]\n"
curl -s $B/cap/nodes/B/keys/stock -w "  [HTTP %{http_code}]\n"

# 3. Switch to AP and repeat: both sides accept different writes
curl -s -X POST $B/cap/mode $J -d '{"mode":"AP"}'
curl -s -X PUT $B/cap/nodes/A/keys/stock $J -d '{"value":"9"}'
curl -s -X PUT $B/cap/nodes/B/keys/stock $J -d '{"value":"7"}'
curl -s $B/cap/nodes/A/keys/stock                       # "9"
curl -s $B/cap/nodes/B/keys/stock                       # "7": the replicas disagree
curl -s $B/cap                                          # divergentKeys: ["stock"]

# 4. Heal the network: Last-Write-Wins reconciliation
curl -s -X POST $B/cap/heal
```

**Observed:**
```text
2. CP write → HTTP 503 {"code":"SERVICE_UNAVAILABLE","message":"CP mode: node A cannot reach its peer, refusing the write to stay consistent"}
3. AP: A says "9" (version 2), B says "7" (version 3), both possiblyStale: true
4. heal → "conflicts":[{"key":"stock","kept":{"value":"7","version":3},"discarded":{"value":"9","version":2}}]
```

**Explain:**
- **CP** chose consistency: during the partition users got errors, but nobody ever saw wrong data.
- **AP** chose availability: everyone got an answer, but A and B disagreed, and on heal **Last-Write-Wins silently threw away the "9" write**. If that write was a real purchase, you just lost an order.
- Neither is "better". Inventory and payments usually want CP (or AP plus careful conflict resolution). Like counts and feeds are happy with AP.

**Note:** the simulator lives in process memory, so use port 3001 or 3002 (single process), not 3003. In cluster mode each worker would have its own separate "cluster". The same in-memory state problem again!

---

## Experiment 9: Fault tolerance: kill a process

**Question:** what does a user experience when the server process crashes? Does it matter who supervises it?

```bash
# A) Single process supervised by Docker
curl -s -X POST localhost:3001/chaos/crash
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code}\n" --max-time 1 localhost:3001/health; done
docker inspect sd101-basics-api-baseline-1 --format 'RestartCount={{.RestartCount}}'

# B) Cluster: kill one worker, the primary re-forks it
curl -s -X POST localhost:3003/chaos/crash
for i in 1 2 3 4 5 6; do curl -s localhost:3003/health; echo; done
docker compose logs api-horizontal | tail -3

# C) No supervisor at all
npm run dev                                 # in terminal A
curl -s -X POST localhost:3000/chaos/crash  # in terminal B
curl -s localhost:3000/health               # connection refused, and it stays that way
```

**Observed:**
```text
A) 200, 000, 000, 200     ← ~2s of "connection refused" (000), then Docker restarted it. RestartCount=1
B) pid 15, 15, 15, 15, 15, 330   ← zero failed requests. Worker 15 took over, new worker 330 joined
   log: "worker died - forking a replacement" ... "http server listening" (pid 330, ~260ms later)
C) the server is gone until a human restarts it
```

**Explain:**
- **C** is a **single point of failure** with no recovery: availability depends on how fast *you* notice.
- **A** recovers automatically (low MTTR), but there's still a window of downtime because there's only one instance.
- **B** has **redundancy**: another worker keeps serving while the dead one is replaced. Users notice nothing. This is fault tolerance. Lab 01 does the same across containers with a load balancer.

**Bonus:** `docker compose stop api-baseline`. With `restart: unless-stopped`, a manual stop is respected and Docker won't restart it. `docker compose start api-baseline` brings it back.

---

## Experiment 10: Load test with SLO thresholds (k6)

**Question:** does the baseline container meet an SLO of *p95 < 500ms and < 1% errors* as load ramps to 20 virtual users?

```bash
docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 -e MAX_VUS=20 grafana/k6 run - < k6/load-test.js
```

(`host.docker.internal` lets the k6 container reach ports on your host machine.)

**Observed:**
```text
✓ 'p(95)<500' p(95)=76.53ms
✓ 'rate<0.01' rate=0.00%
http_req_duration: avg=60.12ms med=56.58ms p(90)=64.3ms p(95)=76.53ms p(99)=145.77ms
http_reqs: 6129  153/s
```

**Explain:** k6 ramps virtual users up and down (see `stages` in [k6/load-test.js](k6/load-test.js)) and **fails the run** if a threshold is violated. This is how SLOs become automated checks in CI.

**Make it fail on purpose:**
```bash
curl -s -X POST localhost:3001/chaos -H "Content-Type: application/json" -d '{"failureRate":0.05}'
docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 -e MAX_VUS=20 grafana/k6 run - < k6/load-test.js
# ✗ 'rate<0.01' rate=4.99%  → "thresholds on metrics 'http_req_failed' have been crossed", exit code 99
curl -s -X POST localhost:3001/chaos/reset
```

**Try:** `-e ENDPOINT="/api/cpu?n=32" -e MAX_VUS=50`. Watch p95 explode as CPU saturates.

---

## Cleanup

```bash
docker compose down        # stop and remove containers and network
```

## Reflection questions

1. In experiment 3, what would happen to RPS if the database behind `/api/io` got 5× slower?
2. In experiment 5, why is vertical scaling still useful for *some* workloads? (Hint: memory, I/O.)
3. In experiment 7, when would retries make an outage *worse*?
4. In experiment 8, which mode would you pick for a bank balance? For a "likes" counter? Why?
5. In experiment 9, the cluster had zero errors, but what single component could still take the whole container down?
