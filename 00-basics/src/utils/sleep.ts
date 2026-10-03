/**
 * Non-blocking wait. While we "sleep" the event loop is free to serve other
 * requests - this is how we simulate I/O (a database call, an HTTP call...).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
