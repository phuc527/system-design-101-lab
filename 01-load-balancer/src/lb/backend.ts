/**
 * A backend server as the load balancer sees it, plus the health state machine.
 *
 *            failure x unhealthyThreshold
 *     ┌────┐ ───────────────────────────▶ ┌──────┐
 *     │ UP │                              │ DOWN │   (no traffic)
 *     └────┘ ◀─────────────────────────── └──────┘
 *            success x healthyThreshold
 *
 * Thresholds avoid "flapping": one dropped health check should not eject a
 * server, and one lucky success should not put a broken server back in rotation.
 */
export interface Backend {
  readonly id: string;
  readonly url: URL;
  healthy: boolean;
  /** requests currently being proxied to this backend (used by least-connections) */
  activeConnections: number;
  totalRequests: number;
  totalFailures: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastError: string | null;
  lastStateChange: string;
}

export function createBackend(rawUrl: string): Backend {
  const url = new URL(rawUrl);
  return {
    id: url.host,
    url,
    healthy: true, // optimistic start, like Nginx: the first health check corrects it within one interval
    activeConnections: 0,
    totalRequests: 0,
    totalFailures: 0,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    lastError: null,
    lastStateChange: new Date().toISOString(),
  };
}

export type Transition = "went-up" | "went-down" | null;

/** Record a successful ACTIVE health check. Returns the state change, if any. */
export function recordSuccess(backend: Backend, healthyThreshold: number): Transition {
  backend.consecutiveFailures = 0;
  backend.consecutiveSuccesses += 1;
  if (!backend.healthy && backend.consecutiveSuccesses >= healthyThreshold) {
    backend.healthy = true;
    backend.lastStateChange = new Date().toISOString();
    return "went-up";
  }
  return null;
}

/** Record a failure (health check failed, connection error, timeout, 5xx). */
export function recordFailure(backend: Backend, unhealthyThreshold: number, error: string): Transition {
  backend.consecutiveSuccesses = 0;
  backend.consecutiveFailures += 1;
  backend.totalFailures += 1;
  backend.lastError = error;
  if (backend.healthy && backend.consecutiveFailures >= unhealthyThreshold) {
    backend.healthy = false;
    backend.lastStateChange = new Date().toISOString();
    return "went-down";
  }
  return null;
}
