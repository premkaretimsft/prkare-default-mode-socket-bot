import { config } from "./config";
import { buildInvokeResponse } from "./invokeResponses";

// The reply frame the bot returns from its "Activity" handler. APX reconstructs an HttpResponseMessage
// from { status, body } and feeds it to InvokeHelper.ProcessInvokeResponse unchanged, so this is the
// same shape an HTTP bot would return. envelopeId / botKey / ts / recvAt are optional echoes used for
// logging, latency telemetry, and a defensive anti-spoof check on APX (botKey must match the target).
export interface InvokeReplyFrame {
  envelopeId?: string;
  status: number;
  body?: unknown;
  botKey?: string;
  ts?: number;
  recvAt?: number;
}

// The logging/anti-spoof echo fields the bot stamps on every reply (everything but the response itself).
type ReplyEcho = Pick<InvokeReplyFrame, "envelopeId" | "botKey" | "recvAt">;

// APX serializes the envelope with the Newtonsoft hub protocol (camelCase), but we still read fields
// case-insensitively via g() to stay robust to any protocol/casing change. Invoke *value* contents
// (directive, delayMs) are passed through verbatim, so they keep whatever casing the caller set.
function g(obj: any, name: string): any {
  if (obj == null) return undefined;
  if (obj[name] !== undefined) return obj[name];
  const cap = name.charAt(0).toUpperCase() + name.slice(1);
  return obj[cap];
}

// Handles one inbound invoke envelope and RETURNS the reply frame (client results):
//   { type, envelopeId, cv, deadlineMs, payload: <BotActivity> }
// Behavior is directive-driven via payload.value.directive so a single bot drives every scenario:
//   ok    -> return 200 + the real Bot Framework invoke-response body  (happy path)
//   error -> return 500 + error body                                   (bot handler failure)
//   delay -> sleep payload.value.delayMs (default 27000) then return   (force APX deadline -> timeout)
//   drop  -> never return                                              (force APX timeout -> HTTP fallback)
export async function handleActivity(env: any): Promise<InvokeReplyFrame | undefined> {
  // Stamp receipt time immediately so botProcessingMs (= bot-sent ts − recvAt) reflects real handling
  // time, not ~0. Both timestamps share the single bot clock, so the metric is skew-free.
  const recvAt = Date.now();
  const type = g(env, "type");
  const payload = g(env, "payload") || {};
  const envelopeId = g(env, "envelopeId");
  const cv = g(env, "cv");
  const name = g(payload, "name");
  const value = g(payload, "value") || {};
  const directive = String(value.directive ?? value.Directive ?? config.defaultDirective).toLowerCase();

  console.log(`\n[recv] <-- APX  envelopeId=${envelopeId} type=${type} cv=${cv} name=${name} directive=${directive}`);
  console.log(`[recv]   activity payload=${truncate(JSON.stringify(payload), 1500)}`);

  // Real Teams invoke handling — the reply body is the same shape the HTTP bot would return for this
  // invoke name. The transport directive only governs timing / error / drop.
  const reply = buildInvokeResponse(name, value);
  const base: ReplyEcho = { envelopeId, botKey: config.botKey, recvAt };

  switch (directive) {
    case "drop":
      console.log(`[invoke] DROP (never returning) name=${name} envelopeId=${envelopeId} -> APX awaits to its deadline then times out -> HTTP fallback`);
      // Never resolve: keep the client-results invocation pending so APX hits its invoke deadline.
      return new Promise<InvokeReplyFrame>(() => { /* intentionally never resolves */ });

    case "delay": {
      const ms = Number(value.delayMs ?? value.DelayMs ?? 27000);
      console.log(`[invoke] DELAY ${ms}ms name=${name} envelopeId=${envelopeId} (tests the APX invoke deadline)`);
      await sleep(ms);
      return reply200(base, reply);
    }

    case "error":
      console.log(`[invoke] ERROR directive name=${name} envelopeId=${envelopeId} -> returning status=500`);
      return { ...base, status: 500, body: { error: "bot handler error (test directive=error)" }, ts: Date.now() };

    case "ok":
    default:
      return reply200(base, reply);
  }
}

function reply200(base: ReplyEcho, reply: { status: number; body?: unknown }): InvokeReplyFrame {
  const frame: InvokeReplyFrame = { ...base, status: reply.status, body: reply.body, ts: Date.now() };
  console.log(
    `[reply] --> APX (client result) envelopeId=${base.envelopeId} status=${frame.status} ` +
      `body=${truncate(JSON.stringify(frame.body), 1200)}`
  );
  return frame;
}

function truncate(s: string | undefined, max = 800): string {
  if (s == null) {
    return "(none)";
  }
  return s.length <= max ? s : s.slice(0, max) + `...(+${s.length - max} chars)`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
