# 00 — System Design Basics

> The vocabulary every other topic uses. If you can't measure it, you can't design for it.

---

## 1. Latency

**Latency** = the time between sending a request and receiving the response.

```text
client ──request──▶ network ──▶ server (queue + work) ──▶ network ──response──▶ client
        └──────────────────────── latency ────────────────────────┘
```

Latency is made of:

| Part | Example |
|---|---|
| Network (RTT) | same DC ~0.5 ms, cross-continent ~150 ms |
| Queueing | waiting for a free worker / connection / event-loop tick |
| Processing | CPU work, serialization |
| Downstream calls | DB, cache, other services |

### Percentiles, not averages

Averages hide pain. If 99 requests take 10 ms and 1 takes 5 s, the average is ~60 ms — looks fine, but 1% of users wait 5 s.

| Metric | Meaning |
|---|---|
| **p50** (median) | half of requests are faster than this |
| **p95** | 95% are faster; 1 in 20 is slower |
| **p99** | 1 in 100 is slower — the "tail" |
| **p99.9** | matters at big scale (1M req/day → 1,000 slow requests) |

**Tail-latency amplification:** if one page fans out to 100 backend calls, each with a 1% chance of being slow, then `1 - 0.99^100 ≈ 63%` of pages hit at least one slow call. That is why p99 matters more as systems grow.

### Latency numbers worth knowing (order of magnitude)

| Operation | Time |
|---|---|
| L1 cache reference | ~1 ns |
| Main memory reference | ~100 ns |
| Read 1 MB sequentially from memory | ~10 µs |
| SSD random read | ~100 µs |
| Round trip in same datacenter | ~0.5 ms |
| Read 1 MB sequentially from SSD | ~1 ms |
| Disk seek (HDD) | ~10 ms |
| Round trip US ↔ Europe | ~150 ms |

Takeaway: **memory ≫ SSD ≫ network ≫ disk seek ≫ cross-region**. Caching exists because of this table.

---

## 2. Throughput

**Throughput** = how much work per unit of time: requests/second (RPS), queries/second (QPS), MB/s.

Latency and throughput are related but different:

- A highway with more lanes = higher throughput, same speed (latency).
- A faster car = lower latency, same number of lanes.

### Little's Law

```text
L = λ × W
concurrency = throughput × latency
```

If your API handles **200 RPS** and each request takes **50 ms**, then on average **10 requests are in flight**.

Use it backwards: a DB pool of 20 connections with 10 ms queries can do at most `20 / 0.010 = 2,000` queries/s. Need more? Either shorten queries or add connections.

### Saturation

As utilisation approaches 100%, queueing explodes. Latency stays flat, then shoots up — the "hockey stick".

```text
latency
  │                          ╱
  │                        ╱
  │                     ╱
  │ ───────────────────
  └──────────────────────────── load
                    ~70-80% utilisation
```

Rule of thumb: plan capacity so normal peak sits around 60–70% utilisation.

---

## 3. Bandwidth

**Bandwidth** = maximum data rate of a link (e.g. 1 Gbps). Throughput is what you actually achieve.

Back-of-envelope: a 1 Gbps NIC ≈ 125 MB/s. If each response is 500 KB, the NIC caps you at ~250 RPS no matter how fast your code is. Fixes: compression (gzip/brotli), pagination, smaller payloads, CDN.

---

## 4. Availability

**Availability** = fraction of time the system is serving correctly.

| Availability | Downtime / year | Downtime / month |
|---|---|---|
| 99% ("two nines") | 3.65 days | 7.2 h |
| 99.9% | 8.76 h | 43.8 min |
| 99.99% | 52.6 min | 4.4 min |
| 99.999% | 5.26 min | 26 s |

### Series vs parallel

**Series** (all must work): multiply.
```text
API (99.9%) → DB (99.9%)   ⇒ 0.999 × 0.999 = 99.8%
```
Every dependency you add **lowers** availability.

**Parallel** (any one works): `1 - (1-a)^n`.
```text
two API instances each 99%  ⇒ 1 - 0.01² = 99.99%
```
Redundancy **raises** availability — if failures are independent (different hosts, racks, zones).

### SLI / SLO / SLA

| Term | Meaning | Example |
|---|---|---|
| SLI | indicator you measure | % of requests < 300 ms and non-5xx |
| SLO | internal target | 99.9% over 30 days |
| SLA | contract with penalty | 99.5% or credits refunded |
| Error budget | `1 - SLO` | 0.1% → ~43 min/month you may "spend" on deploys and incidents |

