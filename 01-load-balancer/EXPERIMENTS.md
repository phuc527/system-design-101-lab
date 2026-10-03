# Experiments: Load Balancer

Loop for every experiment: **predict → run → observe → explain**.

> All numbers were measured on a Windows laptop (Intel i5-1130G7, 4 cores / 8 threads, Docker Desktop). Your absolute numbers will differ. Compare **ratios and shapes**.

## Setup

```bash
cd 01-load-balancer
npm install
docker compose up --build -d
docker compose ps                     # wait for 5 x (healthy)
```

Use **Git Bash** on Windows. Several experiments need **two terminals**: terminal A runs the traffic, terminal B breaks things.

Handy shortcuts (paste into each terminal):

```bash
J='-H Content-Type:application/json'
chaos() { curl -s -X POST localhost:300$1/admin/chaos $J -d "$2"; echo; }   # chaos 2 '{"mode":"error"}'
use()   { NGINX_STRATEGY=$1 docker compose up -d --no-deps nginx; sleep 3; curl -s localhost:8090/lb-health; echo; }
```

Reset everything between experiments:

```bash
for i in 1 2 3; do chaos $i '{"mode":"healthy"}'; done
docker compose start api1 api2 api3   # in case one is stopped
use round-robin
```

### The `distribution` script

```bash
npm run dist -- --url http://localhost:8090/ --n 300          # batch: 300 requests, then a summary
npm run dist -- --url "http://localhost:8090/work?ms=20" --watch 25   # one line per second for 25s
```

Watch mode prints which instance answered each second. That's how you *see* failover:

```text
  5s  api1=123  api2=123  api3=123   errors=0    p99=56ms
  6s  api1=160  api2=58   api3=160   errors=0    p99=45ms   ← api2 died during this second
  7s  api1=173  api3=173             errors=0    p99=85ms
```

---

## Experiment 1: Baseline: what does a load balancer cost?

**Question:** every request now makes an extra network hop. How much latency does it add?

```bash
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w "direct=%{time_total} " localhost:3001/
  curl -s -o /dev/null -w "nginx=%{time_total} "  localhost:8090/
  curl -s -o /dev/null -w "ts-lb=%{time_total}\n" localhost:8091/
done
curl -s -i localhost:8090/ | grep -iE "x-instance|x-upstream|x-lb"
```

**Observed:**
```text
direct=0.0075 nginx=0.0087 ts-lb=0.0098
direct=0.0073 nginx=0.0099 ts-lb=0.0162
X-Instance: api1      X-Upstream-Addr: 172.18.0.4:3000      X-LB-Strategy: round-robin
```

**Explain:** Nginx adds ~1–3ms (one extra hop inside Docker, plus parsing). That's the price of everything else in this lab. The TS LB is a bit slower: Node parses HTTP in JavaScript-land, while Nginx is optimized C. Both reuse **keep-alive connections** to the backends, so they don't pay a TCP handshake per request.

---

## Experiment 2: Horizontal scaling: 1 → 2 → 3 instances

**Question:** each instance has a pool of 10 "DB connections" and each query takes 100ms. What's the max throughput with 1, 2, 3 instances?

