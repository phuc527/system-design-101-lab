# 16 — Service Discovery

> In a dynamic system, instances come and go and IPs change constantly. Service discovery answers: "where is `order-service` right now, and which copies are healthy?"

---

## 1. The problem

```ts
const ORDER_URL = "http://10.0.3.17:3000";   // hardcoded
```

Works until:
- autoscaling adds 4 more instances (not used)
- the container restarts with a new IP (broken)
- an instance is unhealthy (still called)
- you deploy to staging/prod with different addresses

You need a **dynamic mapping**: service name → list of healthy instance addresses.

---

## 2. Approaches, from simplest

### 2.1 Static configuration
Env vars / config files list addresses.
✅ simple, no infra   ❌ manual, doesn't handle scaling or failures
Fine for small, stable setups.

### 2.2 DNS
`order-service.internal` resolves to one or more IPs.

- **Docker Compose / Docker networks**: service name is a DNS name (`http://order-service:3000`); with replicas, DNS returns multiple IPs
- **Kubernetes Service**: stable virtual IP + DNS name (`order-service.default.svc.cluster.local`); kube-proxy load-balances to healthy pods
- **Headless service / SRV records**: returns all pod IPs (+ ports) for client-side balancing
- Cloud: AWS Cloud Map, Route 53 private zones

DNS caveats:
- **TTL & caching** — clients/OS/runtimes cache answers; removed instances may still be called for TTL seconds (or forever if the runtime caches indefinitely)
- No rich health/metadata
- Node.js `dns.lookup` uses the OS resolver (getaddrinfo) and doesn't cache by itself; HTTP keep-alive connections, however, stay pinned to the old IP

### 2.3 Service registry
A dedicated, highly available database of instances: **Consul**, **etcd**, **ZooKeeper**, **Eureka**.

```text
1. instance starts → registers {name, ip, port, metadata} with TTL/heartbeat
2. registry health-checks or expects heartbeats
3. instance stops/crashes → deregistered (explicitly or TTL expires)
4. clients query (or watch) the registry for healthy instances
```

Registries are usually **CP** systems (Raft/ZAB consensus) — they must not hand out wrong answers during partitions — with client-side caching so discovery keeps working if the registry blips.

---

## 3. Registration patterns

| Pattern | Who registers | Notes |
|---|---|---|
| **Self-registration** | the service itself on startup, heartbeats, deregisters on shutdown | couples app to registry |
| **Third-party registration** | a registrar watches the platform (k8s, Docker events, Consul agent/Registrator) | app stays unaware — preferred |

---

## 4. Discovery patterns

### Client-side discovery

```text
client ──query──▶ registry → [10.0.1.5, 10.0.1.6, 10.0.1.7]
client ──picks one (round robin / least loaded)──▶ 10.0.1.6
```
✅ no extra hop, client can do smart balancing
❌ discovery + LB logic in every client, every language (Netflix Eureka + Ribbon)

### Server-side discovery

```text
client ──▶ load balancer / router ──query registry──▶ picks instance
```
✅ clients are simple (just call a name)
❌ extra hop, LB must be HA
(Kubernetes Services, AWS ALB + target groups, Nginx + Consul template)

### Service mesh (sidecar)
Each pod gets a proxy (Envoy). The control plane pushes endpoint lists to sidecars; app calls `localhost` / the service name and the sidecar handles discovery, LB, retries, mTLS. (Istio, Linkerd, Consul Connect)

---

## 5. Health integration

Discovery is only useful if it returns **healthy** instances.

- Registry performs checks (HTTP `/ready`, TCP, script) or expects heartbeats with TTL
- Kubernetes: only pods passing **readiness** probes are in a Service's endpoints (guide 17)
- Draining: on shutdown, deregister / fail readiness **first**, wait for propagation (a few seconds), then stop accepting — otherwise clients with stale lists hit a dead instance

