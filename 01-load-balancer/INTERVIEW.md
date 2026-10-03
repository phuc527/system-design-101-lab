# Interview Questions: Load Balancing

---

## Beginner

### Q1. What is a load balancer and why do we need one?

**Answer:** a component that receives client requests and distributes them across a pool of identical servers. It gives clients **one address**, lets you **scale horizontally** (add servers to add capacity), provides **high availability** (unhealthy servers are taken out of rotation), and enables **zero-downtime deploys** (drain one server at a time). In this lab, three instances behind Nginx served 293 req/s versus 97 for one, and killing an instance caused zero user-visible errors.

### Q2. What's the difference between a reverse proxy and a forward proxy?

**Answer:** a **forward proxy** acts on behalf of **clients**: the client is configured to use it (corporate proxy, VPN), and servers see the proxy instead of the client. A **reverse proxy** acts on behalf of **servers**: clients think they're talking to the origin, and the proxy forwards to backends it chooses. Load balancers, API gateways and CDNs are reverse proxies. A reverse proxy is also useful with one backend: TLS termination, compression, caching, buffering slow clients.

### Q3. Explain round robin and least connections.

**Answer:**
- **Round robin** sends requests to servers in turn: 1, 2, 3, 1, 2, 3. Simple and even when servers are identical and requests cost the same.
- **Least connections** sends each request to the server with the fewest requests currently in flight. It adapts when one server is slow or some requests are expensive.

In this lab, with one server slowed by 500ms, round robin still sent it 33% of traffic (p95 528ms, 97 req/s), while least connections sent it 3.5% (p95 55ms, 362 req/s).

### Q4. What is a health check? Active vs passive?

**Answer:** how the LB decides whether a backend should receive traffic.
- **Active:** the LB periodically calls an endpoint like `GET /health`. After N consecutive failures it marks the server down, after M successes up again. It detects failures even with no traffic.
- **Passive:** the LB watches real requests. Connection errors, timeouts or 5xx responses count as failures (Nginx `max_fails` / `fail_timeout`). No extra traffic, but some real users hit the failure first.

Open-source Nginx only has passive checks. HAProxy, Envoy, NGINX Plus and cloud LBs have both. Thresholds prevent flapping on a single blip.

### Q5. What's the difference between L4 and L7 load balancing?

**Answer:** **L4** works at the transport layer: it sees IPs and ports and balances TCP/UDP **connections** without understanding HTTP. Very fast and protocol-agnostic (AWS NLB, IPVS). **L7** parses HTTP, so it can route by path, host, header or cookie, retry individual requests, terminate TLS, add headers and do sticky sessions by cookie (Nginx, AWS ALB, Envoy). L7 costs more CPU but enables far more features. Large systems often put L4 in front of a fleet of L7 proxies.

---

## Intermediate

### Q6. How do you avoid the load balancer becoming a single point of failure?

**Answer:**
- **Active-passive pair with a floating (virtual) IP:** two LBs run keepalived/VRRP. If the active one dies, the standby takes over the IP within seconds.
- **Active-active:** several LBs, all serving, with DNS returning multiple IPs (and health-checking them) or anycast routing to the nearest healthy one.
- **Managed LBs** (AWS ALB/NLB, GCP LB) are redundant across availability zones by design.
- Also: spread LBs and backends across zones, and keep LB config in version control so it can be recreated quickly.

### Q7. What are sticky sessions, and why are they considered an anti-pattern?

**Answer:** session affinity routes the same client to the same backend, by cookie, client IP or a key like user ID, usually because the app keeps session state in memory. Problems:
- **Uneven load:** users behind one NAT or proxy share an IP. In this lab `ip_hash` sent 100% of traffic to one server.
- **Lost state on failure:** if that server dies or is scaled in, its users lose sessions and carts.
- **Harder scaling and deploys:** you can't freely move users between instances.

