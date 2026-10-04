# 15 — API Gateway

> One front door for many backend services. Cross-cutting concerns (auth, rate limits, routing, logging) live here once — not copy-pasted into every service.

---

## 1. The problem

With microservices, a mobile app might need to call:

```text
app ──▶ users.internal:3001
    ──▶ products.internal:3002
    ──▶ orders.internal:3003
    ──▶ payments.internal:3004
```

Problems:
- Clients know internal topology; renaming/splitting a service breaks clients
- Every service reimplements auth, rate limiting, CORS, logging, TLS
- Mobile clients make many round trips for one screen
- Internal services exposed to the internet = bigger attack surface

**API gateway** = a reverse proxy at the edge that is the single entry point.

```text
                       ┌──▶ user-service
client ──▶ API GATEWAY ┼──▶ product-service
           (auth,      ├──▶ order-service
           limits,     └──▶ payment-service
           routing)
```

---

## 2. Responsibilities

| Concern | Example |
|---|---|
| **Routing** | `/api/users/*` → user-service, `/api/v2/orders` → order-service-v2 |
| **Authentication** | verify JWT / API key / OAuth token once; forward identity (`X-User-Id`) |
| **Coarse authorization** | scopes, roles per route (fine-grained stays in services) |
| **Rate limiting & quotas** | per API key / plan (guide 07) |
| **TLS termination** | HTTPS at the edge |
| **Request/response transformation** | header rewrite, protocol translation (REST → gRPC), field filtering |
| **Aggregation / composition** | one call fans out to 3 services, merges response |
| **Caching** | cache GET responses |
| **Observability** | access logs, metrics, request ID / trace context injection |
| **Resilience** | timeouts, retries, circuit breaking per upstream |
| **Traffic management** | canary releases, A/B, blue/green, mirroring |
| **Security** | CORS, WAF rules, IP allow/deny, request size limits |

---

## 3. Gateway vs load balancer vs service mesh

| | Load balancer | API gateway | Service mesh |
|---|---|---|---|
| Traffic | any, to N copies of **one** service | **north-south** (external → internal) | **east-west** (service → service) |
| Understands | connections / HTTP | APIs, consumers, keys, plans | service identity, mTLS |
| Examples | Nginx, HAProxy, ALB | Kong, Tyk, AWS API Gateway, Apigee, Envoy Gateway, Traefik | Istio, Linkerd |

They overlap (Nginx/Envoy can do all three roles); the distinction is *who* the traffic is from and *what* policies apply.

---

## 4. Backend for Frontend (BFF)

One generic gateway serving web, iOS, Android and partners tends to bloat. **BFF pattern:** one gateway/aggregation layer **per client type**, owned by that client team.

```text
web app    ──▶ web-BFF    ─┐
mobile app ──▶ mobile-BFF ─┼──▶ services
partners   ──▶ public API ─┘
```

Mobile BFF returns compact payloads and aggregates screens; web BFF does SSR needs. GraphQL gateways are another way to let clients choose fields.

---

## 5. Request flow

```text
1. TLS handshake at gateway
2. assign X-Request-Id, start trace span
3. CORS / size / WAF checks
4. authenticate (JWT signature, expiry, issuer, audience) → 401 if bad
5. rate limit (by key/user) → 429
6. route match → pick upstream (service discovery, guide 16)
7. forward with timeout; retry idempotent requests; circuit breaker → 503 fast
8. transform response, add headers, log, emit metrics
```

---

## 6. Node.js sketch — a minimal gateway

