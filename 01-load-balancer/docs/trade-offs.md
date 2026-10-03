# Trade-offs

## Load balancer (vs. no load balancer)

### Advantages
- Capacity scales with instances (measured 97 → 195 → 293 req/s)
- Failed instances are bypassed (0 errors on kill)
- Zero-downtime deploys (draining)
- Single stable endpoint, plus a central place for TLS, logging, rate limiting

### Disadvantages
- Extra hop: ~1–3ms with Nginx here
- New component to run, monitor and secure
- New single point of failure unless redundant
- Can mask problems (retries hide a broken instance until all of them break)

### Alternatives
- **DNS round robin:** multiple A records. No health awareness, clients cache records for minutes.
- **Client-side load balancing:** the client knows all instances and picks itself (gRPC, Netflix Ribbon, service meshes). No central hop, but logic lives in every client.
- **Anycast:** many locations announce the same IP and the network routes to the nearest. Used by CDNs and DNS providers.

### When to use
Any service with ≥2 instances. Any public HTTP service (as a reverse proxy, for TLS and protection).

### When not to use
Single-instance internal tools. Systems already behind a mesh or client-side balancing.

### Scaling limits
A single Nginx handles tens of thousands of req/s per core for simple proxying. Beyond that: multiple LBs behind DNS/anycast, or L4 LBs in front of L7 LBs.

---

## Algorithms

| Algorithm | Best for | Weak at | Measured here |
|---|---|---|---|
| Round robin | identical servers, uniform requests | slow or overloaded servers | 33% of traffic to a slow server, p95 528ms |
| Weighted RR | mixed hardware, canaries | dynamic load changes | exact 60/20/20 split |
| Least connections | uneven request cost, slow servers | bursts (degrades to RR), many independent LBs | 3.5% to the slow server, p95 55ms, 3.7× throughput |
| IP hash | stickiness without cookies | NAT / proxies, rebalancing | 100% on one server from one machine |
| Consistent hash (by key) | caches, per-user state | uneven with few keys | 50 users: 44/28/28 |
| Random / P2C | very large fleets, many LBs | small volumes (noisy) | not measured |

---

## Health checks

| | Active | Passive |
|---|---|---|
| Advantages | detects failures without user traffic, auto-recovers | zero extra load, judges real behaviour |
| Disadvantages | extra requests, can be fooled by a lying `/health` | real users hit failures first, recovery needs real traffic |
| Use | always, if your LB supports it | always, as a second signal |

**Interval and threshold trade-off:** faster detection (1s interval, threshold 1) means more false positives (one GC pause ejects a healthy server). Slower detection (10s × 3) means up to 30s of traffic to a dead server. Typical: 5s × 2–3.

---

## Retries in the load balancer

**Advantages:** instance failures invisible to users (0 of 300 errors with a failing instance).
**Disadvantages:** up to 2× load when a backend fails, latency of the failed attempt added (5s for timeouts!), dangerous for non-idempotent requests, can hide a broken instance.
**Use:** idempotent requests, 1 retry, short timeouts.
**Avoid:** POST/PATCH without idempotency keys. Retrying at several layers at once (client + LB + service = multiplied load, lab 19).

---

## Timeouts

| Short timeouts | Long timeouts |
|---|---|
| fast failover from hung servers | fewer false failures for slow legitimate requests |
| risk: slow-but-valid requests fail and get retried (double load) | risk: one hung server stalls clients (experiment 5: ~4s total stall) |

Rule of thumb: read timeout ≈ 2–3× the endpoint's p99, separate locations for genuinely slow endpoints (uploads, reports).

---

## Sticky sessions vs stateless instances

| | Sticky sessions | Stateless + shared store |
|---|---|---|
| Code changes | none | move state to Redis/DB |
| Load distribution | uneven (hot users, NAT) | even |
| Instance dies | its users lose sessions/carts | nothing lost |
| Scaling in/out | users get remapped (state lost) | free |
| Extra latency | none | ~1ms per Redis call |
| Verdict | temporary workaround, or for WebSockets | **the default** |

---

## Nginx vs HAProxy vs Envoy vs cloud LB

| | Nginx OSS | HAProxy | Envoy | AWS ALB |
|---|---|---|---|---|
| Active health checks | ❌ (Plus only) | ✅ | ✅ | ✅ |
| Dynamic config | reload / `resolve` | runtime API | xDS API | managed |
| Also a web server | ✅ | ❌ | ❌ | ❌ |
| Observability | logs, stub_status | rich stats page | very rich | CloudWatch |
| Operational effort | low | low | higher | lowest |
| Typical use | edge proxy + static files | high-performance LB | service mesh, gRPC | AWS workloads |
