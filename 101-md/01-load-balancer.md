# 01 — Load Balancer

> One server has a ceiling and is a single point of failure. A load balancer turns N servers into one logical service.

---

## 1. The problem

```text
10,000 users ──▶ [ one API server ]   ← CPU 100%, p99 explodes, and if it dies: 100% outage
```

Adding a second server doesn't help unless something **distributes** requests and **stops sending** to dead servers. That something is a load balancer (LB).

```text
                 ┌──▶ API 1
clients ──▶ LB ──┼──▶ API 2
                 └──▶ API 3
```

What an LB gives you:

1. **Scalability** — add capacity by adding instances
2. **Availability** — route around failed instances
3. **Zero-downtime deploys** — drain one instance, upgrade it, put it back
4. **A single entry point** — TLS termination, compression, headers, logging

---

## 2. Layer 4 vs Layer 7

| | L4 (transport) | L7 (application) |
|---|---|---|
| Sees | IP + port, TCP/UDP | HTTP method, path, headers, cookies |
| Can route by | connection | URL, header, cookie, host |
| Speed | very fast, low CPU | slower (parses HTTP) |
| TLS | passthrough (usually) | terminates TLS |
| Examples | AWS NLB, LVS, HAProxy (tcp mode) | Nginx, Envoy, HAProxy (http), AWS ALB, Traefik |

Use **L7** for web APIs (path routing, retries, header injection). Use **L4** for raw TCP (databases, MQTT) or extreme throughput.

---

## 3. Balancing algorithms

### Round robin
Send to 1, 2, 3, 1, 2, 3… Simple and fair when servers and requests are uniform.

### Weighted round robin
Server A (weight 3) gets 3× the traffic of B (weight 1). Use when machines differ in size, or for **canary releases** (new version weight 1 of 20 = 5%).

### Least connections
Pick the server with the fewest in-flight requests. Best when request durations vary a lot (some take 5 ms, some 5 s) — round robin would pile long requests onto one server.

### Least response time / EWMA
Prefer servers that answered fastest recently. Used by Envoy, Finagle.

### Power of two choices (P2C)
Pick **two random** servers, send to the less loaded. Almost as good as least-connections, needs no global state — great for many LBs in parallel.

### IP hash / consistent hash
`hash(client IP or key) % N` → same client always hits same server. Gives **stickiness** (in-memory session, local cache). Use **consistent hashing** so adding/removing a server only remaps ~1/N of keys (→ guide 06).

| Algorithm | Best for | Weakness |
|---|---|---|
| Round robin | uniform requests | ignores load |
| Weighted | mixed hardware, canaries | static weights |
| Least conn | variable durations | needs connection counts |
| P2C | many LB nodes | slightly random |
| Hash | stickiness, cache locality | hot keys, uneven when N changes |

---

## 4. Health checks

### Passive (outlier detection)
LB watches real traffic. If a server returns errors/timeouts `max_fails` times within `fail_timeout`, mark it down for a while.
- ✅ no extra traffic
- ❌ real users eat the failed requests that trigger detection

### Active
LB probes `GET /health` every N seconds. After `fall` failures → down; after `rise` successes → up.
- ✅ detects failure before users do (mostly)
- ❌ extra traffic; the health endpoint might lie (says OK while the real path is broken)

Production uses **both**. See guide 17 for what `/health` should actually check.

```text
probe every 2s:  ✔ ✔ ✔ ✘ ✘ ✘  → DOWN (fall=3)
                 ✘ ✔ ✔        → UP   (rise=2)
```

---

## 5. Sticky sessions — and why to avoid them

If a user's session lives in API 2's memory, every request must go to API 2.

Problems:
- API 2 dies → user logged out
- uneven load (one heavy user pins one server)
- scaling in/out reshuffles users

**Better:** make APIs **stateless** — store sessions in Redis or use signed tokens (JWT). Then any server can handle any request (→ guide 22).

---

## 6. Connection draining (graceful shutdown)

Deploy without dropping requests:

1. Mark instance as **draining** → `/health` returns 503 (readiness fails)
2. LB stops sending **new** requests
3. Instance finishes **in-flight** requests
4. Process exits

```ts
process.on("SIGTERM", () => {
  state.draining = true;              // /ready now returns 503
  server.close(() => process.exit(0)); // stop accepting, wait for in-flight
  setTimeout(() => process.exit(1), 25_000).unref(); // hard deadline
});
```

