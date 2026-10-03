/**
 * Deliberately slow, CPU-bound work.
 *
 * Naive recursive Fibonacci is O(2^n): fib(30) ~ 10ms, fib(35) ~ 100ms,
 * fib(40) ~ 1s (machine dependent). While it runs, the Node.js event loop
 * cannot do ANYTHING else - perfect for showing why CPU-heavy work kills
 * throughput in a single-threaded server.
 */
export function fibonacci(n: number): number {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