---

## 5. Reliability, fault tolerance, resilience

- **Reliability** — does it produce correct results over time? (A system can be "up" but return wrong data → available but unreliable.)
- **Fault tolerance** — keeps working when a component fails (redundancy, replication, failover).
- **Resilience** — degrades gracefully and recovers (timeouts, circuit breakers, fallbacks).
- **Durability** — once acknowledged, data isn't lost (fsync, replication).

Single Point Of Failure (**SPOF**): any component whose failure takes the whole system down. Design reviews hunt for them.

---

## 6. Vertical vs horizontal scaling

| | Vertical (scale up) | Horizontal (scale out) |
|---|---|---|
| How | bigger machine (CPU, RAM) | more machines |
| Pros | simple, no code change, no distributed issues | near-unlimited, redundancy |
| Cons | hardware ceiling, SPOF, expensive at top end | needs stateless design, LB, distributed data |
| Good for | databases early on | stateless web/API tier |

**Node.js note:** one Node process runs JavaScript on **one** thread. A 16-core box running a single `node server.js` uses ~1 core for JS. Options: `cluster` module, PM2, or multiple containers behind a load balancer (→ guide 01).

---

## 7. CAP theorem

In a distributed data store, during a **network Partition** you must choose:

- **C**onsistency — every read sees the latest write (or errors)
- **A**vailability — every request gets a non-error response (maybe stale)

```text
        ┌──────────┐   ✂ partition ✂   ┌──────────┐
client ▶│ Node A   │ ───────X────────  │ Node B   │◀ client
        └──────────┘                   └──────────┘
   CP: A refuses writes it can't replicate   AP: both accept, reconcile later
```

P is not optional — networks *will* partition. So the real choice is **CP vs AP during a partition**.

| Choice | Examples | Use when |
|---|---|---|
| CP | ZooKeeper, etcd, HBase, banking ledgers | wrong data is worse than no data |
| AP | Cassandra, DynamoDB (default), DNS, shopping carts | uptime matters, staleness is tolerable |

**PACELC** extends it: *if Partition → A or C; Else → Latency or Consistency*. Even without partitions, stronger consistency costs latency (waiting for replicas).

### Consistency models (weak → strong)

1. **Eventual** — replicas converge "eventually"
2. **Read-your-writes** — you see your own updates
3. **Monotonic reads** — you never go back in time
4. **Causal** — cause before effect for everyone
5. **Strong / linearizable** — behaves like one copy

---

## 8. Back-of-envelope estimation

Interviewers love this. Template:

```text
DAU                      = 10 M
requests per user / day  = 20
total / day              = 200 M
average RPS              = 200 M / 86,400 ≈ 2,300
peak RPS (×2–3)          ≈ 5,000–7,000
storage / record         = 1 KB
new storage / day        = 200 M × 1 KB = 200 GB  → ~73 TB / year
```

Handy: **1 day ≈ 10⁵ seconds** (86,400).

---

## 9. Node.js sketch — measuring latency percentiles

```ts
const samples: number[] = [];

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    samples.push(Number(process.hrtime.bigint() - start) / 1e6); // ms
  });
  next();
});

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

app.get("/stats", (_req, res) => {
  res.json({ p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99) });
});
```

In production you'd use histograms (Prometheus) instead of keeping every sample (→ guide 21).

---

## 10. Interview questions

1. **Why is p99 more important than average?** — Averages hide outliers; at fan-out and scale, tail latency is what most users feel.
2. **Two services at 99.9% in series — total?** — ~99.8%. Dependencies multiply down.
3. **How do you get 99.99% from 99% boxes?** — Two independent instances in parallel behind an LB: `1 - 0.01² = 99.99%`.
4. **What is Little's Law and how do you use it?** — `L = λW`; size pools, workers and concurrency limits.
5. **Explain CAP with an example.** — During a partition a bank ledger refuses writes (CP); a shopping cart accepts them and merges later (AP).
6. **Vertical vs horizontal — when each?** — Vertical for simplicity and stateful DBs early; horizontal for stateless tiers and redundancy.
7. **Why doesn't one Node process use all cores?** — JS runs on a single event-loop thread; scale with cluster/containers.

**Next:** [01 — Load Balancer](01-load-balancer.md)
