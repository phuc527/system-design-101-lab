# 03 — Redis

> Redis is not "just a cache". It's an in-memory **data structure server** — and choosing the right structure is most of the design.

---

## 1. What Redis is

- **In-memory** key-value store → sub-millisecond operations
- **Single-threaded command execution** → every command is atomic, no locks needed for a single command
- Rich **data types** (strings, hashes, lists, sets, sorted sets, streams, …)
- Optional **persistence** (RDB snapshots, AOF log)
- **Replication**, **Sentinel** (failover), **Cluster** (sharding)

Typical uses: cache, sessions, rate limiters, counters, leaderboards, queues, pub/sub, distributed locks, deduplication.

### Why is single-threaded fast?
No context switching, no lock contention, everything in RAM, efficient I/O multiplexing (epoll). One Redis instance handles ~100k+ ops/s. (Redis 6+ uses extra threads for network I/O; command execution stays single-threaded.)

**Consequence:** one slow command (`KEYS *`, `SMEMBERS` on a 10M-member set, a giant Lua script) blocks **every** client.

---

## 2. Data types and when to use them

### String
Binary-safe value up to 512 MB. Also integers.
```text
SET user:42:name "Alice" EX 3600
GET user:42:name
INCR page:home:views          # atomic counter
SET lock:order:9 abc NX PX 5000   # set only if not exists — basis of locks
```
Use: cache blobs (JSON), counters, flags, locks.

### Hash
A map inside a key — like a small object.
```text
HSET user:42 name Alice email a@x.com plan pro
HGET user:42 plan
HINCRBY user:42 logins 1
```
Use: objects where you read/update single fields; more memory-efficient than many string keys.

### List
Doubly linked list; push/pop from both ends.
```text
LPUSH queue:emails job1
BRPOP queue:emails 0          # blocking pop — simple work queue
LTRIM feed:42 0 99            # keep latest 100
```
Use: simple queues, recent-activity feeds.

### Set
Unordered unique members.
```text
SADD post:7:likes user:42
SISMEMBER post:7:likes user:42
SINTER user:1:friends user:2:friends   # mutual friends
```
Use: uniqueness, tags, membership, set math.

### Sorted set (ZSET)
Unique members each with a score; kept sorted. O(log n) insert.
```text
ZADD leaderboard 1500 alice 1200 bob
ZINCRBY leaderboard 50 bob
ZREVRANGE leaderboard 0 9 WITHSCORES   # top 10
ZRANGEBYSCORE events 1700000000 1700003600   # time-window queries
```
Use: leaderboards, priority queues, sliding-window rate limits, scheduling by timestamp.

### Others
| Type | Use |
|---|---|
| **Stream** | append-only log with consumer groups — lightweight Kafka-like queue |
| **Bitmap** | `SETBIT active:2026-10-04 42 1` — daily active users in 1 bit/user |
| **HyperLogLog** | approximate unique counts in 12 KB (`PFADD`, `PFCOUNT`) |
| **Geo** | `GEOADD`, `GEOSEARCH` — nearby drivers/stores |
| **Pub/Sub** | fire-and-forget broadcast (→ guide 11) |

### Choosing

| Need | Structure |
|---|---|
| cache a JSON blob | String |
| update one field of an object | Hash |
| FIFO queue | List (or Stream for ack/replay) |
| unique visitors exactly | Set |
| unique visitors approximately at scale | HyperLogLog |
| top-N / ranking | Sorted set |
| time-window counting | Sorted set or String + EXPIRE |

---

## 3. Atomicity tools

1. **Single commands** are atomic (`INCR`, `SET NX`, `ZADD`).
2. **MULTI / EXEC** — queue commands, run together (no rollback on error, no interleaving).
3. **WATCH** — optimistic locking: EXEC fails if a watched key changed.
4. **Lua scripts** (`EVAL`) — run logic atomically server-side. Best tool for read-modify-write.

```lua
-- fixed-window rate limiter: KEYS[1]=key, ARGV[1]=limit, ARGV[2]=window seconds
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if c > tonumber(ARGV[1]) then return 0 end
return 1
```

**Pipelining** ≠ atomic: it just batches commands to save round trips (100 commands in 1 RTT instead of 100).

---

## 4. Distributed lock

```text
acquire:  SET lock:resource <random-token> NX PX 10000
release:  if GET lock:resource == token then DEL   (must be atomic → Lua)
```

