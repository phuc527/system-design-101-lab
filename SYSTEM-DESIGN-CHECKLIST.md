# System Design Checklist

Use this when designing any system, at work or in an interview. You won't need every item every time, but you should *consciously* skip the ones you skip.

**Interview flow (45–60 min):** requirements (5–10) → estimates (5) → high-level design (10–15) → deep dives (15–20) → failures & trade-offs (5–10).

---

## Requirements

- What are the **functional requirements**? (What can users *do*? List 3–5 core features. Explicitly cut the rest.)
- What are the **non-functional requirements**?
  - Latency target? (e.g. p99 < 200ms for reads)
  - Availability target? (99.9% = 8h 45m/year downtime. 99.99% = 52m/year)
  - Consistency needs? (Is stale data OK? For how long?)
  - Durability? (Can we *ever* lose data?)
- Who are the users? Internal / public / mobile / global?
- What's explicitly **out of scope**?

## Scale

- How many users? DAU / MAU? Peak concurrent?
- **Requests per second?** Average and peak (peak ≈ 2–10× average).
  - `RPS ≈ DAU × actions per user per day / 86,400`
- **Data size?** Per record × records per day × retention.
- **Read/write ratio?** (100:1 → cache + replicas. 1:1 → write path matters.)
- Growth: what does 10× look like?
- Bandwidth: `RPS × average response size`.

> Quick numbers: 1M requests/day ≈ 12 RPS average. 100M/day ≈ 1,200 RPS. A day has ~86,400 seconds (round to 100k).

## Architecture

- **Monolith** or **microservices**? (Default to a modular monolith unless team size or scaling needs say otherwise.)
- **API Gateway?** (auth, routing, rate limiting at the edge)
- **Load balancer?** Algorithm? Health checks?
- Are services **stateless**? Where does state live?
- Sync (HTTP/gRPC) or async (queue/events) between components?
- Draw it: client → edge → services → data stores → async workers.

## Data

- **SQL** (relations, transactions, constraints) or **NoSQL** (scale, flexible schema, specific access patterns)?
- Data model: main entities and their relationships. What are the **access patterns**?
- **Indexes** for every frequent query?
- **Cache?** What, where (client / CDN / Redis / in-process), TTL, invalidation strategy?
- **Replication?** Read replicas? Sync or async? Acceptable replication lag?
- **Sharding?** Shard key? Hot keys? How to reshard?
- Blob/object storage for files (S3/MinIO), not the database.
- Search index (OpenSearch) if full-text search is needed.

## Performance

- **Cache?** Hit rate target? What happens on a cold cache or stampede?
- **CDN?** For static assets and cacheable API responses.
- **Async processing?** Can slow work (emails, image processing, reports) go to a queue?
- Parallelize independent calls (`Promise.all`)?
- Pagination, compression, payload size?
- Where's the bottleneck? (CPU, memory, DB connections, network, a third-party API)
- Connection pooling to databases?

## Reliability

- **Single points of failure?** Name each one, and how it's removed.
- **Redundancy:** ≥2 instances, multiple availability zones?
- **Retry?** With limits, exponential backoff, jitter? Only for idempotent operations?
- **Timeout?** On *every* network call, with an overall request deadline?
- **Circuit breaker?** For each external dependency?
- **Failover?** For the database? Automatic or manual? RTO / RPO?
- **Idempotency?** For payments and other non-repeatable writes?
- **Graceful degradation:** what still works when X is down?
- **Rate limiting / backpressure** to protect against overload?
- Backups, and have you *tested* restoring them?

## Consistency

- **Strong** or **eventual** consistency, per feature?
- During a partition: **CP** (refuse) or **AP** (serve stale)? (CAP)
- How are conflicts resolved? (LWW loses data. Consider CRDTs or merge logic.)
- Transactions across services? (Saga / outbox pattern instead of distributed transactions.)
- Read-your-own-writes needed? (Route to primary after a write, or use session stickiness.)

## Observability

- **Logs:** structured (JSON), with request ID / correlation ID?
- **Metrics:** RED (Rate, Errors, Duration) per endpoint; USE (Utilization, Saturation, Errors) per resource; event-loop delay for Node?
- **Tracing:** can you follow one request across services?
- **Dashboards & alerts:** on SLO burn rate, p99 latency, error rate, not on every spike.
- Health endpoints: liveness vs readiness?

## Security

- **Authentication?** (sessions, JWT, OAuth/OIDC)
- **Authorization?** (roles, ownership checks: can user A read user B's order?)
- **Rate limiting** per user / IP / API key?
- Input validation and size limits on every endpoint?
- Secrets management (not in code or images)?
- TLS everywhere? Encryption at rest for sensitive data?
- Least privilege for service accounts and database users?
- Audit logging for sensitive actions?

## Cost & operations

- Rough monthly cost of the main components?
- How is it deployed? (Docker, Kubernetes, serverless) Rolling / blue-green / canary?
- How does it scale automatically? On which metric?
- Who gets paged, and for what?

---

## Final sanity questions

1. What's the **first thing that breaks** at 10× load?
2. What happens when **each component** fails?
3. Which **trade-offs** did you make, and what would make you choose differently?
4. What's the **simplest version** that meets the requirements, and did you start there?