The better design is **stateless services** with state in a shared store (Redis, database), so any instance can serve any request. Stickiness is still legitimate for some long-lived connections (WebSockets) or cache locality, ideally via consistent hashing.

### Q8. How does a load balancer handle a backend that is slow or hung rather than dead?

**Answer:** a dead backend fails fast (connection refused → instant retry elsewhere). A hung backend accepts connections but never answers, and the LB can only detect that by **timeouts**. In this lab, freezing one instance under round robin parked all clients on it and **stalled all traffic for ~4 seconds** until the 5s read timeout fired, the requests were retried, and `max_fails` ejected it. Active health checks alone did not help: they ejected the server after ~4.6s but could not rescue requests already stuck on it. Lowering the per-request timeout from 5s to 1s shrank the stall to ~1s. Mitigations: tight connect timeouts (~1s) and read timeouts sized to each endpoint, least-connections (stuck requests make the server look busy), active health checks with their own short timeout, and circuit breaking / outlier detection (lab 18).

### Q9. When should a load balancer retry a request on another backend?

**Answer:** only when it's **safe and useful**:
- the method is **idempotent** (GET, HEAD, and PUT/DELETE by spec), or the request carries an idempotency key
- the failure is likely transient and backend-specific: connection refused, reset, connect timeout, 502/503/504
- there's another healthy backend, and the retry fits within an overall deadline
- limited to 1–2 retries, to avoid multiplying load

Nginx never retries a POST that was already sent to a backend unless you add `non_idempotent`, because the first attempt may have succeeded (a timed-out payment may have been charged). In this lab, a GET to a failing instance was retried invisibly (0 of 300 failed), while a POST got exactly one attempt.

### Q10. How do you deploy a new version behind a load balancer with zero failed requests?

**Answer:** rolling deploy with **connection draining**:
1. Send SIGTERM. The app starts failing its readiness check (`/health` → 503) but keeps serving, and marks responses `Connection: close` so keep-alive clients reconnect elsewhere.
2. Wait until the LB has noticed. **Drain time > LB detection time** (check interval × failure threshold, plus one interval).
3. Stop accepting connections and let in-flight requests finish.
4. Exit before the orchestrator's **grace period** expires (it SIGKILLs after that).
5. Start the new instance, wait until it's healthy, then repeat for the next one.

Rule: `detection < drain < grace period`. In this lab it took three attempts: drain shorter than detection, a 3s default grace period that SIGKILLed the process, and keep-alive connections that never closed.

---

## Advanced

### Q11. Your service has 3 instances behind an LB but throughput barely improved over 1. What do you check?

**Answer:** the bottleneck isn't the instances:
- **Shared downstream:** database CPU or connections, Redis, a rate-limited third-party API. More instances just queue on the same thing.
- **Shared host:** instances on the same physical machine compete for CPU and power. In this lab a 15W laptop CPU throttled to 802 MHz, so CPU-bound work went from 66 to 70 req/s with 2 instances while each request got 2–3× slower.
- **Uneven distribution:** sticky sessions, `ip_hash` behind NAT, long-lived keep-alive or HTTP/2 connections pinned to one backend.
- **The LB itself:** CPU (TLS), `worker_connections`, file descriptors, bandwidth.
- **The load generator:** not enough concurrency, or running on the same machine.

Measure per-instance RPS and CPU, downstream latency and saturation, and LB metrics, then fix the measured bottleneck.

### Q12. Why can least-connections behave exactly like round robin, and what are its limits at scale?

