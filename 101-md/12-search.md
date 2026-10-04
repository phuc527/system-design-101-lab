# 12 — Search

> `WHERE name LIKE '%phone%'` scans every row and can't rank results. Search engines flip the problem: instead of documents → words, they store words → documents.

---

## 1. The problem

Users type "wireless noise cancelling headphones" and expect:
- **fast** results over millions of products
- matches for "headphone" (singular), "Headphones", "noise-cancelling"
- **typo tolerance** ("hedphones")
- **ranking** — best match first, not newest
- **filters & facets** — brand, price range, counts per category
- **autocomplete** as they type

A relational `LIKE '%…%'` does a full scan, has no relevance, no stemming, no typo tolerance.

---

## 2. The inverted index

Forward index (what a DB table is): document → words.
**Inverted index**: word (term) → list of documents containing it (**posting list**).

```text
doc1: "Wireless headphones with noise cancelling"
doc2: "Wired headphones"
doc3: "Wireless mouse"

term          postings
wireless   →  [doc1, doc3]
headphone  →  [doc1, doc2]
noise      →  [doc1]
cancel     →  [doc1]
wire       →  [doc2]
mouse      →  [doc3]
```

Query `wireless headphones` → intersect `[1,3] ∩ [1,2]` = `[doc1]` (AND) or union (OR, then rank).

Posting lists also store **term frequency** and **positions** (for phrase queries "noise cancelling" and highlighting).

---

## 3. Text analysis pipeline

The same pipeline runs on documents at index time and on queries at search time.

```text
"The Wireless Headphones, Noise-Cancelling!"
  │ character filters  (strip HTML, normalise unicode)
  │ tokenizer          → [The, Wireless, Headphones, Noise, Cancelling]
  │ lowercase          → [the, wireless, headphones, noise, cancelling]
  │ stop words         → [wireless, headphones, noise, cancelling]
  │ stemming           → [wireless, headphon, nois, cancel]
  ▼ synonyms           → + [earphone, headset]
terms written to the inverted index
```

| Step | Purpose |
|---|---|
| Tokenization | split into words (language-specific; CJK/Vietnamese need special tokenizers) |
| Lowercasing / ASCII folding | `Café` = `cafe` |
| Stop words | drop `the`, `a` (less common today; BM25 handles them) |
| Stemming / lemmatization | `running`, `runs` → `run` |
| Synonyms | `tv` ↔ `television` |
| n-grams / edge n-grams | partial matching, autocomplete |

---

## 4. Relevance scoring

### TF-IDF
- **TF** (term frequency): term appears often in this doc → more relevant
- **IDF** (inverse document frequency): term is rare across all docs → more informative (`headphones` beats `with`)

`score = Σ tf(t, d) × idf(t)`

### BM25 (default in Elasticsearch/OpenSearch/Lucene)
Improves TF-IDF:
- **TF saturation** — the 10th occurrence adds much less than the 1st (parameter `k1`)
- **Length normalisation** — a match in a short title beats a match in a long description (parameter `b`)

### Beyond text relevance
Real ranking blends signals:
- field boosts (`title^3`, `description^1`)
- business signals: popularity, rating, stock, margin, recency
- personalization
- **learning to rank** (ML model on click data)
- **semantic / vector search** — embeddings + approximate nearest neighbour (HNSW); **hybrid search** combines BM25 and vectors

---

## 5. Search engine architecture (Elasticsearch / OpenSearch)

```text
cluster
 ├─ index "products"
 │   ├─ shard 0 (primary) + replica
 │   ├─ shard 1 (primary) + replica
 │   └─ shard 2 (primary) + replica
```

- An index is split into **shards** (each a Lucene index); replicas for HA and read throughput
- Query = **scatter-gather**: coordinating node sends query to one copy of each shard, each returns top-K, coordinator merges
- **Near real-time**: new documents become searchable after a **refresh** (default 1 s) — not instantly
- Lucene stores immutable **segments**; updates = delete + reinsert; background merges

---

## 6. Keeping search in sync with the database

The DB is the **source of truth**; the search index is a **derived view**.

| Approach | How | Trade-off |
|---|---|---|
| Dual write | app writes DB then ES | inconsistency if 2nd write fails |
| Outbox + worker | DB transaction writes outbox; worker indexes | reliable, small lag |
| **CDC** | Debezium reads DB log → Kafka → indexer | reliable, decoupled, more infra |
| Periodic batch reindex | cron rebuilds | simple, stale between runs |

Plus: **full reindex** capability with **index aliases** for zero downtime:
```text
products_v1 ← alias "products"
build products_v2 → switch alias atomically → delete v1
```

