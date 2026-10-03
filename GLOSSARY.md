# Glossary

Short, plain-language definitions. Each entry links to the lab where you can see it working.
Node.js examples are simplified to show the idea, not production code.

---

### Availability
The percentage of time a system answers requests correctly.
`availability = uptime / (uptime + downtime)`. "Three nines" (99.9%) allows about 8h 45m of downtime per year.
Lab: [00-basics](00-basics/) (`GET /availability`)

```ts
// What the user sees: successful responses / all requests
const availability = okResponses / totalRequests; // 0.999 = 99.9%
```

### Bandwidth
How many bytes per second a network link can carry. It's the *width* of the pipe; latency is its *length*.
Sending 5 MB over a 1 MB/s link takes at least 5 seconds, however fast your code is.
Lab: [00-basics](00-basics/) (`GET /api/download?kb=200&kbps=50`)

```ts
app.use(compression()); // fewer bytes on the wire = less bandwidth used
```

### CAP
**C**onsistency, **A**vailability, **P**artition tolerance. When the network between nodes breaks (a partition),
a distributed system must choose: refuse requests to stay consistent (**CP**) or keep answering with possibly stale data (**AP**).
Partitions *will* happen, so the real choice is C vs A *during* a partition.
Lab: [00-basics](00-basics/) (`/cap/*` simulator)

### CDN
Content Delivery Network. Servers spread around the world (edges) that cache your static files close to users.
A user in Hanoi downloads `logo.png` from a Singapore edge instead of your origin server in Virginia.
Lab: [13-cdn](13-cdn/)

### Cache
A fast, temporary copy of data that is expensive to fetch or compute. You trade freshness for speed.

```ts
const cached = await redis.get(`user:${id}`);
if (cached) return JSON.parse(cached);           // cache hit: ~1ms
const user = await db.query("SELECT ...", [id]); // cache miss: ~20ms
await redis.set(`user:${id}`, JSON.stringify(user), "EX", 60);
```
Labs: [02-caching](02-caching/), [03-redis](03-redis/)

### Circuit Breaker
Wraps calls to a dependency. After too many failures it "opens" and fails fast for a while instead of
waiting on a service that is already down. Then it lets a few test requests through ("half-open") to see if it recovered.
States: `CLOSED → OPEN → HALF_OPEN → CLOSED`.
Lab: [18-circuit-breaker](18-circuit-breaker/)

### Connection Draining
Gracefully removing a server from rotation: it reports unhealthy, the load balancer stops sending *new* requests, in-flight requests finish, then the process exits. Needed for zero-downtime deploys.
Rule: `LB detection time < drain time < orchestrator grace period`.

```ts
process.on("SIGTERM", () => {
  shuttingDown = true;                       // /health now returns 503
  setTimeout(() => server.close(), DRAIN_MS); // then stop accepting connections
});
```
Lab: [01-load-balancer](01-load-balancer/) (experiment 11)

### Consistency
Every read returns the most recent write. **Strong** consistency: always the latest. **Eventual** consistency:
replicas may disagree for a while, but converge if writes stop.
Labs: [00-basics](00-basics/), [05-database-replication](05-database-replication/)

### Database Replication
Keeping copies of the same database on several servers. Usually one **primary** takes writes and
**replicas** copy its changes and serve reads.

```ts
await primary.query("INSERT INTO orders ...");   // writes -> primary
const rows = await replica.query("SELECT ...");  // reads  -> replica (may lag slightly)
```
Lab: [05-database-replication](05-database-replication/)

### Database Sharding
Splitting one big dataset across several databases (shards), each holding a subset of rows.
A **shard key** decides where each row lives.

```ts
const shard = shards[hash(userId) % shards.length];
await shard.query("SELECT * FROM orders WHERE user_id = $1", [userId]);
```
Lab: [06-database-sharding](06-database-sharding/)

### Failover
Automatically switching to a standby component when the active one fails, e.g. promoting a replica to
primary when the primary database dies.
Lab: [05-database-replication](05-database-replication/)

### Fault Tolerance
The system keeps working (maybe degraded) when parts of it fail. Achieved with redundancy, retries,
timeouts, fallbacks. Example: the Node `cluster` primary forks a new worker when one crashes.
Lab: [00-basics](00-basics/) (`POST /chaos/crash`)

### Health Check
How a load balancer decides whether a server should get traffic. **Active:** the LB calls `GET /health` every few seconds. **Passive:** the LB counts real requests that fail (errors, timeouts, 5xx). Thresholds (e.g. 2 failures → DOWN, 2 successes → UP) prevent flapping.
Labs: [01-load-balancer](01-load-balancer/), [17-health-check](17-health-check/)

### Horizontal Scaling
Adding *more machines/processes* (scale out) instead of a bigger one. Needs a load balancer and
stateless services. Can scale almost without limit, but adds coordination problems.
Labs: [00-basics](00-basics/), [01-load-balancer](01-load-balancer/), [22-horizontal-scaling](22-horizontal-scaling/)

### Idempotency
Doing the same operation twice has the same effect as doing it once. Critical for payments:
a retried "charge $10" must not charge $20.

