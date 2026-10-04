# 06 — Database Sharding

> When one machine can't hold the data or absorb the writes, split the data across machines. It's powerful — and the last resort.

---

## 1. The problem

You've added indexes, caching, read replicas, and a bigger primary. Still:
- **Writes** exceed what one primary can handle (replicas don't help writes)
- **Data size** exceeds one machine's disk / working set exceeds RAM
- **Maintenance** (vacuum, backups, index builds) on a 20 TB table takes days

**Sharding** (horizontal partitioning) splits rows across multiple independent databases (shards). Each shard holds a subset of rows and handles its share of reads and writes.

```text
                 ┌──▶ shard 0: users 0..999,999
app ─▶ router ───┼──▶ shard 1: users 1M..1,999,999
                 └──▶ shard 2: users 2M..2,999,999
```

### Partitioning vocabulary

| Term | Meaning |
|---|---|
| Vertical partitioning | split **columns** / tables (e.g. move `user_photos` to another DB) |
| Horizontal partitioning | split **rows** by a key |
| Sharding | horizontal partitioning across **separate servers** |
| Table partitioning | horizontal split **inside one server** (PG `PARTITION BY`) — not sharding |

---

## 2. The shard key — the most important decision

Every row is assigned to a shard by its **shard key**. A good key:

1. **High cardinality** — many distinct values (not `country`, not `status`)
2. **Even distribution** — no value carries a huge share of traffic
3. **Matches query patterns** — most queries include the key, so they hit **one** shard
4. **Stable** — rarely changes (changing it means moving the row)

| Key | Verdict |
|---|---|
| `user_id` for a social app | ✅ most queries are per-user |
| `tenant_id` for B2B SaaS | ✅ but big tenants can be hot |
| `created_at` | ❌ all new writes go to the latest shard (hot) |
| `country` | ❌ low cardinality, skewed |
| `order_id` when queries are by customer | ⚠ every "my orders" query fans out |

---

## 3. Sharding strategies

### Range-based
`user_id 0–1M → shard 0, 1M–2M → shard 1 …`
✅ range queries efficient, easy to understand
❌ hotspots (sequential IDs → newest shard takes all writes)

### Hash-based
`shard = hash(user_id) % N`
✅ even distribution
❌ range queries scatter; **changing N remaps almost every key**

```text
N=4: hash=10 → shard 2      N=5: hash=10 → shard 0   ← moved!
~80% of keys move when going 4 → 5 shards
```

### Consistent hashing
Place shards and keys on a hash ring; a key belongs to the next shard clockwise.

```text
                 0 / 2³²
              ┌──── S0 ────┐
           k5 ·            · k1      k1 → S1 (next clockwise)
            S3              S1       k3 → S2
           k4 ·            · k2      k5 → S0
              └──── S2 ────┘
                   k3
```
- Adding a shard only moves keys between it and its predecessor: ~**1/N** of keys
- **Virtual nodes** (each shard appears 100–200 times on the ring) smooth the distribution
- Used by Cassandra, DynamoDB, Riak, many caches

### Directory-based (lookup table)
A lookup service maps key → shard.
✅ total flexibility (move one big tenant to its own shard)
❌ extra lookup, the directory must be HA and cached

### Geo-based
EU users → EU shard. Good for latency and data residency (GDPR).

| Strategy | Distribution | Range queries | Resharding |
|---|---|---|---|
| Range | can be skewed | ✅ | split ranges |
| Hash mod N | even | ❌ | painful |
| Consistent hash | even (vnodes) | ❌ | ~1/N moves |
| Directory | controllable | depends | flexible |

---

## 4. Node.js sketch — consistent hash router

```ts
import { createHash } from "node:crypto";

function h(s: string): number {
  return createHash("md5").update(s).digest().readUInt32BE(0);
}

class HashRing {
  private ring: { point: number; shard: string }[] = [];

  constructor(shards: string[], private vnodes = 150) {
    shards.forEach((s) => this.add(s));
  }

  add(shard: string) {
    for (let i = 0; i < this.vnodes; i++) this.ring.push({ point: h(`${shard}#${i}`), shard });
    this.ring.sort((a, b) => a.point - b.point);
  }

  remove(shard: string) {
    this.ring = this.ring.filter((n) => n.shard !== shard);
  }

  get(key: string): string {
    const p = h(key);
    let lo = 0, hi = this.ring.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; this.ring[mid].point < p ? (lo = mid + 1) : (hi = mid); }
    return this.ring[lo % this.ring.length].shard;
  }
}

