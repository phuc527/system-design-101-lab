# Trade-offs

System design has no free lunches. Every technique in this lab buys something and costs something.

---

## Vertical scaling (bigger machine)

### Advantages
- Zero code changes, zero new infrastructure
- No distributed-systems problems: one memory space, no network between parts
- Good fit for things that are hard to distribute: a primary database, an in-memory cache

### Disadvantages
- **Hard ceiling.** The largest cloud instances top out at a few hundred vCPUs and a few TB of RAM.
- Cost grows **super-linearly** at the high end (2× CPU often costs more than 2×).
- Still a **single point of failure**, and resizing usually needs a restart (downtime).
- **A single Node.js process can't use extra cores for JavaScript** (experiment 5).

### Alternatives
Horizontal scaling. Optimizing code (often the cheapest 10× you'll find). Caching.

### When to use
Early stage. Databases. Memory-bound workloads. When you need results *today*.

### When not to use
When you need high availability (one box = one failure domain), or when you're already near the biggest instance size.

### Scaling limits
The biggest machine you can buy. For a single Node process: roughly one core's worth of JavaScript execution.

---

## Horizontal scaling (more processes / machines)

### Advantages
- Nearly unlimited capacity: add instances as load grows
- **Redundancy built in:** one instance dies, others keep serving (experiment 9B)
- Commodity hardware, gradual growth, rolling deploys without downtime

### Disadvantages
- Needs a **load balancer** (lab 01)
- Services must be **stateless**. In-memory sessions, caches and counters break (you saw per-worker `/metrics`).
- **Distributed systems problems:** partial failures, network partitions, consistency (CAP)
- More moving parts to deploy, monitor and debug. Scaling efficiency below 100% (experiment 5: ~1.3× for 2×).

### Alternatives
Vertical scaling. Async processing with queues (lab 08) to smooth load instead of absorbing peaks.

### When to use
Stateless API servers (the default for web backends). When you need HA. When load is unpredictable (auto-scaling).

### When not to use
Before you've measured a bottleneck. For stateful components without a clear partitioning strategy (lab 06).

### Scaling limits
Shared dependencies: the database, a cache, a third-party API. Ten API servers hitting one PostgreSQL just moved the bottleneck.

---

## Node.js `cluster` vs one process per container

| | `cluster` (this lab) | One process per container (Kubernetes-style) |
|---|---|---|
| Uses all cores | ✅ | ✅ (run N containers) |
| Crash recovery | primary re-forks | orchestrator restarts |
| Isolation | workers share container limits | each has its own limits |
| Observability | per-worker metrics inside one container | one metrics endpoint per container |
| Simplicity on a single VM | ✅ simple | needs orchestration |
| **Recommendation** | Single VM / PM2 deployments | Kubernetes, ECS, Docker Swarm |

---

## Retries (client-side fault tolerance)

### Advantages
- Masks transient failures. In experiment 7, 78.6% became 98.4% success.

### Disadvantages
- **Amplifies load:** +26% requests in experiment 7. In an overload outage, retries make it worse (retry storm).
- Increases tail latency (p99 68ms → 114ms).
- **Dangerous for non-idempotent operations:** retrying "charge card" may double-charge.

### Alternatives
Circuit breaker (lab 18). Fallback or cached response. Queue the work for later (lab 08).

### When to use
Idempotent reads. Transient errors (timeouts, 502/503/504, connection resets). Always with a limit, backoff and jitter (lab 19).

### When not to use
4xx errors (the request is wrong, so retrying won't fix it). Non-idempotent writes without idempotency keys (lab 20).

---

## Compression

### Advantages
- 80–95% fewer bytes for JSON/HTML/text (200 KB → 9 KB in experiment 6)
- Faster on slow networks, cheaper egress bills

### Disadvantages
- CPU cost per response, so it competes with your event loop
- Useless for already-compressed data (images, video, zip)

### Alternatives
Compress at the reverse proxy / CDN (Nginx, Cloudflare) instead of in Node. Smaller payloads (pagination, field selection).

### When to use
Text responses > ~1 KB to clients on real networks.

### When not to use
Tiny responses, binary media, or CPU-starved Node services (offload to Nginx).

---

## CP vs AP (CAP theorem)

| | CP | AP |
|---|---|---|
| During a partition | Refuses some requests (errors/timeouts) | Answers everything |
| Data correctness | Never stale | Stale reads, conflicting writes |
| After healing | Nothing to fix | Must reconcile (LWW loses data, CRDTs/merging are complex) |
| Examples | etcd, ZooKeeper, PostgreSQL w/ sync replication, Spanner | Cassandra, DynamoDB, Riak, DNS, caches |
| Good for | Money, inventory, locks, leader election, unique usernames | Feeds, likes, carts, analytics, session caches |

### Scaling limits
CP systems need a **majority** to make progress, so latency grows with replica distance (cross-region consensus is slow). AP systems scale writes well but push complexity into conflict resolution.

---

## Measuring: average vs percentiles

| | Average | Percentiles (p50/p95/p99) |
|---|---|---|
| Cost | one counter + one sum | must keep samples or a histogram |
| Hides outliers | ✅ (bad) | ❌ shows them |
| Aggregatable across instances | ✅ easy | ⚠️ you can't average percentiles. Merge histograms instead (lab 21) |

This lab keeps the last 1000 samples per process in a ring buffer: simple and bounded, but per-process and approximate. Production uses histograms (Prometheus) or sketches (t-digest, HDR histogram).