**Predict (Little's Law):** one instance = 10 / 0.1s = ___ req/s. Three instances = ___ req/s. With 100 concurrent clients on one instance, latency ≈ ___ ms.

```bash
# 1 instance: stop the others. Nginx notices via DNS within ~10s.
docker compose stop api2 api3
sleep 12
npm run dist -- --n 20                                     # confirm: 100% api1
npx autocannon -c 100 -d 10 "http://localhost:8090/work?ms=100"

# 2 instances
docker compose start api2 && sleep 10
npx autocannon -c 100 -d 10 "http://localhost:8090/work?ms=100"

# 3 instances
docker compose start api3 && sleep 10
npx autocannon -c 100 -d 10 "http://localhost:8090/work?ms=100"

# same through the TypeScript LB
npx autocannon -c 100 -d 10 "http://localhost:8091/work?ms=100"
```

**Observed:**

| Instances | Req/s (avg) | p50 latency | p99 latency |
|---|---|---|---|
| 1 | **97** | 1016ms | 1095ms |
| 2 | **195** | 508ms | 581ms |
| 3 | **293** | 325ms | 404ms |
| 3 via TS LB | 286 | 326ms | 529ms |

**Explain:**
- Throughput scaled **linearly**, ~97 req/s per instance, exactly what Little's Law predicts for a 10-slot pool and 100ms queries.
- Latency halved, then dropped to a third: with 100 clients and 10 slots, each request waits ~10 "rounds" of 100ms = 1s. Three instances give 30 slots, so ~3.3 rounds ≈ 330ms.
- Check the queue yourself: `curl -s "localhost:3001/work?ms=100"` during a run shows `queuedMs` and `pool.waiting`.
- Real-world equivalent: a service with `max: 10` in its `pg.Pool`. More instances = more connections... until the *database* runs out of connections (labs 04–05).

**Also notice:** Nginx picked up stopped and started instances on its own. That's the `resolve` parameter re-querying Docker's DNS every 5s, a simple form of **service discovery** (lab 16).

---

## Experiment 3: CPU-bound scaling on one laptop (a surprise)

**Question:** each container is limited to 1 CPU. Does `/cpu` throughput double with 2 instances?

```bash
docker compose stop api2 api3 && sleep 12
npx autocannon -c 30 -d 10 "http://localhost:8090/cpu?n=30"
docker compose start api2 && sleep 10
npx autocannon -c 30 -d 10 "http://localhost:8090/cpu?n=30"

# While the second one runs, in terminal B:
curl -s "localhost:3001/cpu?n=30" | grep -o '"serverMs":[0-9]*'      # ~13ms when idle
```

**Observed:**
```text
1 instance:  66 req/s
2 instances: 70 req/s      ← barely changed
serverMs under load: 29-41ms (vs ~13ms idle)
Host CPU: Intel i5-1130G7, running at 802 MHz (max 1.8 GHz base), Intel DPTF power manager active
```

**Explain:** each fibonacci call got **2–3× slower** under load. The instances weren't the bottleneck, **the physical machine was**. This laptop has a 15-watt CPU: when two cores run flat out, it lowers its clock speed to stay within its power budget. Two containers on the same throttled chip get about the same total CPU as one.

**Lesson:** horizontal scaling adds capacity only when the new instances bring **new resources**. Containers on one host share that host's CPU, memory bandwidth and power budget. In production, instances run on separate machines. On a desktop or server CPU this experiment scales much better. This is also why experiment 2 uses a resource pool: it models the per-instance limit that real services hit first (connections, threads), independent of your laptop.

---

## Experiment 4: Kill an instance

**Question:** api2 dies abruptly while serving traffic. How many requests fail?

```bash
# Terminal A
npm run dist -- --url "http://localhost:8090/work?ms=20" --watch 25

# Terminal B, ~5s later
docker kill sd101-lb-api2-1
```

**Observed (Nginx):**
```text
  5s  api1=123  api2=123  api3=123   errors=0    p99=56ms
  6s  api1=160  api2=58   api3=160   errors=0    p99=45ms
  7s  api1=173  api3=173             errors=0    p99=85ms
  8s  api1=100  api3=97              errors=0    p99=179ms
  9s  api1=179  api3=182             errors=0    p99=83ms
 ...
Requests: 9498   Errors: 0 (0.0%)
```

**Explain:**
- **Zero errors.** Requests in flight on api2 got a connection reset, and new ones got "connection refused". Nginx treats both as `error` in `proxy_next_upstream` and **retried them on api1/api3**. The user only saw a latency blip (p99 179ms for ~2 seconds).
- `max_fails=2 fail_timeout=10s` stops Nginx from even trying api2 after 2 failures. It retests every 10s with real traffic, and DNS (`resolve`) eventually removes the dead container entirely.
- api2 did **not** restart, even with `restart: unless-stopped`: Docker treats `docker kill` as a manual stop. Try `curl -X POST localhost:3002/admin/crash` instead, and Docker restarts it within seconds while Nginx brings it back.

**Same through the TS LB** (`--url http://localhost:8091/work?ms=20`, kill api2): also 0 errors. Its logs show the passive check at work:

```bash
docker compose logs node-lb | grep -E "DOWN|attempt failed" | head -3
```
```text
"attempt failed","backend":"api2:3000","attempt":1,"reason":"ECONNRESET socket hang up","willRetry":true
"backend DOWN (passive: real requests failing)","backend":"api2:3000"
```

Bring it back: `docker compose start api2`.

---

## Experiment 5: Freeze an instance (hung, not dead)

**Question:** instead of dying, api2 freezes (deadlock, GC storm, stuck syscall). The TCP port still accepts connections, but nothing answers. What happens?

```bash
# Terminal A
npm run dist -- --url "http://localhost:8090/work?ms=20" --watch 25

# Terminal B, ~5s later: freeze for 13 seconds
docker compose pause api2; sleep 13; docker compose unpause api2
```

**Observed:**
```text
  4s  api1=138  api2=138  api3=138   errors=0    p99=28ms
  5s  api1=70   api2=60   api3=69    errors=0    p99=27ms
  6s                                 errors=0    p99=0ms     ← NOTHING completes
  7s                                 errors=0    p99=0ms
  8s                                 errors=0    p99=0ms
  9s                                 errors=0    p99=0ms
 10s  api1=101  api3=103             errors=0    p99=5027ms  ← the stuck requests finally retried
 11s  api1=213  api3=212             errors=0    p99=46ms
 ...
 21s  api1=140  api2=131  api3=140   errors=0                 ← api2 back after unpause + fail_timeout
max latency: 5027ms
```

**Explain:**
- With round robin, every client's next request soon lands on api2 and **waits**. Within milliseconds all 10 concurrent clients were stuck on the frozen server, so the whole system's throughput dropped to **zero for ~4 seconds**.
- Nginx can't tell "frozen" from "slow" without waiting. After `proxy_read_timeout 5s` it gave up, retried on another server (still 0 errors), and after 2 timeouts `max_fails` ejected api2 for 10s.
- **A hung server is worse than a dead one.** Dead = instant "connection refused" → instant retry. Hung = a full timeout per request.

**Do active health checks fix it? Not on their own.** Repeat through the TS LB (`--url "http://localhost:8091/work?ms=20"`):

```text
  6s ... 9s   (nothing completes)                      ← same ~4s stall
 10s  api1=104  api3=103   errors=0  p99=5025ms
node-lb: 13:09:59.029 backend DOWN (active health check) api2 - health check failed: The operation was aborted due to timeout
node-lb: 13:09:59.393 attempt failed api2 - no response within 5000ms (x10, all retried)
```

The active check marked api2 DOWN ~4.6s after the freeze (1s probe timeout × 2 failures, plus interval). That stops *new* requests from going there, but **all 10 clients were already stuck on api2** and still had to wait out the 5s proxy timeout.

**What actually helps: the per-request timeout.** Restart the TS LB with a 1s proxy timeout and repeat:

```bash
PROXY_TIMEOUT_MS=1000 docker compose up -d --no-deps node-lb
# ...same pause experiment through :8091...
docker compose up -d --no-deps node-lb        # back to the 5000ms default
```
```text
  5s  api1=50   api2=40   api3=49    errors=0    p99=106ms
  6s  api1=104  api3=104             errors=0    p99=1027ms   ← stall shrank from ~4s to ~1s
  7s  api1=201  api3=200             errors=0    p99=29ms
max latency: 1031ms (vs 5027ms)
```

| Lever | Effect |
|---|---|
| **Short per-request timeout** (`proxy_read_timeout`, `PROXY_TIMEOUT_MS`) | bounds how long anyone can be stuck: 5s → 1s stall |
| **least_conn** | stuck requests make api2 look busy, so it stops getting new ones |
| **Active health checks** | eject the server for *future* requests and bring it back automatically, but can't rescue requests already in flight |
| **Too-short timeouts** | legitimately slow requests fail and get retried, doubling load. Size timeouts per endpoint (≈ 2–3× its p99) |

For Nginx, edit `proxy_read_timeout` in [default.conf.template](nginx/templates/default.conf.template), then `docker compose up -d --force-recreate --no-deps nginx`.

---

## Experiment 6: An instance returns errors

```bash
chaos 2 '{"mode":"error"}'                 # api2 answers HTTP 500 to everything
npm run dist -- --n 300
chaos 2 '{"mode":"healthy"}'
```

**Observed:**
```text
Errors:   0 (0.0%)
  api1                150   50.0%
  api3                150   50.0%
Status codes: 200  300
```

**Explain:** `proxy_next_upstream ... http_500` made Nginx retry each failed GET on the next server, and after 2 failures `max_fails` stopped sending to api2. The client never saw a 500.

**Now try a POST**, which must NOT be retried (it could create a duplicate order):
```bash
chaos 1 '{"mode":"error"}'; chaos 2 '{"mode":"error"}'; chaos 3 '{"mode":"error"}'
curl -s -X POST localhost:8090/cart/items $J -H "X-User-Id: amy" -d '{"item":"pen"}' -w "  [HTTP %{http_code}]\n"
docker compose logs nginx --tail 1          # "upstream":"<one address>" → only one attempt
for i in 1 2 3; do chaos $i '{"mode":"healthy"}'; done
```

---

## Experiment 7: Active vs passive health checks

**Question:** api3's `/health` returns 503, but real requests still work (e.g. a health check that tests a non-critical dependency). What does each LB do?

```bash
chaos 3 '{"mode":"unhealthy"}'
sleep 6
echo "--- Nginx (passive only)";  npm run dist -- --url http://localhost:8090/ --n 300 | grep api
echo "--- TS LB (active checks)"; npm run dist -- --url http://localhost:8091/ --n 300 | grep api
docker compose logs node-lb | grep -E "DOWN|UP" | tail -2
chaos 3 '{"mode":"healthy"}'                # watch the TS LB bring api3 back
```

**Observed:**
```text
--- Nginx (passive only)
  api1   101   33.7%     api2   99   33.0%     api3   100   33.3%
--- TS LB (active checks)
  api1   150   50.0%     api2   150   50.0%
"backend DOWN (active health check)","backend":"api3:3000","reason":"health check returned HTTP 503"
"backend UP (active health check)","backend":"api3:3000"
```

**Explain:**
| | Passive (Nginx OSS) | Active (TS LB, NGINX Plus, HAProxy, AWS ALB, Envoy) |
|---|---|---|
| Signal | real requests failing | periodic `GET /health` |
| Detects with zero traffic | ❌ | ✅ |
| Cost | some real users hit the failure first | extra requests to every backend |
| Brings a server back | retries it with real traffic after `fail_timeout` | after `HEALTHY_THRESHOLD` good checks |
| Fooled by | a server that fails only some requests | a `/health` that lies (either way) |

Production LBs use **both**. And what `/health` should check is a design decision of its own (lab 17).

---

## Experiment 8: One slow instance: round robin vs least connections

**Question:** api1 becomes slow (+500ms per request, e.g. a noisy neighbour). How do the algorithms react?

```bash
chaos 1 '{"mode":"slow","slowMs":500}'

use round-robin
npm run dist -- --url "http://localhost:8090/work?ms=20" --n 600 --c 20

use least-conn
npm run dist -- --url "http://localhost:8090/work?ms=20" --n 600 --c 20

chaos 1 '{"mode":"healthy"}'; use round-robin
```

**Observed:**

| | Throughput | p50 | p95 | Requests to slow api1 |
|---|---|---|---|---|
| round robin | 97 req/s | 26ms | **528ms** | 200 (33.3%) |
| least_conn | **362 req/s** | 24ms | **55ms** | 21 (3.5%) |

**Explain:**
- **Round robin is blind:** api1 gets its turn no matter how slow it is, so 1 in 3 requests takes 500ms+, and clients waiting on those can't send more. Throughput collapses.
- **Least connections** looks at requests in flight: api1's requests linger, so its count stays high and new requests go elsewhere. Throughput was 3.7× higher.
- **When least connections does NOT help:** a single burst of simultaneous requests. If 30 requests arrive at the same instant, every server has 0 in flight and least_conn degrades to round robin. Its advantage only appears over time under sustained load. (One of the tests in [tests/balancer.integration.test.ts](tests/balancer.integration.test.ts) originally failed because of exactly this.)

Try the same with the TS LB: `curl -X POST "localhost:8091/lb/strategy?name=least-connections"`.

---

## Experiment 9: Sticky sessions and the in-memory cart

**Question:** each instance stores carts in its own memory. What does a user experience behind a load balancer?

```bash
cart() {
  for item in keyboard mouse monitor; do
    curl -s -X POST localhost:8090/cart/items $J -H "X-User-Id: $1" -d "{\"item\":\"$item\"}"; echo
  done
  for i in 1 2 3; do curl -s localhost:8090/cart -H "X-User-Id: $1"; echo; done
}

use round-robin; cart alice
use hash;        cart bob
npm run dist -- --n 300 --users 50       # 50 different users, hash strategy
use ip-hash
npm run dist -- --n 300                  # every request from your machine
use round-robin
```

**Observed:**
```text
round-robin, alice:
  {"instance":"api3","user":"alice","items":["keyboard"]}
  {"instance":"api1","user":"alice","items":["mouse"]}
  {"instance":"api2","user":"alice","items":["monitor"]}       ← cart scattered over 3 servers
  {"instance":"api3","user":"alice","items":["keyboard"]}      ← "where did my mouse go?"
hash (by X-User-Id), bob:
  {"instance":"api1","user":"bob","items":["keyboard","mouse","monitor"]}   ← always api1
50 users with hash:   api1 44%   api2 28%   api3 28%
ip-hash:              api3 100%
```

**Explain:**
- **Round robin + in-memory state = broken app.** Each request sees a different server's memory.
- **`hash $http_x_user_id consistent`** pins each user to one server, so the cart "works". But distribution depends on *which* users are active: 50 users split 44/28/28. And if api1 dies, bob's cart is gone.
- **`ip_hash` sent 100% to api3** because every request from your machine arrives from the same Docker gateway IP. Nginx even hashes only the first 3 octets of IPv4. In production, thousands of users behind one corporate NAT or mobile carrier gateway all land on one server.
- **The real fix:** make instances **stateless** and keep carts and sessions in a shared store (Redis), so any instance can serve any user (lab 22).

---

## Experiment 10: Weighted routing (canary releases)

```bash
use weighted                              # api1 weight=3, api2=1, api3=1
npm run dist -- --n 500
use round-robin
```

**Observed:**
```text
  api1   300   60.0%
  api2   100   20.0%
  api3   100   20.0%
```

**Explain:** weights are used for (a) **mixed hardware**, where a bigger box gets a bigger share, and (b) **canary deploys**: run the new version on one server with `weight=1` out of 20 total and only 5% of users see it. Watch its error rate, then shift weights gradually.

---

## Experiment 11: Zero-downtime shutdown (connection draining)

**Question:** during a deploy, instances get `SIGTERM`. Can we restart one with **zero** failed requests and **no** retries?

The shutdown sequence in [src/api/server.ts](src/api/server.ts):
```text
SIGTERM → /health returns 503 + every response says "Connection: close"
        → wait DRAIN_MS (LBs notice and stop sending)
        → server.close(): finish in-flight requests, refuse new connections
        → exit 0
```

```bash
# Terminal A (through the TS LB, which has active checks)
npm run dist -- --url "http://localhost:8091/work?ms=20" --watch 16

# Terminal B, ~4s later
docker compose stop api2
docker inspect sd101-lb-api2-1 --format 'exit={{.State.ExitCode}}'
docker compose logs api2 | tail -3
docker compose logs node-lb | grep -E "DOWN|attempt failed" | tail -3
```

**Observed (final, working version):**
```text
12:52:37.774  api2   draining before shutdown (SIGTERM, drainMs 6000)
12:52:41.671  node-lb  backend DOWN (active health check) api2 - health check returned HTTP 503
12:52:43.776  api2   closing server
12:52:43.777  api2   all connections closed, exiting
exit=0      Errors: 0 (0.0%)      no "attempt failed" lines → zero retries needed
```

**It took three tries to get here, and each failure teaches something:**

| Try | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | 0 errors, but only thanks to retries. The LB noticed via *connection refused* | `DRAIN_MS=3000` < LB detection time (2 checks × 2s interval ≈ 4–6s) | `DRAIN_MS=6000` |
| 2 | Killed after exactly 3s, `exit=137` (SIGKILL) | Docker's stop grace period on this machine was **3s**, shorter than the drain | `stop_grace_period: 15s` in compose |
| 3 | api2 kept serving until SIGKILL at 15s, never ejected | (a) LB counted successful proxied requests as health successes, resetting the failure streak. (b) `server.close()` doesn't close *busy* keep-alive connections | (a) only active checks restore health. (b) `Connection: close` on every response while draining, plus a force-close deadline |

**The timing rule (memorize it):**
```text
LB detection time  <  DRAIN_MS  <  stop grace period
(interval × threshold)            (minus longest request)
   ~4s             <    6s      <    15s
```
Kubernetes equivalents: readiness probe period × failureThreshold < preStop sleep < `terminationGracePeriodSeconds`.

**Try:** through Nginx (`--url http://localhost:8090/...`), you'll also see 0 errors. Nginx can't see `/health`, so it keeps sending during the drain (api2 still answers, with `Connection: close`), then retries on another server once api2 refuses connections.

---

## Experiment 12: Load test with k6

```bash
docker compose start api1 api2 api3
docker run --rm -i -e BASE_URL=http://host.docker.internal:8090 grafana/k6 run - < k6/load-test.js
```

**Observed:**
```text
✓ 'p(95)<1000' p(95)=127.92ms
✓ 'rate<0.01'  rate=0.00%
served_by_api1: 2493    served_by_api2: 2492    served_by_api3: 2492
http_reqs: 7477  213.6/s       http_req_duration: med=107ms p(95)=128ms p(99)=162ms
```

**Try:** run it again and, halfway through, `docker kill sd101-lb-api3-1`. The thresholds should still pass.

> **Port trap we hit:** this lab originally used port 8080. On the test machine an Apache `httpd` held `0.0.0.0:8080` (IPv4) while Docker got only `[::]:8080` (IPv6). `curl localhost:8080` reached Nginx over IPv6, but k6 (via `host.docker.internal`, IPv4) reached Apache and got 100% 404s. See TROUBLESHOOTING.md.

---

## Cleanup

```bash
docker compose down
```

## Reflection questions

1. In experiment 2, what would happen if all three instances shared one database with a max of 20 connections?
2. In experiment 5, what timeout would you choose for an endpoint whose p99 is 300ms? What breaks if you go too low?
3. In experiment 7, should `/health` fail when Redis (a cache) is down? When PostgreSQL is down? (Lab 17)
4. In experiment 9, list two ways to make the cart work without sticky sessions.
5. Draw how you'd remove the load balancer as a single point of failure.
