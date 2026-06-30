import { config } from "./config";

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
  const url = new URL("/v3/websockets/connect", config.apxBaseUrl);
  if (config.botKey) {
    url.searchParams.set("botKey", config.botKey);
  }

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-length": "0" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`negotiate failed: HTTP ${res.status} ${body}`);
  }

  const json = (await res.json()) as NegotiateResult;
  if (!json.url || !json.accessToken) {
    throw new Error("negotiate response missing url/accessToken");
  }
  return json;
}