---

## 7. Autocomplete

Goal: < 50 ms suggestions per keystroke.

| Technique | Notes |
|---|---|
| **Edge n-grams** at index time | `phone` → `p, ph, pho, phon, phone`; simple prefix match |
| Completion suggester (FST) | very fast prefix lookups in memory |
| **Trie** | in-memory prefix tree; nodes store top-K suggestions |
| Redis sorted set | `ZRANGEBYLEX` for prefixes; scores for popularity |

Client side: **debounce** (~150–300 ms), cancel stale requests (`AbortController`), cache recent prefixes.

```ts
class TrieNode { children = new Map<string, TrieNode>(); top: string[] = []; }

class Autocomplete {
  root = new TrieNode();
  insert(term: string) {           // assume inserted in descending popularity
    let n = this.root;
    for (const ch of term.toLowerCase()) {
      if (!n.children.has(ch)) n.children.set(ch, new TrieNode());
      n = n.children.get(ch)!;
      if (n.top.length < 5) n.top.push(term);
    }
  }
  suggest(prefix: string): string[] {
    let n: TrieNode | undefined = this.root;
    for (const ch of prefix.toLowerCase()) { n = n.children.get(ch); if (!n) return []; }
    return n.top;
  }
}
```

---

## 8. Node.js sketch — a mini inverted index

```ts
const index = new Map<string, Map<number, number>>(); // term → (docId → tf)
const docLen = new Map<number, number>();

const analyze = (text: string) =>
  text.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

function add(id: number, text: string) {
  const terms = analyze(text);
  docLen.set(id, terms.length);
  for (const t of terms) {
    const postings = index.get(t) ?? new Map();
    postings.set(id, (postings.get(id) ?? 0) + 1);
    index.set(t, postings);
  }
}

function search(q: string, k1 = 1.2, b = 0.75) {
  const N = docLen.size;
  const avg = [...docLen.values()].reduce((a, c) => a + c, 0) / N;
  const scores = new Map<number, number>();
  for (const t of analyze(q)) {
    const postings = index.get(t);
    if (!postings) continue;
    const idf = Math.log(1 + (N - postings.size + 0.5) / (postings.size + 0.5));
    for (const [id, tf] of postings) {
      const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen.get(id)! / avg));
      scores.set(id, (scores.get(id) ?? 0) + idf * norm);
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 10);
}
```

That's BM25 in ~30 lines.

---

## 9. Choosing a tool

| Tool | When |
|---|---|
| PostgreSQL full-text (`tsvector`, GIN) + `pg_trgm` | moderate scale, want one database, transactional consistency |
| Elasticsearch / OpenSearch | large scale, rich relevance, aggregations/facets, logs |
| Meilisearch / Typesense | instant search UX, typo tolerance out of the box, simpler ops |
| Algolia | hosted, fastest to ship |
| Vector DB / pgvector | semantic search, RAG |

```sql
ALTER TABLE products ADD COLUMN tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', name || ' ' || coalesce(description,''))) STORED;
CREATE INDEX ON products USING GIN (tsv);
SELECT name, ts_rank(tsv, q) AS rank
FROM products, plainto_tsquery('english', 'wireless headphones') q
WHERE tsv @@ q ORDER BY rank DESC LIMIT 10;
```

---

## 10. Trade-offs

- **Freshness vs indexing cost** (refresh interval, near-real-time)
- **Consistency** — search index is eventually consistent with the DB
- **Recall vs precision** — fuzziness and synonyms find more but noisier
- **Operational cost** — ES clusters are memory-hungry and need tuning (shard sizing, heap)
- **Deep pagination** is expensive (`from + size`) → use `search_after`

---

## 11. Interview questions

1. **What is an inverted index?** — Term → posting list of documents; enables fast full-text lookup.
2. **Why not SQL LIKE?** — Full scan, no relevance, no stemming/typos.
3. **Explain TF-IDF / BM25.** — Frequent-in-doc × rare-in-corpus; BM25 adds saturation and length normalisation.
4. **How do you keep ES in sync with Postgres?** — Outbox or CDC → indexer; aliases for reindexing.
5. **How do you implement autocomplete?** — Edge n-grams / completion suggester / trie with top-K, debounced client.
6. **How does a distributed search query run?** — Scatter to shards, each returns top-K, coordinator merges.
7. **Why is a newly indexed document not found immediately?** — Near-real-time refresh interval.

**Prev:** [11 — Pub/Sub](11-pub-sub.md) · **Next:** [13 — CDN](13-cdn.md)
