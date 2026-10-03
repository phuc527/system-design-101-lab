/**
 * Builds a realistic JSON payload (a list of products) of roughly `kb` kilobytes.
 *
 * Real API JSON is very repetitive (same keys, similar values), which is why
 * gzip usually shrinks it by 80-95%. Less bytes on the wire = less bandwidth,
 * and on slow networks that also means lower latency.
 */
export function buildPayload(kb: number): string {
  const targetBytes = kb * 1024;
  const items: string[] = [];
  let size = 12; // '{"items":[' + ']}'
  let id = 0;

  while (size < targetBytes) {
    id += 1;
    const item = JSON.stringify({
      id,
      sku: `SKU-${String(id).padStart(6, "0")}`,
      name: `Product ${id}`,
      price: Math.round(((id * 7919) % 10_000) + 99) / 100,
      inStock: id % 3 !== 0,
      description: "A perfectly ordinary product used to demonstrate bandwidth and compression.",
    });
    items.push(item);
    size += item.length + 1;
  }
  return `{"items":[${items.join(",")}]}`;
}
