# 13 — CDN (Content Delivery Network)

> The speed of light is a hard limit. A CDN moves content physically closer to users so requests travel 20 km instead of 10,000 km.

---

## 1. The problem

Your origin server is in Singapore. A user in Paris loads a page with 80 assets:
- RTT Paris ↔ Singapore ≈ 160 ms; TCP + TLS handshake = several round trips before the first byte
- Every asset request crosses the planet
- A viral spike sends 1M requests to one origin
- Bandwidth from your origin is expensive

A **CDN** is a globally distributed network of caching servers (**edge / PoPs — points of presence**). Users connect to the nearest edge; the edge serves cached content or fetches it from your **origin** once.

```text
user (Paris) ──20 ms──▶ edge Paris ──(cache miss only)──160 ms──▶ origin Singapore
user (Paris) ──20 ms──▶ edge Paris  (cache hit) ✔
```

---

## 2. What a CDN gives you

| Benefit | How |
|---|---|
| **Lower latency** | short RTT; TLS terminated at the edge; warm connections edge→origin |
| **Origin offload** | 95%+ of static requests never reach origin |
| **Bandwidth cost** | egress served from CDN (often cheaper) |
| **Availability** | serve stale content when origin is down |
| **Security** | DDoS absorption, WAF, bot management, TLS |
| **Edge compute** | run code at the edge (Cloudflare Workers, Lambda@Edge, Vercel Edge) |

---

## 3. How users reach the nearest edge

- **DNS-based routing** — CDN's DNS returns the IP of a nearby PoP based on resolver location
- **Anycast** — the same IP is announced from every PoP; BGP routes the user to the closest one (Cloudflare)

---

## 4. Request flow

```text
1. GET https://cdn.example.com/app.3f9a.js
2. DNS / anycast → edge PoP
3. edge cache lookup by cache key (host + path + selected query/headers)
   ├─ HIT  → return (X-Cache: HIT, Age: 1234)
   └─ MISS → (optional) regional/shield cache → origin
4. store according to Cache-Control, return to user
```

### Tiered caching / origin shield
Edges miss to a **regional shield** cache instead of the origin directly. 200 PoPs missing = 1 origin request, not 200. Big win for origin load and hit ratio.

---

## 5. Controlling caching with HTTP headers

```http
Cache-Control: public, max-age=31536000, immutable        # hashed static assets
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400
Cache-Control: private, no-store                          # personal / sensitive
```

| Directive | Meaning |
|---|---|
| `max-age` | browser freshness (s) |
| `s-maxage` | shared cache (CDN) freshness — overrides max-age for CDN |
| `public` / `private` | may / may not be stored by shared caches |
| `no-cache` | store, but revalidate every time |
| `no-store` | never store |
| `immutable` | won't change; don't revalidate |
| `stale-while-revalidate` | serve stale while fetching new in background |
| `stale-if-error` | serve stale if origin errors |
| `Vary` | cache separate variants per header (`Accept-Encoding`) |
| `ETag` / `Last-Modified` | enable conditional requests → `304` |

**Never** let the CDN cache responses with `Set-Cookie` or personalised data — one user's page served to everyone is a classic security incident.

---

## 6. Cache keys

Default key ≈ `scheme + host + path + query`. Problems:
- `?utm_source=...` variations → every campaign link is a separate cache entry → low hit ratio → **strip or ignore** irrelevant query params
- `Vary: User-Agent` → thousands of variants → avoid; normalise to device class if needed
- Include what truly changes the response (`Accept-Language` if you localise, auth for private caching)

---

## 7. Invalidation strategies

| Strategy | How | Notes |
|---|---|---|
| **Versioned / fingerprinted URLs** | `app.3f9a1c.js` — new content = new URL | best for static assets; cache forever (`immutable`) |
| TTL expiry | short `s-maxage` | simple; staleness up to TTL |
| **Purge** by URL | API call to CDN | takes seconds–minutes globally |
| Purge by tag / surrogate key | `Surrogate-Key: product-42` then purge tag | purge all pages showing product 42 |
| Soft purge | mark stale, revalidate | avoids origin stampede |

Build tools (Vite, webpack, Next.js) fingerprint assets automatically — HTML references new filenames on deploy. Keep **HTML short-lived**, assets **immutable**.

---

## 8. What to put on a CDN

| Content | CDN? |
|---|---|
| JS/CSS/fonts/images (fingerprinted) | ✅ cache for a year |
| Video (HLS/DASH segments) | ✅ |
| Software downloads | ✅ |
| Public HTML pages | ✅ short TTL + SWR |
| Public API responses (product list) | ✅ short TTL, purge by tag |
| Personalised pages / authenticated API | ⚠ pass-through (still gains TLS, routing, DDoS protection) |
| Write requests (POST) | pass-through |

---

## 9. Node.js sketch — origin setting correct headers

```ts
import express from "express";
const app = express();

// fingerprinted build assets
app.use("/assets", express.static("dist/assets", {
  immutable: true,
  maxAge: "365d",
}));

// public, cacheable API
app.get("/api/products", async (_req, res) => {
  res.set("Cache-Control", "public, max-age=30, s-maxage=300, stale-while-revalidate=60, stale-if-error=86400");
  res.set("Surrogate-Key", "products");
  res.json(await productService.list());
});

// private data — never cached by shared caches
app.get("/api/me", requireAuth, (req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json(req.user);
});
```

---

## 10. Failure modes

| Problem | Cause | Fix |
|---|---|---|
| Low hit ratio | query string noise, `Vary` explosion, short TTL | normalise cache key, longer TTL + purge |
| Stale content after deploy | HTML cached long, references old assets | short TTL on HTML, fingerprint assets |
| Data leak | cached authenticated response | `private, no-store`; strip `Set-Cookie` responses from cache |
| Origin stampede after purge | all PoPs miss at once | origin shield, soft purge, request collapsing |
| Origin down | — | `stale-if-error`, multiple origins/failover |
| Cache poisoning | unkeyed header changes response | only vary on keyed inputs; validate headers |

---

## 11. Metrics

- **Cache hit ratio** (requests and bytes) — aim 90%+ for static
- Origin requests/s and egress
- Edge latency (TTFB) by region
- 4xx/5xx at edge vs origin

---

## 12. Trade-offs

- **Freshness vs hit ratio** (TTL choice)
- **Purge latency** — global purges aren't instant
- **Vendor lock-in** for edge compute and configs
- **Debugging** — another cache layer between you and the user (`X-Cache`, `Age`, `CF-Cache-Status` headers help)

---

## 13. Interview questions

1. **How does a CDN reduce latency?** — Content served from a nearby edge; shorter RTT, TLS at edge, fewer origin trips.
2. **Push vs pull CDN?** — Push: you upload content to CDN; pull: CDN fetches from origin on first miss (most common).
3. **How do you invalidate CDN content?** — Fingerprinted URLs for assets; purge by URL/tag; short TTL + SWR for HTML/API.
4. **`max-age` vs `s-maxage`?** — Browser vs shared caches.
5. **What is an origin shield?** — Mid-tier cache that collapses edge misses so the origin sees few requests.
6. **Can you cache API responses at the CDN?** — Yes for public data with short TTL and purge-by-tag; never personalised data.
7. **Origin is down — what can the CDN do?** — Serve stale via `stale-if-error`, fail over to a backup origin.

**Prev:** [12 — Search](12-search.md) · **Next:** [14 — Object Storage](14-object-storage.md)
