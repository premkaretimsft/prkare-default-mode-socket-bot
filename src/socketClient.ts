import {
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { negotiate } from "./negotiate";

// Builds a SignalR hub connection to the negotiated Azure SignalR URL and wires the inbound
// "Activity" client method (APX -> bot).
//
// Default mode delivers each invoke via *client results*: APX calls
// `InvokeAsync<InvokeReplyFrame>("Activity", envelope)` and awaits the return value, which the Azure
// SignalR Service routes back to the exact invoking pod by invocation id. So the registered handler
// RETURNS the reply frame and @microsoft/signalr sends it back as the invocation result — there is no
// separate `send`, no upstream webhook, and no correlation bookkeeping on either side.
export async function buildConnection(
  label: string,
  onActivity: (envelope: any) => Promise<unknown>
): Promise<{ connection: HubConnection; expiresIn: number }> {
  const neg = await negotiate();

  const conn = new HubConnectionBuilder()
    .withUrl(neg.url, { accessTokenFactory: () => neg.accessToken })
    .withAutomaticReconnect([0, 2000, 5000, 10000, 20000])
    .configureLogging(LogLevel.Warning)
    .build();

  // Returning a value (Promise) from this handler is what makes client results work — APX awaits it.
  conn.on("Activity", (envelope: any) => onActivity(envelope));
  conn.onreconnecting((e) => console.warn(`[${label}] reconnecting: ${e?.message ?? ""}`));
  conn.onreconnected((id) => console.log(`[${label}] reconnected: ${id ?? ""}`));
  conn.onclose((e) => console.warn(`[${label}] closed: ${e?.message ?? ""}`));

  await conn.start();
  console.log(`[${label}] connected to Azure SignalR (Default mode). expiresIn=${neg.expiresIn}s`);
  return { connection: conn, expiresIn: neg.expiresIn };
}
