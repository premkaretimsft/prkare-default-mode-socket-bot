import {
  HubConnection,
  HubConnectionBuilder,
  LogLevel,
} from "@microsoft/signalr";
import { negotiate } from "./negotiate";
import { logEvent, logError } from "./log";

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
  // APX's BotHub.OnConnectedAsync sends this once the connection is registered in the bot's group.
  conn.on("SocketReady", (frame: any) =>
    logEvent("SocketReady <<", {
      conn: label,
      dir: "APX->bot",
      botKey: frame?.botKey ?? frame?.BotKey,
      connectionId: frame?.connectionId ?? frame?.ConnectionId,
    })
  );
  conn.onreconnecting((e) => logError("socket", { conn: label, event: "reconnecting", error: e?.message }));
  conn.onreconnected((id) => logEvent("socket", { conn: label, event: "reconnected", connectionId: id }));
  conn.onclose((e) => logError("socket", { conn: label, event: "closed", error: e?.message }));

  await conn.start();
  logEvent("socket", { conn: label, event: "connected", note: "Azure SignalR (Default mode)", expiresIn: neg.expiresIn });
  return { connection: conn, expiresIn: neg.expiresIn };
}