```ts
const token = crypto.randomUUID();
const ok = await redis.set("lock:invoice:9", token, "PX", 10_000, "NX");
if (!ok) throw new Error("busy");
try {
  await doWork();
} finally {
  await redis.eval(
    `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`,
    1, "lock:invoice:9", token,
  );
}
```

Why the random token? So you never delete **someone else's** lock after yours expired.

**Caveats:**
- If work outlives the TTL, two holders exist → renew (watchdog) or use **fencing tokens** (monotonic number the storage checks).
- Single-instance Redis lock fails on failover (replica may not have the key). **Redlock** uses a majority of N independent masters but is debated. For correctness-critical locking use etcd/ZooKeeper or DB row locks.

---

## 5. Persistence

| Mode | How | Trade-off |
|---|---|---|
| None | memory only | fastest; lose all on restart (fine for pure cache) |
| **RDB** | periodic snapshot (fork + write) | compact, fast restart; lose data since last snapshot |
| **AOF** | log every write; `appendfsync everysec` | lose ≤1 s; bigger files, rewrite needed |
| RDB + AOF | both | common production choice |

Redis as primary database? Possible, but RAM is expensive and durability is weaker than PostgreSQL. Usually Redis is a **derived** store.

---

## 6. High availability and scaling

### Replication
Primary → async replicas. Reads can go to replicas (may be stale). Async means acknowledged writes can be lost on failover.

### Sentinel
Monitors primary, votes, promotes a replica, tells clients the new address. HA without sharding.

### Cluster
16,384 **hash slots**, `slot = CRC16(key) % 16384`, slots spread across primaries, each with replicas.
- Multi-key ops only work if keys are in the same slot → use **hash tags**: `{user:42}:cart`, `{user:42}:profile`.
- Clients must be cluster-aware (follow `MOVED`/`ASK` redirects).

```text
slots 0–5460  → A (+replica A')
slots 5461–10922 → B (+replica B')
slots 10923–16383 → C (+replica C')
```

---

## 7. Memory management

- Set `maxmemory` and a `maxmemory-policy` (`allkeys-lru` for caches, `noeviction` for data you can't lose — writes error when full)
- Always TTL cache keys
- Watch **big keys** (`redis-cli --bigkeys`) and **hot keys** (`--hotkeys` with LFU)
- Use `SCAN` not `KEYS` in production; `UNLINK` instead of `DEL` for big keys (async free)

---

## 8. Node.js client (ioredis)

```ts
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 2,
  enableOfflineQueue: false,      // fail fast instead of buffering forever
  connectTimeout: 2000,
});

redis.on("error", (err) => logger.warn({ err }, "redis error"));

// pipeline: one round trip
const [[, views], [, likes]] = (await redis
  .pipeline()
  .incr("post:7:views")
  .scard("post:7:likes")
  .exec())!;
```

Rules: reuse one client (connections are expensive), set timeouts, and decide what the app does when Redis is down (fail open for cache, fail closed for locks/limits?).

---

## 9. Common mistakes

| Mistake | Consequence |
|---|---|
| `KEYS *` in prod | blocks Redis for seconds |
| no TTL on cache keys | memory fills, evictions of important data |
| huge values / collections | latency spikes, slow replication |
| using Pub/Sub as a durable queue | messages lost when no subscriber online |
| lock without token / TTL | deadlock or deleting others' locks |
| treating replica reads as fresh | stale reads after writes |
| one connection per request | connection storm |

---

## 10. Interview questions

1. **Why is Redis fast despite being single-threaded?** — RAM, no locks/context switches, I/O multiplexing; simple O(1)/O(log n) ops.
2. **Pick a structure for a leaderboard.** — Sorted set: `ZINCRBY`, `ZREVRANGE`.
3. **How do you implement a distributed lock?** — `SET NX PX` with random token, Lua compare-and-delete; mention TTL expiry and fencing.
4. **RDB vs AOF?** — Snapshots vs write log; trade restart speed and size vs data loss window.
5. **How does Redis Cluster shard?** — 16,384 hash slots via CRC16; hash tags for co-location.
6. **Can you lose data with Redis replication?** — Yes, replication is async; acknowledged writes can be lost on failover (`WAIT` reduces it).
7. **How do you count unique visitors for 1 billion events cheaply?** — HyperLogLog (~0.81% error, 12 KB).

**Prev:** [02 — Caching](02-caching.md) · **Next:** [04 — Database Index](04-database-index.md)
