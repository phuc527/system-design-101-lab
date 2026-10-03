# Interview Questions: System Design Basics

Answer out loud before reading the answer. In interviews, *how* you reason (assumptions, numbers, trade-offs) matters more than reciting definitions.

---

## Beginner

### Q1. What's the difference between latency and throughput?

**Answer:**
- **Latency** is how long *one* request takes (ms). **Throughput** is how many requests complete per unit of time (RPS).
- They're related by **Little's Law**: `throughput = concurrency / latency`. 100 concurrent requests at 100ms each ≈ 1000 RPS.
- They can move independently: adding servers raises throughput without changing per-request latency, and batching raises throughput but *increases* latency.
- Analogy: a highway's latency is the travel time, its throughput is cars per hour.

### Q2. Why do we report p95/p99 latency instead of the average?

**Answer:** averages hide outliers. If 98% of requests take 50ms and 2% take 1s, the average is ~70ms, a number no actual request had, while 1 in 50 users waits a full second (this lab's experiment 2 measured exactly that). p99 shows what your unhappiest users experience. At high volume that "1%" is thousands of people, and with fan-out (one page calls 20 services) the chance of hitting at least one slow call grows fast: `1 − 0.99²⁰ ≈ 18%`.

### Q3. What does "99.9% availability" mean in practice?

**Answer:** the service may be down (or failing) 0.1% of the time: about **8h 45m per year**, **43m 50s per month**, or **1m 26s per day**. Each extra nine cuts allowed downtime 10×. 99.99% is ~52 minutes per year, which usually rules out manual recovery and requires automated failover. The 0.1% is the **error budget**, which teams spend on deploys and experiments.

### Q4. What's the difference between vertical and horizontal scaling?

**Answer:**
- **Vertical (scale up):** a bigger machine (more CPU/RAM). Simple, no code changes, but it has a ceiling, gets expensive, and is still a single point of failure.
- **Horizontal (scale out):** more machines behind a load balancer. Nearly unlimited and adds redundancy, but services must be stateless and you take on distributed-systems complexity.
- Typical path: scale vertically until it hurts, then horizontally for stateless tiers. Databases scale vertically longer, then via replicas and sharding.

### Q5. What's the difference between bandwidth and latency?

**Answer:** latency is the *delay* for data to travel (the length of the pipe). Bandwidth is the *capacity* in bytes per second (the width). `transfer time ≈ latency + size / bandwidth`. A tiny API response is latency-dominated, so reduce round trips. A 50 MB file is bandwidth-dominated, so compress, use a CDN, or send less. In this lab, 200 KB of JSON became 9 KB with gzip, and a 100 KB download at 50 KB/s took 2s regardless of server speed.

---

## Intermediate

### Q6. Why doesn't giving a Node.js server more CPU cores make it faster?

**Answer:** Node executes JavaScript on a **single thread** (the event loop). One process uses roughly one core for your code; extra cores only help libuv's thread pool (fs, dns, crypto, zlib) and GC. In this lab, 1 process on 2 CPUs performed the same as on 1 CPU for CPU-bound work. To use more cores you need **more processes** (`cluster`, PM2, multiple containers/pods) or `worker_threads` for CPU-heavy tasks. For I/O-bound work one process is often enough, because waiting doesn't use CPU.

### Q7. Two services each with 99.9% availability are called in sequence. What's the overall availability? What if you run two independent replicas of one service?

**Answer:**
- **Series:** `0.999 × 0.999 = 0.998` → **99.8%** (about 17.5 hours of downtime per year instead of 8.75). Every hard dependency lowers availability, so you can't be more available than the product of your dependencies.
- **Parallel:** `1 − (1 − 0.999)² = 0.999999` → **99.9999%**.
- **Caveat:** parallel math assumes *independent* failures. Replicas in the same zone, running the same buggy release, or sharing a database fail together. In practice, spread replicas across zones and make dependencies soft (cache, fallback, async) where you can.

### Q8. What's the difference between availability, reliability, and fault tolerance?

**Answer:**
- **Availability:** is it up and responding? (% of successful requests or uptime)
- **Reliability:** does it do the *right* thing consistently over time? (correctness, MTBF). A service returning wrong prices quickly is available but not reliable.
- **Fault tolerance:** does it keep working when components fail? It's a design *property* (redundancy, failover, retries) that helps you achieve high availability and reliability.
- Example from this lab: killing a cluster worker caused zero errors (fault tolerant), while killing the single-process container caused ~2s of downtime (lower availability, even though Docker restarted it).

### Q9. A CPU-heavy endpoint is making your whole Node.js API slow. What happens, and how do you fix it?

**Answer:** synchronous CPU work blocks the event loop, so *every* request on that process waits, including health checks. In this lab `/health` went from 5ms to 2.5s. Load balancers or Kubernetes may then mark the instance unhealthy and restart it, which can cascade. Fixes, in rough order:
1. Make the work cheaper (better algorithm, caching results).
2. Move it off the main thread: `worker_threads` / a worker pool (e.g. Piscina).
3. Make it asynchronous: enqueue a job, return `202 Accepted`, process in a worker service (lab 08).
4. Isolate it: a separate service and deployment so it can't starve the main API.
5. Scale out processes (helps capacity, but each process still blocks per request).

Detect it with **event-loop delay** metrics (`perf_hooks.monitorEventLoopDelay`).

### Q10. Explain Little's Law and use it to size a system.

**Answer:** `L = λ × W`: items in the system = arrival rate × time each spends in the system. For services: `concurrency = RPS × latency`.
Example: target 2,000 RPS, average latency 50ms → `2000 × 0.05 = 100` concurrent requests in flight. If each instance comfortably handles 30 concurrent requests at that latency, you need `100 / 30 ≈ 4` instances. Add N+1 for failures and ~30–50% headroom, so 6 instances.
It also explains outages: if the database slows from 50ms to 500ms, concurrency at the same RPS jumps 10× to 1000, exhausting connection pools and memory. **Latency spikes become capacity problems.**

---

## Advanced

### Q11. Explain the CAP theorem with a concrete example. Is "CA" a valid choice?

**Answer:** in a distributed store, during a **network partition** you must choose between **Consistency** (every read sees the latest write, or errors) and **Availability** (every request gets a non-error response).
Example: inventory replicated in two regions, and the link breaks. A customer buys the last item in region A. A customer in region B checks stock.
- **CP:** B refuses or blocks, since it can't confirm it's up to date. Correct, but errors during the partition.
- **AP:** B says "1 in stock" (stale). Available, but you may oversell, and you must reconcile later.

**"CA" isn't a meaningful choice** for a distributed system. Partitions aren't optional, so a "CA" system is effectively a single node. Better framing is **PACELC**: during a Partition, choose A or C; Else, trade Latency vs Consistency (synchronous replication is consistent but slower). Mention real systems: etcd/ZooKeeper (CP, majority quorum), Cassandra/DynamoDB (AP, tunable consistency), and that many systems let you choose per operation (Cassandra `QUORUM` vs `ONE`).

### Q12. Your AP database used Last-Write-Wins during a partition. What can go wrong, and what are the alternatives?

**Answer:** LWW keeps the write with the highest timestamp/version and **silently discards** the other. This lab's experiment 8 lost a "9" stock update this way. Problems:
- Real data loss (an order, a payment, a cart item) with no error anywhere.
- With wall-clock timestamps, **clock skew** can make an *older* write win.

Alternatives:
- **Vector clocks / version vectors:** detect concurrent writes and surface conflicts to the application.
- **CRDTs** (conflict-free replicated data types): counters, sets and maps that merge mathematically (e.g. a G-Counter for likes, an OR-Set for cart items).
- **Application-level merge:** e.g. union shopping carts (Amazon Dynamo's approach).
- **Avoid the conflict:** route all writes for a key to one leader (single-leader per partition), or use CP for that data.

### Q13. Your service has 20% transient failures. A teammate proposes "retry up to 5 times". What do you say?

**Answer:** retries help with transient, independent failures. With 3 attempts success goes from 80% to `1 − 0.2³ = 99.2%` (measured 98.4% in this lab), at a cost of ~1.24× load. But:
1. **Why 20%?** If it's overload, retries add load to a struggling system and cause a **retry storm**. 5 retries can mean up to 6× traffic, and with retries at several layers (client → gateway → service → DB) it multiplies (3 layers × 3 attempts = 27×).
2. **Exponential backoff + jitter** so retries spread out instead of synchronizing.
3. **Limit retries** (2–3) and use a **retry budget** (e.g. retries ≤ 10% of requests).
4. **Only retry safe things:** idempotent operations, or use idempotency keys (lab 20). Never blindly retry "charge card".
5. **Timeouts** on each attempt, and an overall deadline.
6. **Circuit breaker** (lab 18) to stop calling a dependency that's clearly down.
7. Retry only retryable errors: 503, 504, connection reset. Not 400/401/404.

### Q14. You need 99.99% availability for an API that depends on PostgreSQL (99.95%) and a third-party payment API (99.9%). Is it possible? How would you design it?

**Answer:** in series, `0.9995 × 0.999 ≈ 99.85%` before counting your own code, so 99.99% is **impossible with hard synchronous dependencies**. Design options:
- **Make the payment provider a soft dependency:** accept the order, enqueue payment processing (queue / Kafka), and confirm asynchronously. The API's availability is then decoupled from the provider's.
- **Redundancy for the database:** primary + synchronous standby with automatic failover across zones (lab 05), which raises effective DB availability. Read replicas and caching let reads survive primary failures.
- **Multiple payment providers** with failover (parallel availability).
- **Graceful degradation:** serve cached product data, queue writes, and show "payment pending".
- **Redefine the SLO** per user journey: browsing at 99.99%, checkout completion at 99.9%.

The key insight to state: *you can't exceed the availability of your hard dependencies, so you remove them from the critical path.*

### Q15. You scaled a Node.js service from 1 to 4 instances, but throughput only went up 1.6×. What could explain this, and how do you investigate?

**Answer:** scaling is rarely linear. Likely causes:
- **Shared bottleneck downstream:** database connections, CPU or locks, a Redis instance, a rate-limited third-party API. The bottleneck moved and you didn't remove it.
- **Load balancer issues:** uneven distribution (long-lived keep-alive connections pinned to one instance, sticky sessions), or the LB itself saturated.
- **Resource contention on the host:** instances share physical cores (hyperthreads), memory bandwidth or network, and laptops/VMs reduce clock speed under load. This lab measured ~1.3× for 2 processes on a laptop for exactly this reason.
- **The load generator is the bottleneck:** it can't produce enough traffic, or runs on the same machine.
- **Coordination costs:** distributed locks, cache invalidation, chatty cross-instance calls.
- **Amdahl's law:** the serialized fraction of work caps speedup.

Investigation: check per-instance CPU and event-loop delay (are instances idle or busy?), per-instance RPS (is distribution even?), downstream latency and saturation (DB CPU, connection pool wait time, p99 of dependency calls), and run the load generator from a separate machine. Fix the measured bottleneck: connection pooling, caching, read replicas, sharding, or better balancing (least-connections).