const ring = new HashRing(["db0", "db1", "db2"]);
const pool = pools[ring.get(`user:${userId}`)];
await pool.query("SELECT * FROM orders WHERE user_id = $1", [userId]);
```

---

## 5. Problems sharding creates

### Cross-shard queries
`SELECT COUNT(*) FROM orders WHERE status='paid'` must hit **every** shard and merge (scatter-gather). Slow, and latency = slowest shard.
Mitigate: denormalise, maintain aggregates elsewhere (analytics warehouse), design keys so hot queries are single-shard.

### Cross-shard joins
Can't JOIN across servers. Options: co-locate related data by the same key (user + their orders on same shard), duplicate small reference tables to all shards, join in the app.

### Cross-shard transactions
ACID across shards needs **2-phase commit** (slow, blocking) or **sagas** (sequence of local transactions with compensations). Best: design so transactions stay inside one shard.

### Global uniqueness / IDs
Auto-increment per shard collides. Use:
- **UUID v7** (time-ordered) or ULID
- **Snowflake IDs**: `timestamp | machine id | sequence` → 64-bit, sortable
- Embed shard ID in the key

### Hot partitions (celebrity problem)
One key (Taylor Swift's account, a giant tenant) overloads one shard.
Mitigate: split that key (`key#0..#9` with fan-in on read), dedicated shard for whales, caching in front.

### Resharding
Growing from 4 to 8 shards means moving data **while serving traffic**:
1. Dual-write to old and new locations (or CDC stream)
2. Backfill historical data
3. Verify
4. Switch reads
5. Stop old writes, clean up

Pre-split into many **logical shards** (e.g. 1024) mapped onto few physical servers — then resharding is moving logical shards, not rehashing rows.

### Operational overhead
N databases to back up, monitor, migrate, upgrade. Schema migrations must run on every shard.

---

## 6. Before you shard — alternatives

1. Query optimisation + indexes (guide 04)
2. Caching (guide 02)
3. Read replicas (guide 05)
4. Vertical scaling — a big modern DB server handles a lot
5. Table partitioning inside one server (archival, drop old partitions)
6. Move data out: blobs to object storage, logs/analytics to warehouse
7. Split by function (separate DB per service — guide 23)

Or use a database that shards for you: **Citus** (PostgreSQL), **Vitess** (MySQL), **CockroachDB/YugabyteDB/Spanner** (distributed SQL), **MongoDB**, **Cassandra**, **DynamoDB**.

---

## 7. Trade-offs

| Gain | Cost |
|---|---|
| write and storage scaling | cross-shard queries/joins/transactions hard |
| smaller indexes per shard, faster maintenance | complex routing and resharding |
| failure isolation (one shard down ≠ all down) | operational overhead × N |

---

## 8. Production checklist

- [ ] Shard key chosen from real query patterns
- [ ] Hot queries are single-shard
- [ ] Globally unique ID strategy
- [ ] Many logical shards → few physical (room to grow)
- [ ] Per-shard monitoring (size, QPS, latency) to spot hotspots
- [ ] Resharding procedure documented and rehearsed
- [ ] Each shard replicated (sharding ≠ HA)

---

## 9. Interview questions

1. **Sharding vs replication?** — Sharding splits data (scales writes/storage); replication copies data (scales reads/HA). Usually both.
2. **How do you choose a shard key?** — High cardinality, even distribution, present in most queries, immutable.
3. **Why consistent hashing?** — Adding/removing nodes moves ~1/N keys instead of nearly all.
4. **How do you handle a celebrity/hot key?** — Split key with suffixes, dedicated shard, caching.
5. **How do you run a transaction across shards?** — Avoid; else 2PC or saga with compensations.
6. **How do you generate IDs?** — Snowflake/UUIDv7/ULID.
7. **When should you NOT shard?** — Before exhausting indexes, cache, replicas, vertical scale; when the team can't afford the operational cost.

**Prev:** [05 — Database Replication](05-database-replication.md) · **Next:** [07 — Rate Limiting](07-rate-limiting.md)
