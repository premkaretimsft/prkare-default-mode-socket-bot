// Minimal config for the Default-mode socket test bot. All values come from env (see .env.example
// / .localConfigs). Nothing Teams-specific here — this bot exists only to exercise APX Default-mode
// socket invokes (Azure SignalR app-hosted hub + client results) against a local APX instance.

export const config = {
  // Base URL of the local APX BotNotifications role — the negotiate endpoint
  // /v3/websockets/connect lives there. 444 is the BotNotifications port in the standard local INT
  // config (BotFrontEnd is 443). The WSS URL the bot actually connects to is returned by negotiate
  // (it points at the Azure SignalR Service; APX itself only mints the token).
  apxBaseUrl: process.env.APX_BASE_URL || "https://localhost:444",

  // The bot's MSA AppId = the socket "botKey". APX stamps it as the hub connection's UserId so its
  // connection directory can resolve botKey -> connectionId for the client-results invoke. Teams
  // Toolkit provision fills BOT_ID (the created Entra app's client id); BOT_KEY is the fallback for a
  // manual `npm run dev`. In a DEBUG local APX build the negotiate endpoint accepts ?botKey=<this>
  // without auth.
  botKey: process.env.BOT_ID || process.env.BOT_KEY || "",

  // Re-negotiate at this fraction of the token lifetime (make-before-break-lite).
  renegotiateFraction: Number(process.env.RENEGOTIATE_FRACTION || 0.8),

  // Behavior when an invoke carries no explicit directive in payload.value.directive.
  // One of: ok | error | delay | drop.
  defaultDirective: (process.env.DEFAULT_DIRECTIVE || "ok").toLowerCase(),
};
