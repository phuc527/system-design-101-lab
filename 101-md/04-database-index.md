# 04 — Database Index

> Before adding a cache, a replica, or a shard — check your indexes. A missing index is the most common cause of a slow backend.

---

## 1. The problem

```sql
SELECT * FROM orders WHERE customer_id = 42;
```

Table has 50 M rows, no index → the DB reads **every row** (sequential scan) to find ~20. That's O(n): 50 M row reads to return 20.

An **index** is a separate data structure that maps column values → row locations, so the DB can jump straight to matching rows: O(log n).

Analogy: the index at the back of a book. Without it, you read every page to find "replication".

---

## 2. B-tree (B+tree) — the default index

```text
                    [ 40 | 80 ]
                 /       |       \
        [10|20|30]   [50|60|70]   [90|100]
         ↓  ↓  ↓       ↓  ↓  ↓      ↓   ↓
        leaf pages (sorted, linked) → pointers to rows (heap TIDs)
```

Properties:
- **Balanced** — every leaf at same depth. 50 M rows ≈ 3–4 levels → ~4 page reads.
- **Sorted** — supports `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, prefix `LIKE 'abc%'`.
- Leaves are linked → efficient range scans.
- High fan-out (hundreds of keys per 8 KB page) keeps the tree shallow.

### Other index types (PostgreSQL)

| Type | Good for |
|---|---|
| **B-tree** | equality, ranges, sorting — default |
| **Hash** | equality only |
| **GIN** | arrays, JSONB, full-text (`tsvector`) — "contains" queries |
| **GiST / SP-GiST** | geometry, ranges, nearest neighbour |
| **BRIN** | huge, naturally ordered tables (time-series) — tiny index |

---

## 3. Composite (multi-column) indexes

```sql
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at);
```

Sorted by `customer_id`, then by `created_at` within each customer — like a phone book sorted by (last name, first name).

**Leftmost-prefix rule:**

| Query | Uses index? |
|---|---|
| `WHERE customer_id = 42` | ✅ |
| `WHERE customer_id = 42 AND created_at > '2026-01-01'` | ✅ (best) |
| `WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 10` | ✅ no sort needed |
| `WHERE created_at > '2026-01-01'` | ❌ (skips first column) |

**Column order rule of thumb:** equality columns first, then range/sort column. Among equality columns, put the most selective first (though equality order matters less).

---

## 4. Covering indexes and index-only scans

If the index contains **all columns the query needs**, the DB doesn't visit the table at all.

```sql
CREATE INDEX idx_orders_cover ON orders (customer_id, created_at) INCLUDE (total, status);

SELECT created_at, total, status FROM orders WHERE customer_id = 42;  -- Index Only Scan
```

---

## 5. Selectivity and cardinality

- **Cardinality** — number of distinct values. `email` high, `is_active` low.
- **Selectivity** — fraction of rows a predicate returns. Low fraction = selective = good index candidate.

An index on `status` where 95% of rows are `'done'` is useless for `status = 'done'` — the planner will seq-scan anyway (reading the index + random heap reads is slower than one sequential pass).

**Partial index** solves that:
```sql
CREATE INDEX idx_orders_pending ON orders (created_at) WHERE status = 'pending';
```
Small, fast, only covers the rows you query.

---

## 6. Reading EXPLAIN ANALYZE

```sql
EXPLAIN (ANALYZE, BUFFERS) SELECT * FROM orders WHERE customer_id = 42;
```

Before:
```text
Seq Scan on orders  (cost=0.00..980000.00 rows=21 width=64) (actual time=0.03..2400.1 rows=20 loops=1)
  Filter: (customer_id = 42)
  Rows Removed by Filter: 49999980
Execution Time: 2400.4 ms
```

After `CREATE INDEX ON orders (customer_id)`:
```text
Index Scan using orders_customer_id_idx on orders (cost=0.56..85.3 rows=21) (actual time=0.04..0.09 rows=20 loops=1)
  Index Cond: (customer_id = 42)
