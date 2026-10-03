/**
 * A fixed-size pool of "slots" - simulates a resource every real server has
 * a limited amount of: database connections, worker threads, licenses...
 *
 * Example: a PostgreSQL pool of 10 connections, queries take 100ms
 *   -> this instance can do at most 10 / 0.1s = 100 requests/second (Little's Law)
 *   -> request #11 waits in a queue until a connection is free
 *
 * That per-instance ceiling is exactly what a load balancer + more instances
 * raises: 3 instances = 3 pools = ~300 req/s.
 */
export interface PoolStats {
  size: number;
  active: number;
  waiting: number;
}

export class ResourcePool {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly size: number) {}

  /** Wait for a free slot. Call the returned function to give it back. */
  async acquire(): Promise<() => void> {
    if (this.active < this.size) {
      this.active += 1;
    } else {
      // No free slot: wait. The releasing request hands its slot directly to us.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next(); // pass the slot on (active count unchanged)
      else this.active -= 1;
    };
  }

  stats(): PoolStats {
    return { size: this.size, active: this.active, waiting: this.queue.length };
  }
}
