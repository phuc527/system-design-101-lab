# 05 — Database Replication

> Keep copies of the same data on multiple machines — for read scaling, high availability, and disaster recovery.

---

## 1. The problem

One database server:
- **SPOF** — it dies, the app dies
- **Read ceiling** — 90% of traffic is reads, all on one box
- **Disaster** — disk corruption or region outage = data loss

**Replication** keeps synchronized copies (replicas) of the data on other nodes.

---

## 2. Topologies

### Single-leader (primary / replica) — most common

```text
          writes + reads
 app ───────────────────▶ PRIMARY ──WAL stream──▶ REPLICA 1  (reads)
   └──────────── reads ───────────────────────▶ REPLICA 2  (reads)
```

- All writes go to the primary
- Primary streams its change log (PostgreSQL WAL, MySQL binlog) to replicas
- Replicas apply changes and serve reads

PostgreSQL streaming replication, MySQL, MongoDB replica sets, Redis.

### Multi-leader

Several nodes accept writes (e.g. one per region) and replicate to each other.
✅ local write latency per region, survives region loss
❌ **write conflicts** (two regions edit the same row) → need conflict resolution (last-write-wins, CRDTs, app logic)

### Leaderless (Dynamo-style)

Client writes to N replicas, succeeds when W acknowledge; reads from R replicas.
- **Quorum:** `W + R > N` ⇒ read and write sets overlap ⇒ you see the latest write (mostly)
- e.g. N=3, W=2, R=2
- Cassandra, DynamoDB, Riak. Repair via read-repair and anti-entropy (Merkle trees).

---

## 3. Synchronous vs asynchronous

| | Synchronous | Asynchronous | Semi-sync |
|---|---|---|---|
| Primary waits for | replica ack before commit returns | nothing | at least 1 replica |
| Durability | no loss on primary failure | can lose recent commits | ≤ small loss |
| Write latency | + replica RTT | lowest | moderate |
| Availability | replica down ⇒ writes block | unaffected | one replica may be down |

PostgreSQL: `synchronous_commit` + `synchronous_standby_names = 'ANY 1 (r1, r2)'`.

Most systems run **async** (or semi-sync) for performance and accept a small data-loss window (RPO).

---

## 4. Replication lag and its anomalies

Async replicas are **behind** by milliseconds — or minutes under load. This causes visible bugs:

### Read-your-own-writes violation
```text
user updates profile → write to primary ✔
page reloads → read from replica (not caught up) → old profile ✗  "my change disappeared!"
```
Fixes:
- read from primary for N seconds after the user writes
- read from primary for data the user owns
- track the write's LSN; read from a replica only if it has replayed past it

### Monotonic reads violation
Refresh 1 hits a fresh replica, refresh 2 hits a lagging one → data goes back in time.
Fix: pin a user to one replica (hash user ID).

### Consistent prefix violation
You see an answer before the question (in partitioned systems). Fix: causally related writes to same partition.

---

## 5. Read/write splitting in the app

```ts
import { Pool } from "pg";

const primary = new Pool({ connectionString: process.env.PRIMARY_URL });
const replicas = [new Pool({ connectionString: process.env.REPLICA1_URL }),
                  new Pool({ connectionString: process.env.REPLICA2_URL })];
let rr = 0;

export const db = {
  write: (sql: string, p?: unknown[]) => primary.query(sql, p),
  read:  (sql: string, p?: unknown[]) => replicas[rr++ % replicas.length].query(sql, p),
  readFresh: (sql: string, p?: unknown[]) => primary.query(sql, p), // read-your-writes
};
```

Alternatives: a proxy (PgBouncer + Pgpool-II, ProxySQL for MySQL), ORM read-replica support (Prisma `readReplicas`, TypeORM `replication`).

Measure lag:
```sql
-- on primary
SELECT client_addr, state, replay_lag FROM pg_stat_replication;
-- on replica
SELECT now() - pg_last_xact_replay_timestamp() AS lag;
```

---

## 6. Failover

When the primary dies, promote a replica.

```text
1. detect failure (health checks, consensus — avoid false positives)
2. choose most up-to-date replica
3. promote it (pg_ctl promote / pg_promote())
4. redirect clients (VIP, DNS, proxy, service discovery)
5. old primary, when back, must rejoin as replica (pg_rewind)
```

Tools: Patroni (+ etcd), repmgr, cloud-managed (RDS Multi-AZ, Cloud SQL HA).

### Dangers

| Danger | What happens | Mitigation |
|---|---|---|
| **Split brain** | old primary comes back, two primaries accept writes | fencing / STONITH, consensus (etcd), leases |
| **Data loss** | async writes never reached new primary | sync/semi-sync replication |
| **False failover** | network blip triggers promotion | sensible timeouts, quorum-based detection |
| **Cascading load** | promoted replica also serving reads → overloaded | capacity headroom |

### RPO and RTO
- **RPO** (Recovery Point Objective) — how much data can you lose? (async: seconds; sync: 0)
- **RTO** (Recovery Time Objective) — how long until service is back? (auto failover: ~30 s; manual: minutes–hours)

---

## 7. Replication ≠ backup

Replication copies **mistakes** instantly: `DELETE FROM users;` is replicated to every replica in milliseconds.

You still need:
- regular backups (pg_dump / base backups)
- **point-in-time recovery** (WAL archiving)
- optionally a **delayed replica** (`recovery_min_apply_delay = '1h'`)
- tested restores (an untested backup is not a backup)

---

## 8. Physical vs logical replication

| | Physical (streaming) | Logical |
|---|---|---|
| Copies | byte-level WAL / disk blocks | row changes (INSERT/UPDATE/DELETE) |
| Replica | exact clone, read-only | can be different version/schema, writable |
| Scope | whole cluster | selected tables |
| Use | HA, read scaling | migrations, upgrades, CDC to Kafka (Debezium) |

---

## 9. Trade-offs

- **Consistency vs latency** — sync is safe but slower
- **Read scaling vs staleness** — more replicas, more lag anomalies
- **Availability vs split-brain risk** — faster auto-failover, more false positives
- Replicas scale **reads only**. Write bottleneck → sharding (guide 06).

---

## 10. Production checklist

- [ ] At least one replica in a different zone
- [ ] Replication lag monitored and alerted
- [ ] Read-your-writes strategy for user-facing flows
- [ ] Automated, tested failover with fencing
- [ ] Clients reconnect to new primary automatically
- [ ] Backups + PITR, restore tested regularly
- [ ] RPO/RTO documented and agreed

---

## 11. Interview questions

1. **Why replicate?** — Read scaling, HA, geographic latency, DR.
2. **Sync vs async replication?** — Durability vs write latency/availability.
3. **User updates profile but sees old data — why, and fix?** — Replication lag; read-your-writes via primary reads or LSN tracking.
4. **What is split brain?** — Two nodes think they're primary; prevent with fencing and consensus.
5. **Explain W + R > N.** — Overlapping quorums guarantee a read sees at least one up-to-date replica.
6. **Is a replica a backup?** — No; it replicates deletes and corruption.
7. **Replication solved reads, writes still slow?** — Optimise/batch writes, vertical scale primary, then shard.

**Prev:** [04 — Database Index](04-database-index.md) · **Next:** [06 — Database Sharding](06-database-sharding.md)
