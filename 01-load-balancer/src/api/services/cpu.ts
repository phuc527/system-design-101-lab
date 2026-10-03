/**
 * Deliberately slow CPU-bound work (O(2^n)). fib(30) takes ~10-15ms.
 * CPU-bound endpoints are where adding instances behind a load balancer
 * really pays off: each instance brings its own CPU.
 */
export function fibonacci(n: number): number {
  return n < 2 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
