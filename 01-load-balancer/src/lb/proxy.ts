import http, { type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import type { Backend } from "./backend.js";

/**
 * Reverse proxy for ONE attempt: forward the client's request to `backend`
 * and stream the response back.
 *
 * Streaming (pipe) instead of buffering: the LB never holds a whole response
 * in memory, so a 1 GB download costs the LB a few KB.
 */

/** Hop-by-hop headers describe ONE connection and must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Backend responses that mean "try another server" (same list as our Nginx config). */
export const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

export type ProxyOutcome =
  /** The client got a response from this backend (could still be a 5xx on the last attempt). */
  | { kind: "responded"; statusCode: number }
  /** Nothing was sent to the client yet - the caller may try another backend. */
  | { kind: "failed"; reason: string };

export interface ForwardOptions {
  agent: http.Agent;
  timeoutMs: number;
  clientIp: string;
  /** true -> on error/5xx, return "failed" without touching the client response, so the caller can retry */
  canRetry: boolean;
}

function forwardedHeaders(req: IncomingMessage, backend: Backend, clientIp: string): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  // Tell the backend who the real client is - otherwise it only ever sees the LB's IP.
  const prior = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = prior ? `${String(prior)}, ${clientIp}` : clientIp;
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-proto"] = "http";
  headers.host = backend.url.host;
  return headers;
}

function responseHeaders(upstream: IncomingHttpHeaders, backend: Backend): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(upstream)) {
    if (!HOP_BY_HOP.has(name) && value !== undefined) headers[name] = value;
  }
  headers["x-upstream"] = backend.id; // which backend answered (like Nginx's $upstream_addr)
  return headers;
}

export function forward(
  req: IncomingMessage,
  res: ServerResponse,
  backend: Backend,
  options: ForwardOptions,
): Promise<ProxyOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: ProxyOutcome): void => {
      if (!settled) {
        settled = true;
        resolve(outcome);
      }
    };

    const upstreamReq = http.request(
      {
        protocol: backend.url.protocol,
        hostname: backend.url.hostname,
        port: backend.url.port,
        method: req.method,
        path: req.url,
        headers: forwardedHeaders(req, backend, options.clientIp),
        agent: options.agent, // keep-alive pool: reuse TCP connections to backends
      },
      (upstreamRes) => {
        const statusCode = upstreamRes.statusCode ?? 502;

        if (options.canRetry && RETRYABLE_STATUSES.has(statusCode)) {
          upstreamRes.resume(); // discard body, keep the socket reusable
          settle({ kind: "failed", reason: `backend returned HTTP ${statusCode}` });
          return;
        }

        res.writeHead(statusCode, responseHeaders(upstreamRes.headers, backend));
        upstreamRes.pipe(res);
        upstreamRes.on("end", () => settle({ kind: "responded", statusCode }));
        upstreamRes.on("error", () => {
          res.destroy(); // headers already sent: all we can do is cut the connection
          settle({ kind: "responded", statusCode });
        });
      },
    );

    // Socket idle timeout: backend accepted the connection but went silent (hung / overloaded).
    upstreamReq.setTimeout(options.timeoutMs, () => {
      upstreamReq.destroy(new Error(`no response within ${options.timeoutMs}ms`));
    });

    upstreamReq.on("error", (err: NodeJS.ErrnoException) => {
      const reason = err.code ? `${err.code} ${err.message}` : err.message;
      if (res.headersSent) {
        res.destroy();
        settle({ kind: "responded", statusCode: res.statusCode });
      } else {
        settle({ kind: "failed", reason });
      }
    });

    // Client went away (Ctrl+C, closed tab): stop working on its behalf.
    res.on("close", () => {
      if (!res.writableFinished) upstreamReq.destroy();
    });

    if (options.canRetry) {
      // Retryable requests are GET/HEAD: no body to forward, so they can be replayed.
      upstreamReq.end();
    } else {
      // Bodies are streamed once; that is why POST requests are never retried here.
      req.pipe(upstreamReq);
    }
  });
}