```ts
const key = req.header("Idempotency-Key");
const previous = await redis.get(`idem:${key}`);
if (previous) return res.json(JSON.parse(previous)); // replay, don't charge again
```
Lab: [20-idempotency](20-idempotency/)

### Latency
Time for one request to complete, usually in milliseconds. Report it as percentiles (p50, p95, p99),
not averages, because averages hide slow requests.
Lab: [00-basics](00-basics/) (`GET /api/latency`)

### Least Connections
Load-balancing algorithm: send each request to the server with the fewest requests in flight. Adapts to slow servers (in lab 01 it gave 3.7× the throughput of round robin with one slow server), but behaves like round robin when a burst arrives all at once.
Lab: [01-load-balancer](01-load-balancer/)

### Load Balancer
Sits in front of several servers and spreads incoming requests across them (round robin, least connections...).
Also removes unhealthy servers from rotation.
Lab: [01-load-balancer](01-load-balancer/)

### Message Queue
A buffer between a producer and a consumer. The API puts a job on the queue and responds immediately;
a worker processes it later. Smooths traffic spikes and isolates failures.

```ts
await channel.sendToQueue("orders", Buffer.from(JSON.stringify(order)));
res.status(202).json({ status: "accepted" }); // don't make the user wait for email sending
```
Lab: [08-message-queue](08-message-queue/)

### p50 / p95 / p99
Percentiles. p95 = 200ms means 95% of requests took 200ms or less, and 5% took longer.
p99 is the "tail": at 1M requests/day, 10,000 users get the p99 experience or worse.
Lab: [00-basics](00-basics/) (`GET /metrics`)

### Partition
Two meanings, so check the context:
1. **Network partition**: nodes can't talk to each other (see CAP).
2. **Data partition**: a slice of a dataset, e.g. a Kafka topic partition or a table partition.
Labs: [00-basics](00-basics/), [06-database-sharding](06-database-sharding/), [09-kafka](09-kafka/)

### Rate Limiting
Capping how many requests a client can make in a time window (e.g. 100/minute). Protects your
service from abuse and overload. Excess requests get HTTP `429 Too Many Requests`.
Lab: [07-rate-limiting](07-rate-limiting/)

### Reliability
The probability the system does the *right thing* over time. Availability asks "is it up?";
reliability asks "is it correct and dependable?" A server that is up but returns wrong data is available, not reliable.
Lab: [00-basics](00-basics/)

### Replication
Copying data to several nodes, for availability (one node dies, others still have the data) and read scaling.
See *Database Replication*.

### Reverse Proxy
A server that receives requests on behalf of backend servers and forwards them. Clients never talk to the backends directly. Load balancers, API gateways and CDNs are reverse proxies. (A *forward* proxy does the opposite: it acts on behalf of clients.)
Lab: [01-load-balancer](01-load-balancer/)

### Round Robin
The simplest load-balancing algorithm: servers take turns (1, 2, 3, 1, 2, 3...). Fair when servers and requests are identical, blind to a server that's slow.
Lab: [01-load-balancer](01-load-balancer/)

### Retry
Trying a failed operation again. Safe only with **timeouts**, **backoff + jitter**, a **retry limit**, and **idempotent** operations.
Unlimited retries can turn a small outage into a total one (retry storm).
Lab: [19-retry-timeout](19-retry-timeout/)

### RPS
Requests Per Second, the usual throughput unit for APIs. Related: QPS (queries per second) for databases.

### Scalability
The ability to handle more load by adding resources. A scalable system's cost grows roughly
linearly with load, and its latency stays acceptable.
Labs: [00-basics](00-basics/), [22-horizontal-scaling](22-horizontal-scaling/)

### Sticky Session (Session Affinity)
Routing the same client to the same server every time (by cookie, IP hash, or a user-ID hash), usually because the server keeps that user's state in memory. A workaround with costs: uneven load, and lost state when that server dies. Prefer stateless servers.
Labs: [01-load-balancer](01-load-balancer/) (experiment 9), [22-horizontal-scaling](22-horizontal-scaling/)

### Stateless
A service that keeps no per-user data in its own memory between requests. Any instance can serve any request,
which is what makes horizontal scaling easy. Sessions, carts and similar state go in Redis or a database instead.

```ts
// Stateful (bad for scaling): lost on restart, invisible to other instances
const sessions = new Map<string, Session>();
// Stateless: every instance reads the same store
const session = await redis.get(`session:${sid}`);
```
Lab: [22-horizontal-scaling](22-horizontal-scaling/)

### Throughput
How much work completes per unit of time (RPS, MB/s, messages/s).
**Little's Law**: `throughput = concurrency / latency`, so 100 in-flight requests at 0.1s each ≈ 1000 RPS.
Lab: [00-basics](00-basics/) (`GET /api/io`, `GET /api/cpu`)

### Vertical Scaling
Making one machine bigger (more CPU, RAM). Simple, no code changes, but it has a hard ceiling and the
machine is still a single point of failure. A single Node.js process uses only ~1 core for JavaScript,
so extra cores don't help it without `cluster` or more processes.
Lab: [00-basics](00-basics/)