```text
SIGTERM → readiness=false → wait ~5–10 s (endpoint propagation) → close server → exit
```

---

## 6. Node.js sketch — client-side discovery with Consul

```ts
type Instance = { address: string; port: number };

class Discovery {
  private cache = new Map<string, { instances: Instance[]; at: number }>();
  private rr = new Map<string, number>();

  constructor(private consul = "http://consul:8500", private ttlMs = 5000) {}

  async resolve(service: string): Promise<string> {
    let entry = this.cache.get(service);
    if (!entry || Date.now() - entry.at > this.ttlMs) {
      try {
        const res = await fetch(`${this.consul}/v1/health/service/${service}?passing=true`,
          { signal: AbortSignal.timeout(500) });
        const body = (await res.json()) as { Service: { Address: string; Port: number } }[];
        entry = { instances: body.map((e) => ({ address: e.Service.Address, port: e.Service.Port })), at: Date.now() };
        this.cache.set(service, entry);
      } catch (err) {
        if (!entry) throw err;   // registry down: keep serving the last known list
      }
    }
    if (entry.instances.length === 0) throw new Error(`no healthy ${service}`);
    const i = (this.rr.get(service) ?? 0) % entry.instances.length;
    this.rr.set(service, i + 1);
    const { address, port } = entry.instances[i];
    return `http://${address}:${port}`;
  }
}

// registration (self-registration)
await fetch("http://consul:8500/v1/agent/service/register", {
  method: "PUT",
  body: JSON.stringify({
    Name: "order-service", ID: `order-${process.env.HOSTNAME}`, Address: process.env.POD_IP, Port: 3000,
    Check: { HTTP: `http://${process.env.POD_IP}:3000/ready`, Interval: "5s", DeregisterCriticalServiceAfter: "1m" },
  }),
});
```

Key idea: **cache + fallback to last-known-good** so the registry isn't on the hot path and isn't a SPOF.

---

## 7. Comparison

| Approach | Dynamic | Health-aware | Extra infra | Typical |
|---|---|---|---|---|
| Static config | ❌ | ❌ | none | small/simple |
| DNS | ✅ (TTL-bound) | partly | DNS | Docker, k8s |
| Registry (client-side) | ✅ fast | ✅ | Consul/etcd/Eureka | VMs, polyglot |
| Platform LB (server-side) | ✅ | ✅ | LB | k8s Services, cloud |
| Service mesh | ✅ | ✅ + mTLS, retries | sidecars + control plane | large k8s fleets |

---

## 8. Failure modes

| Problem | Effect | Fix |
|---|---|---|
| Registry down | can't discover | client cache, last-known-good, HA registry cluster |
| Stale entries | calls to dead instances | TTL heartbeats, active checks, client retries to another instance |
| DNS caching too long | traffic to removed IPs | low TTL, respect TTL, recycle keep-alive connections |
| Flapping health | instances churn in/out | rise/fall thresholds |
| Split brain in registry | inconsistent views | consensus-based (Raft) registry |
| Shutdown race | requests to terminating pod | readiness off + delay before closing |

---

## 9. Interview questions

1. **Why do we need service discovery?** — Instances are dynamic (scaling, restarts, failures); hardcoded IPs break.
2. **Client-side vs server-side discovery?** — Client queries registry and balances itself vs a router/LB does it.
3. **How does Kubernetes do service discovery?** — DNS name → Service ClusterIP → kube-proxy routes to ready pod endpoints.
4. **Downsides of DNS-based discovery?** — Caching/TTL staleness, limited health info, connection pinning.
5. **What happens if the registry goes down?** — Clients should keep using cached lists; registry runs as a consensus cluster.
6. **Self vs third-party registration?** — App registers itself vs platform/agent registers it; third-party keeps app decoupled.

**Prev:** [15 — API Gateway](15-api-gateway.md) · **Next:** [17 — Health Check](17-health-check.md)
