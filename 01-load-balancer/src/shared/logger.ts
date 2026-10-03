/**
 * Minimal structured (JSON) logger: one JSON object per line.
 * Lab 21 (observability) replaces this with a real logger.
 */
type Level = "info" | "warn" | "error";

export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env["NODE_ENV"] === "test") return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
