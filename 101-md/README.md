# System Design 101 — Concept Guides

One deep-dive markdown file per topic. Each guide is **theory-first** and pairs with the hands-on lab of the same number.

| # | Guide | One-line summary | Lab |
|---|---|---|---|
| 00 | [Basics](00-basics.md) | latency, throughput, availability, scaling, CAP — the vocabulary | [00-basics](../00-basics/) |
| 01 | [Load Balancer](01-load-balancer.md) | spread traffic over N servers, survive one dying | [01-load-balancer](../01-load-balancer/) |
| 02 | [Caching](02-caching.md) | keep hot data close; the hard part is invalidation | 02-caching |
| 03 | [Redis](03-redis.md) | in-memory data structure server: cache, counters, locks, queues | 03-redis |
| 04 | [Database Index](04-database-index.md) | B-trees turn O(n) scans into O(log n) lookups | 04-database-index |
| 05 | [Database Replication](05-database-replication.md) | copies of data for read scale and failover | 05-database-replication |
| 06 | [Database Sharding](06-database-sharding.md) | split data across machines when one can't hold it | 06-database-sharding |
| 07 | [Rate Limiting](07-rate-limiting.md) | protect services from too many requests | 07-rate-limiting |
| 08 | [Message Queue](08-message-queue.md) | decouple producers and consumers in time | 08-message-queue |
| 09 | [Kafka](09-kafka.md) | a distributed, replayable, partitioned log | 09-kafka |
| 10 | [WebSocket](10-websocket.md) | full-duplex, long-lived connections for realtime | 10-websocket |
| 11 | [Pub/Sub](11-pub-sub.md) | broadcast events to every interested subscriber | 11-pub-sub |
| 12 | [Search](12-search.md) | inverted indexes, relevance, autocomplete | 12-search |
| 13 | [CDN](13-cdn.md) | cache content at the edge, near users | 13-cdn |
| 14 | [Object Storage](14-object-storage.md) | S3-style blobs, presigned URLs, multipart upload | 14-object-storage |
| 15 | [API Gateway](15-api-gateway.md) | one front door: routing, auth, limits | 15-api-gateway |
| 16 | [Service Discovery](16-service-discovery.md) | how services find each other's addresses | 16-service-discovery |
| 17 | [Health Check](17-health-check.md) | liveness vs readiness vs deep health | 17-health-check |
| 18 | [Circuit Breaker](18-circuit-breaker.md) | stop calling a dependency that is failing | 18-circuit-breaker |
| 19 | [Retry & Timeout](19-retry-timeout.md) | bounded waits, backoff, jitter, retry budgets | 19-retry-timeout |
| 20 | [Idempotency](20-idempotency.md) | safe retries: same request, same effect | 20-idempotency |
| 21 | [Observability](21-observability.md) | logs, metrics, traces — RED and USE | 21-observability |
| 22 | [Horizontal Scaling](22-horizontal-scaling.md) | stateless services + shared state = add boxes | 22-horizontal-scaling |
| 23 | [Microservices](23-microservices.md) | when and how to split a monolith | 23-microservices |
| 24 | [Final Project](24-final-project.md) | an e-commerce backend that uses everything | 24-final-project |

## How each guide is organised

1. **The problem** — what breaks without this concept
2. **How it works** — mechanics, with diagrams
3. **Variants / algorithms** — the options and when to choose each
4. **Node.js + TypeScript sketch** — minimal code to make it concrete
5. **Failure modes** — what goes wrong in production
6. **Trade-offs** — what you give up
7. **Production checklist**
8. **Interview questions** — with short model answers

Suggested reading order follows [ROADMAP.md](../ROADMAP.md):

```text
00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 22 → 08 → 09 → 10 → 11
   → 17 → 18 → 19 → 20 → 21 → 12 → 13 → 14 → 15 → 16 → 23 → 24
```
