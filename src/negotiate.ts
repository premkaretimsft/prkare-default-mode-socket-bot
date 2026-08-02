import { config } from "./config";
import { getBotFrameworkToken } from "./auth";
import { logEvent, logError, cvOf, diagHeaders } from "./log";

export interface NegotiateResult {
  url: string;
  accessToken: string;
  expiresIn: number; // seconds
}

// POST {apxBaseUrl}/v3/websockets/connect.
// DEBUG local APX honors ?botKey=<MsaAppId> when the request is unauthenticated, which is all this
// test bot needs. For an authenticated run, replace the query param with a Bearer Bot Framework JWT
// and let APX derive the botKey from the validated token.
export async function negotiate(): Promise<NegotiateResult> {
  // Join onto the base path (preserve any cloud/region segment like /amer). A leading-slash URL
  // path would replace the whole base path and drop /amer, so concatenate explicitly.
  const base = config.apxBaseUrl.replace(/\/+$/, "");

  // Tenantized connect route: {cloud}/{tenantId}/v3/websockets/connect. The bot token only carries
  // botId, not tenant — APX's OpenIdJwtAuthenticator never sets ctx.TenantId for a bot token, and a
  // WebSocket connect has no conversation to resolve an end-user tenant from. So a tenant-scoped
  // socket flag (DeliverEventViaSocketEnabled) can't match on the plain route and connect returns
  // 503 reason=Disabled. Putting the tenant in the path lets BotFrontEnd's TenantIdInPathFilter call
  // ctx.SetTenantId(tenantId) before the eligibility check, so tenant-scoped gating resolves.
  // Requires the TenantIdInPathRoutesEnabled feature to be ON in the ring (else APX returns
  // "API not enabled"). Only used for the authenticated Canary path; a local DEBUG ?botKey= run
  // keeps the plain route.
  const useTenantPath =
    config.tenantInPath && !!config.botPassword && !!config.botTenantId;
  const connectPath = useTenantPath
    ? `${base}/${config.botTenantId}/v3/websockets/connect`
    : `${base}/v3/websockets/connect`;
  const url = new URL(connectPath);
  logEvent("negotiate >>", {
    dir: "bot->APX",
    method: "POST",
    route: url.pathname,
    tenantized: useTenantPath,
    tenant: useTenantPath ? config.botTenantId : undefined,
    botKey: config.botKey,
  });
  const headers: Record<string, string> = { "content-length": "0" };

  if (config.botPassword) {
    const token = await getBotFrameworkToken();
    headers["authorization"] = `Bearer ${token}`;
  } else if (config.botKey) {
    url.searchParams.set("botKey", config.botKey);
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const diag = diagHeaders(res.headers);
    const cv = cvOf(res.headers);
    // MS-CV + timestamp let you correlate this failure with the APX server logs. APX logs the exact
    // eligibility reason ("WebSocket connect denied botKey=... reason=BotNotAllowed|Disabled|
    // NotConfigured|MissingBotKey") under this same cv. An empty-body 503 is the net472 connect stub
    // (WebSocketConnectController.NETFramework.cs) — the load balancer hit a non-net8 BFE instance.
    logError("negotiate <<", { dir: "APX->bot", result: "FAIL", status: res.status, diag, body: body || "(empty)" }, cv);
    throw new Error(`negotiate failed: HTTP ${res.status} ${diag} ${body}`);
  }

  const json = (await res.json()) as NegotiateResult;
  if (!json.url || !json.accessToken) {
    throw new Error("negotiate response missing url/accessToken");
  }
  logEvent("negotiate <<", { dir: "APX->bot", result: "OK", status: res.status, expiresIn: json.expiresIn }, cvOf(res.headers));
  return json;
}
