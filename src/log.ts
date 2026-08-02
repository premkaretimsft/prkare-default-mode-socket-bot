// Structured, greppable logging for every call in/out of the bot. Each line is:
//   [<ISO-8601 UTC>] [<tag>] key=value ...  MS-CV=<cv>
// so you can copy the MS-CV + timestamp straight into the APX log search. MS-CV is the correlation
// vector: for an inbound socket envelope it's echoed on the envelope (env.cv); for an outbound HTTP
// call it's on the APX *response* headers (APX mints it per request). Both success and failure are
// logged with the same shape.

export function nowIso(): string {
  return new Date().toISOString();
}

// Render a flat field bag as `key=value` pairs, skipping undefined/null. Values are stringified and
// whitespace-collapsed so each event stays on one grep-able line.
function fields(bag: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(bag)) {
    if (v === undefined || v === null) continue;
    let s = typeof v === "string" ? v : JSON.stringify(v);
    s = String(s).replace(/\s+/g, " ");
    parts.push(`${k}=${s}`);
  }
  return parts.join(" ");
}

// One event line. `cv` is rendered last (and always, even when empty) so MS-CV is easy to spot/grep.
export function logEvent(tag: string, bag: Record<string, unknown>, cv?: string): void {
  const line = `[${nowIso()}] [${tag}] ${fields(bag)}  MS-CV=${cv ?? "(none)"}`;
  console.log(line);
}

export function logError(tag: string, bag: Record<string, unknown>, cv?: string): void {
  const line = `[${nowIso()}] [${tag}] ${fields(bag)}  MS-CV=${cv ?? "(none)"}`;
  console.error(line);
}

// Extract the MS-CV from a response's headers (case-insensitive).
export function cvOf(h: Headers | undefined): string | undefined {
  if (!h) return undefined;
  return h.get("MS-CV") ?? h.get("ms-cv") ?? undefined;
}

// Correlation/diagnostic headers useful for looking a request up in the APX server logs.
export function diagHeaders(h: Headers | undefined): string {
  if (!h) return "[no headers]";
  const wanted = [
    "MS-CV",
    "Date",
    "X-MSEdge-Ref",
    "x-ms-request-id",
    "x-ms-correlation-request-id",
    "request-id",
    "apim-request-id",
    "x-ms-timestamp",
  ];
  const parts: string[] = [];
  for (const name of wanted) {
    const v = h.get(name);
    if (v) parts.push(`${name}=${v}`);
  }
  return parts.length ? `[${parts.join("  ")}]` : "[no correlation headers]";
}

// Truncate long payloads so a single event stays readable but still shows the shape.
export function truncate(s: string | undefined, max = 1200): string {
  if (s == null) return "(none)";
  return s.length <= max ? s : s.slice(0, max) + `...(+${s.length - max} chars)`;
}