```ts
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import jwt from "jsonwebtoken";

const app = express();

app.use((req, res, next) => {
  req.headers["x-request-id"] ??= crypto.randomUUID();
  res.setHeader("x-request-id", req.headers["x-request-id"] as string);
  next();
});

function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ error: "missing_token" });
  try {
    const claims = jwt.verify(token, process.env.JWT_PUBLIC_KEY!, { algorithms: ["RS256"], audience: "api" }) as jwt.JwtPayload;
    req.headers["x-user-id"] = String(claims.sub);   // trusted downstream ONLY because services are not publicly reachable
    delete req.headers.authorization;                // optional: don't forward the raw token
    next();
  } catch {
    res.status(401).json({ error: "invalid_token" });
  }
}

const proxy = (target: string) => createProxyMiddleware({ target, changeOrigin: true, proxyTimeout: 5000 });

app.use("/api/products", proxy("http://product-service:3000"));     // public
app.use("/api/users",    auth, rateLimit(100, 10), proxy("http://user-service:3000"));
app.use("/api/orders",   auth, rateLimit(50, 5),   proxy("http://order-service:3000"));

// aggregation endpoint
app.get("/api/home", auth, async (req, res) => {
  const headers = { "x-user-id": String(req.headers["x-user-id"]) };
  const [user, recs] = await Promise.allSettled([
    fetch("http://user-service:3000/me", { headers, signal: AbortSignal.timeout(800) }).then((r) => r.json()),
    fetch("http://product-service:3000/recommended", { headers, signal: AbortSignal.timeout(800) }).then((r) => r.json()),
  ]);
  res.json({
    user: user.status === "fulfilled" ? user.value : null,
    recommendations: recs.status === "fulfilled" ? recs.value : [], // degrade gracefully
  });
});

app.listen(8080);
```

In production you'd usually use a dedicated gateway (Kong, Envoy, Traefik, cloud gateway) and keep custom Node code for BFF/aggregation.

---

## 7. Pitfalls

| Pitfall | Why it's bad | Avoid by |
|---|---|---|
| **Business logic in the gateway** | becomes a "god service" every team must change and deploy | keep it to cross-cutting concerns; logic in services |
| Gateway is a SPOF | everything down if it's down | multiple instances behind LB, stateless, autoscale |
| Gateway is a bottleneck | adds latency/hop to every call | lightweight, keep-alive pools, horizontal scale |
| Trusting forwarded identity headers from outside | client sends `X-User-Id: admin` | strip incoming identity headers at edge; services reachable only via gateway (network policy) or mTLS |
| Aggregation without timeouts | one slow service blocks all | per-call timeouts, partial responses |
| Retrying non-idempotent calls | duplicate orders | retry only safe methods or with idempotency keys |
| One team owns gateway config for everyone | bottleneck in org | declarative, self-service config per service |

---

## 8. Versioning at the gateway

- URL: `/v1/orders` → order-service-v1, `/v2/orders` → order-service-v2
- Header: `Accept: application/vnd.shop.v2+json`
- Canary: route 5% of traffic to the new version by weight or header (`X-Canary: 1`)

---

## 9. Trade-offs

| Gain | Cost |
|---|---|
| single entry, simpler clients | extra hop (~1–5 ms) |
| centralized security, limits, observability | potential bottleneck / SPOF |
| decouples clients from internal topology | risk of becoming a monolith of config/logic |
| enables canary, versioning | operational ownership needed |

---

## 10. Production checklist

- [ ] Stateless, ≥2 instances, autoscaled
- [ ] JWT/API key validation; strip spoofable headers
- [ ] Per-consumer rate limits
- [ ] Per-route timeouts, circuit breakers, safe retries
- [ ] Request ID + trace propagation; access logs; RED metrics per route
- [ ] Request size limits, CORS policy, WAF
- [ ] Config as code, reviewed; zero-downtime config reloads

---

## 11. Interview questions

1. **What does an API gateway do?** — Single entry point: routing, auth, rate limiting, TLS, transformation, aggregation, observability.
2. **Gateway vs load balancer?** — LB spreads load across copies of a service; gateway applies API-level policies and routes to many services.
3. **What should NOT go in the gateway?** — Business/domain logic.
4. **What is a BFF?** — A gateway tailored per client type, owned by that frontend team.
5. **How do downstream services trust the user identity?** — Gateway verifies token and forwards claims; services only reachable via gateway / mTLS, or they verify the JWT themselves.
6. **How do you avoid the gateway being a SPOF?** — Multiple stateless instances behind LB, across zones.

**Prev:** [14 — Object Storage](14-object-storage.md) · **Next:** [16 — Service Discovery](16-service-discovery.md)