Execution Time: 0.12 ms
```

What to look for:

| Node | Meaning |
|---|---|
| Seq Scan | reads whole table — fine for small tables or most-rows queries |
| Index Scan | walks index, fetches rows |
| Index Only Scan | index alone suffices |
| Bitmap Heap Scan | collects many matches then reads pages in order |
| Nested Loop / Hash Join / Merge Join | join strategies |
| Sort (external merge) | sort spilled to disk → index or more `work_mem` |
| `rows` estimate ≫ / ≪ actual | stale statistics → `ANALYZE` |

---

## 7. When indexes are NOT used

```sql
WHERE LOWER(email) = 'a@x.com'        -- function on column → create expression index ON (LOWER(email))
WHERE created_at::date = '2026-10-04' -- cast → use a range instead
WHERE name LIKE '%son'                -- leading wildcard → trigram (pg_trgm) GIN index
WHERE customer_id = '42'              -- type mismatch can block index
WHERE a = 1 OR b = 2                  -- may need two indexes + BitmapOr
```

Also: tiny tables, low selectivity, outdated statistics.

---

## 8. The cost of indexes

Indexes are not free:

- **Writes slower** — every INSERT/UPDATE/DELETE updates every index on the table
- **Disk + memory** — indexes compete for the buffer cache
- **Bloat** — need `VACUUM` / `REINDEX`
- **Planner confusion** — too many similar indexes

Rule: index for your **actual query patterns**; remove unused ones (`pg_stat_user_indexes.idx_scan = 0`).

**Creating indexes on a live big table:** `CREATE INDEX CONCURRENTLY` (PostgreSQL) — doesn't block writes.

---

## 9. N+1 query problem (related)

```ts
const orders = await db.query("SELECT * FROM orders LIMIT 50");
for (const o of orders) {
  o.customer = await db.query("SELECT * FROM customers WHERE id = $1", [o.customer_id]); // 50 queries!
}
```

Fix: a JOIN or `WHERE id = ANY($1)` batch — 2 queries instead of 51. Indexes make each query fast; fixing N+1 removes queries entirely.

---

## 10. Pagination and indexes

```sql
-- OFFSET: DB still walks 100,000 rows to skip them
SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100000;

-- Keyset / cursor: uses index, constant time
SELECT * FROM orders WHERE id > $last_seen_id ORDER BY id LIMIT 20;
```

---

## 11. Node.js sketch — measuring the difference

```ts
import { Pool } from "pg";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function timed(sql: string, params: unknown[] = []) {
  const t = performance.now();
  await pool.query(sql, params);
  return (performance.now() - t).toFixed(1) + " ms";
}

console.log("before:", await timed("SELECT * FROM orders WHERE customer_id = $1", [42]));
await pool.query("CREATE INDEX IF NOT EXISTS idx_c ON orders (customer_id)");
await pool.query("ANALYZE orders");
console.log("after: ", await timed("SELECT * FROM orders WHERE customer_id = $1", [42]));
```

---

## 12. Production checklist

- [ ] Every foreign key used in joins/filters is indexed
- [ ] Composite indexes match WHERE + ORDER BY of hot queries
- [ ] `pg_stat_statements` reviewed for top slow/frequent queries
- [ ] Unused indexes dropped
- [ ] Big index changes via `CONCURRENTLY`
- [ ] Keyset pagination for deep pages
- [ ] Autovacuum/analyze healthy

---

## 13. Interview questions

1. **How does a B-tree index speed up queries?** — Balanced sorted tree, O(log n) lookup, few page reads, supports ranges.
2. **Why might the DB ignore your index?** — Low selectivity, function/cast on column, leading wildcard, stale stats, tiny table.
3. **Explain the leftmost-prefix rule.** — Composite (a,b) serves queries on a or a+b, not b alone.
4. **What is a covering index?** — Contains all needed columns → index-only scan, no heap access.
5. **Downsides of adding indexes?** — Slower writes, storage, maintenance.
6. **OFFSET vs cursor pagination?** — OFFSET scans and discards rows; cursor seeks via index.
7. **A query is slow — what do you do?** — `EXPLAIN ANALYZE`, check scan type and estimate accuracy, add/adjust index, rewrite query, then consider caching.

**Prev:** [03 — Redis](03-redis.md) · **Next:** [05 — Database Replication](05-database-replication.md)