**Answer:** least-connections needs **differences in in-flight counts** to make good decisions. If a burst of requests arrives at the same instant, all backends start at 0, ties are broken in rotation, and the result is round robin. Its advantage appears only under sustained load, as slow backends accumulate in-flight requests. (One of this lab's tests initially failed for exactly this reason.) At scale:
- With **many LB instances**, each only knows its *own* connections, so the global view is wrong. Options: P2C (power of two random choices), or a shared state zone (Nginx `zone`).
- It counts **connections, not cost**. A cheap and an expensive request look the same. Latency-aware algorithms (EWMA / least response time) help.
- **New instances** with 0 connections get flooded (thundering herd), so you need slow-start.

### Q13. Explain consistent hashing and why a load balancer would use it.

**Answer:** plain `hash(key) % N` remaps almost every key when N changes. Going from 3 to 2 servers moves about 2/3 of keys (this lab's test measured >45%). **Consistent hashing** places servers (with many virtual nodes each) on a ring of hash values, and each key goes to the next server clockwise. Adding or removing a server moves only ~1/N of keys. LBs use it when routing must be **sticky to a key**: cache servers (higher hit rate), per-user state, sharded backends. Nginx: `hash $http_x_user_id consistent;` (ketama). Downsides: uneven distribution with few keys or few virtual nodes (we saw 44/28/28 with 50 users), and hot keys still overload one server. Lab 06 implements it.

### Q14. How does a load balancer discover backends that come and go (auto-scaling, containers)?

**Answer:** options, from simplest:
1. **Static config + reload:** fine for fixed fleets.
2. **DNS:** the LB re-resolves a name periodically (Nginx `resolve` + `resolver valid=5s`). Simple, but limited by TTLs and resolver behaviour. In this lab, Docker Desktop took ~3.8s to answer NXDOMAIN for a stopped container, Nginx's 2s `resolver_timeout` treated that as a temporary failure, and it **kept routing to the dead container's old IP** until the timeout was raised.
3. **Service registry** (Consul, etcd, Eureka) or the orchestrator API (Kubernetes Endpoints): instances register on start and deregister on shutdown, and LBs watch for changes (Envoy xDS).
4. **Cloud integration:** auto-scaling groups register instances in ALB target groups automatically.

Health checks remain essential either way, because registration doesn't prove an instance is healthy. More in lab 16.

### Q15. Design the load-balancing tier for a global API serving 100k req/s.

**Answer (outline):**
- **Global layer:** GeoDNS / latency-based DNS or anycast to route users to the nearest region. Health-checked so a failed region is withdrawn.
- **Edge:** CDN/WAF for static content, TLS termination near users, DDoS protection.
- **Regional L4:** NLB or IPVS/Maglev-style L4 balancing with ECMP for raw packet throughput and HA.
- **Regional L7:** a fleet of Envoy/Nginx (or a managed ALB) across 3 zones. Path-based routing, retries with budgets, timeouts, outlier detection, rate limiting.
- **Backends:** stateless services in auto-scaling groups across zones, with readiness probes, draining and slow-start.
- **Sizing:** if one instance does ~500 req/s at the target p99, 100k needs 200 instances, plus N+1 per zone and ~30% headroom, so ~280, spread across 3 zones.
- **Failure planning:** losing one zone must leave enough capacity (~50% headroom per zone in a 3-zone design, or accept degradation). LBs redundant at every layer.
- **Observability:** per-backend RED metrics, LB logs with upstream timing, synthetic checks from multiple regions.

### Q16. What headers should a reverse proxy add or remove, and what are the security implications?

**Answer:** **add** `X-Forwarded-For` (client IP chain), `X-Real-IP`, `X-Forwarded-Proto` (http vs https, so apps build correct URLs and enforce HTTPS), `X-Forwarded-Host`, and optionally a request ID. **Remove** hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `Upgrade`, `TE`, `Trailer`, `Proxy-*`), which apply to a single connection. Security: `X-Forwarded-For` is **client-controlled** unless the edge proxy overwrites it. Apps must take the client IP only from entries added by trusted proxies (Express `app.set('trust proxy', ...)`), or attackers can spoof IPs to bypass rate limits and IP allow-lists. This lab's TS LB trusts the header deliberately for experiments, and the code warns about it.