Set the orchestrator grace period (Docker `stop_grace_period`, k8s `terminationGracePeriodSeconds`) longer than your longest request.

---

## 7. The LB itself as a SPOF

One LB = new single point of failure. Solutions:

- **Active/passive pair** with a floating virtual IP (keepalived/VRRP)
- **Active/active** behind DNS round robin or anycast
- **Managed LB** (AWS ALB/NLB, GCP LB) — redundancy handled for you

```text
           DNS / anycast
          ┌──────┴──────┐
        LB-1          LB-2
          └──┬───┬───┬──┘
          API1 API2 API3
```

---

## 8. Nginx example

```nginx
upstream api {
    least_conn;
    server api1:3000 max_fails=3 fail_timeout=10s;
    server api2:3000 max_fails=3 fail_timeout=10s;
    server api3:3000 weight=2;
    keepalive 32;                       # reuse upstream TCP connections
}

server {
    listen 80;
    location / {
        proxy_pass http://api;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_next_upstream error timeout http_502 http_503;
        proxy_next_upstream_tries 2;
        proxy_connect_timeout 1s;
        proxy_read_timeout 10s;
    }
}
```

---

## 9. Node.js sketch — a tiny round-robin LB

```ts
import http from "node:http";

const backends = ["http://localhost:3001", "http://localhost:3002"];
const healthy = new Set(backends);
let i = 0;

function next(): string | undefined {
  const list = backends.filter((b) => healthy.has(b));
  if (list.length === 0) return undefined;
  return list[i++ % list.length];
}

setInterval(async () => {
  for (const b of backends) {
    try {
      const r = await fetch(`${b}/health`, { signal: AbortSignal.timeout(1000) });
      r.ok ? healthy.add(b) : healthy.delete(b);
    } catch { healthy.delete(b); }
  }
}, 2000);

http.createServer((req, res) => {
  const target = next();
  if (!target) { res.writeHead(503).end("no healthy backend"); return; }
  const url = new URL(req.url ?? "/", target);
  const upstream = http.request(url, { method: req.method, headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", () => { healthy.delete(target); res.writeHead(502).end(); });
  req.pipe(upstream);
}).listen(8090);
```

---

## 10. Failure modes

| Failure | Symptom | Mitigation |
|---|---|---|
| Backend dies | 502s until detected | active checks + `proxy_next_upstream` retry |
| Slow backend (not dead) | p99 rises, health still OK | least-conn, timeouts, outlier detection |
| Health check lies | 200 on `/health`, 500 on real routes | meaningful readiness checks |
| Retry storm | LB retries non-idempotent POSTs → duplicates | retry only idempotent methods; idempotency keys (guide 20) |
| Thundering herd on recovery | revived server flooded | slow start / gradual weight ramp |
| LB overloaded | everything slow | scale LB, use L4 in front |

---

## 11. Trade-offs

- **L7 flexibility vs L4 speed**
- **Stickiness vs even load / resilience**
- **Aggressive health checks** (fast detection) **vs** flapping and probe overhead
- **LB retries** improve success rate **vs** risk duplicate side effects and amplified load

---

## 12. Production checklist

- [ ] At least 2 instances, in different failure domains (zones)
- [ ] Active + passive health checks, readiness separate from liveness
- [ ] Timeouts on connect and read
- [ ] Retries only on idempotent requests, capped
- [ ] Graceful shutdown + draining tested
- [ ] `X-Forwarded-For` / `X-Request-Id` forwarded
- [ ] LB itself redundant
- [ ] Metrics per upstream: RPS, errors, latency

---

## 13. Interview questions

1. **L4 vs L7?** — L4 routes TCP connections by IP/port; L7 understands HTTP and can route by path/header/cookie.
2. **Round robin vs least connections?** — RR assumes equal requests; least-conn adapts when durations vary.
3. **How does the LB know a server is dead?** — Active probes and passive error tracking; thresholds for fall/rise.
4. **Why avoid sticky sessions?** — Lose session on failure, uneven load; externalise state instead.
5. **How do you deploy with zero downtime?** — Drain: fail readiness, finish in-flight, then stop; rolling update.
6. **Isn't the LB a SPOF?** — Yes unless redundant: VRRP pair, DNS/anycast, or managed LB.
7. **What is consistent hashing used for in LBs?** — Sticky routing / cache locality where changing N remaps only ~1/N keys.

**Prev:** [00 — Basics](00-basics.md) · **Next:** [02 — Caching](02-caching.md)
