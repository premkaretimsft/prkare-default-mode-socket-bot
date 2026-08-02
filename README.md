# Prkare Socket Test — APX Default-mode socket bot

A Teams bot that installs into Teams for a **1:1 chat**, but receives everything from **APX** over an
**Azure SignalR Default-mode socket** — so it exposes **no public messaging endpoint and no dev
tunnel**. It accepts invokes and one-way activities over the socket and responds there (SignalR
**client results**), and sends any outbound content over the existing **HTTP conversation API**, as
the socket-mode design intends.

Set up like a normal M365 Agents Toolkit bot: **F5 does all the registration** (Teams app + Entra app
+ Bot Framework) and opens Teams in the browser to install the app — minus the tunnel/endpoint steps.

---

## What it does

1. `POST {APX_BASE_URL}/v3/websockets/connect` (Canary: `https://canary.botapi.skype.com/amer`,
   authenticated with a real **Bot Framework JWT** minted from the bot's client secret) ->
   `{ url, accessToken, expiresIn }`.
2. Opens a SignalR WebSocket to the negotiated **Azure SignalR** `url` and joins the bot's group.
3. Receives APX->bot frames on the **`Activity`** client method (a `SocketActivityEnvelope`):
   - **invoke** (`type:"invoke"`) -> computes the Bot Framework invoke response and **returns** it as
     the client result (`protocolVersion` + `envelopeId` + `status` + `body`).
   - **one-way activity** (`ackRequired:true`) -> returns a minimal **delivery ack** (status 200);
     for a `message` it also sends a reply via the **HTTP conversation API** (`src/sendActivity.ts`).
4. Resilient (re-negotiates through APX on token expiry / socket close) and single-instance.

---

## End-to-end demo flow

The bot is wired to make the whole socket round-trip visible in the 1:1 chat:

1. **Send any message** (e.g. `hi`). It arrives as a one-way activity **over the socket**; the bot acks
   over the socket and replies with an **adaptive card over HTTP** (`invokeDemoCard`, `src/cards.ts`).
2. **Click a card button.** Each button fires an **invoke back to the bot over the socket**, and the bot
   responds **over the socket** (client result):
   - **🔄 Refresh card** (`Action.Execute` verb `refreshCard`) -> `adaptiveCard/action` invoke -> the bot
     returns an `AdaptiveCardInvokeResponse`; Teams re-renders the card **in place** (with a live click
     counter + timestamp), so you can see the socket response land.
   - **💬 Show message** (verb `showMessage`) -> a message-type invoke response (toast).
   - **⛔ Error response** (verb `errorAction`) -> a simulated-error message over the socket.
   - **🗔 Open dialog** (`Action.Submit` -> `task/fetch`) -> the bot returns a **task module** over the
     socket; submitting it fires `task/submit` (also over the socket).

Message replies stay on **HTTP**; invoke responses stay on the **socket** — exactly the socket-mode split.

---

## Logging (correlation)

Every call in/out of the bot logs one greppable line via `src/log.ts`:

```
[<ISO-8601 UTC>] [<tag>] key=value …  MS-CV=<cv>
```

Tags: `negotiate >>/<<` (connect), `recv <<` (inbound envelope), `reply >>` (socket client result),
`ack >>` (one-way ack), `reply-card >>/<<` + `http-send >>/<<` (outbound HTTP), `SocketReady <<`,
`socket` (connect/reconnect/close). Both **success and failure** are logged, and each carries the
**MS-CV** (from the inbound envelope, or the APX response headers on outbound HTTP) plus the timestamp —
copy them straight into the APX log search.



## Prerequisites

- **Node 18+**, VS Code + the **Microsoft 365 Agents Toolkit** extension, an M365 account with
  sideloading enabled.
- The bot's AppId **socket-eligible in APX Canary** (ECS `DeliverEventViaSocketBotAllowList`) and
  known to APX (APS) — the APX-side onboarding.
- APX Canary reachable with the **BotFrontEnd WebSocket connect** deployed
  (`https://canary.botapi.skype.com/amer/v3/websockets/connect`).

---

## Run it (F5)

1. Open the folder in VS Code.
2. Press **F5** and pick **Debug in Teams (Edge)** or **(Chrome)**. The `Start socket bot locally`
   task chain runs:
   - **Validate prerequisites** (Node, M365 sign-in, port 9239),
   - **npm install**,
   - **Provision** (`teamsapp provision --env local`) — creates the Teams app, the Entra app
     (client id = bot id / socket botKey, + client secret), and the Bot Framework registration
     (**placeholder** messaging endpoint — never called in socket mode),
   - **Deploy** — writes runtime env to `.localConfigs`,
   - **Start application** (`npm run dev:teamsfx`) — negotiates with APX and opens the socket.
3. The browser opens Teams and installs the app; start a **1:1 chat** with **Prkare Socket Test**.

There is **no dev tunnel and no messaging endpoint** — the bot is reachable only via its outbound
socket to Azure SignalR.

### Manual run (no Teams UI)

```bash
npm install
# set BOT_ID / BOT_PASSWORD / BOT_TENANT_ID / APX_BASE_URL in .localConfigs (or provision once), then:
npm run build && npm run dev:teamsfx
```

Expected: `prkare-default-mode-socket-bot starting. apx=https://canary.botapi.skype.com/amer botKey=<appId> ...`
then `[conn1] connected to Azure SignalR (Default mode).` and `SocketReady from APX`.

---

## Configuration

`env/.env.local` (F5) / `.localConfigs` (generated by deploy):

| var | meaning |
|---|---|
| `APX_BASE_URL` | APX connect host + region. Canary: `https://canary.botapi.skype.com/amer`. Local DEBUG APX: `https://localhost:444`. |
| `BOT_ID` | the bot's MSA AppId = socket botKey. On Canary the key is derived from the validated token. |
| `BOT_PASSWORD` | the bot's client secret (provisioned as `SECRET_BOT_PASSWORD`). Required for the authenticated Canary connect. |
| `BOT_TENANT_ID` | the bot's home tenant (single-tenant Entra app) = the Bot Framework token issuer APX validates. Also the tenant put in the connect path when `TENANT_IN_PATH=true`. |
| `TENANT_IN_PATH` | `true` (default) = connect via the tenantized route `{cloud}/{tenantId}/v3/websockets/connect` so APX's `TenantIdInPathFilter` sets `ctx.TenantId` before the socket-eligibility check (a bot token carries no tenant, and a connect has no conversation). Needed for tenant-scoped `DeliverEventViaSocketEnabled` to match. `false` = plain route (use if the ring lacks `TenantIdInPathRoutesEnabled`, or for local DEBUG). |
| `TEAMS_APP_ID` | the Teams app id (provisioned); used by the F5 launch URL. |
| `DEFAULT_DIRECTIVE` | behavior when an invoke/activity carries no `value.directive` (ok/error/delay/drop). |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` = validate TLS (Canary); `0` = accept a self-signed local APX dev cert. Must be non-empty for the toolkit. |

Secrets (`SECRET_BOT_PASSWORD`) live in `env/.env.local.user` (gitignored, encrypted by the toolkit).

---

## Wire contract (kept in sync with APX `Library/Services`)

- Client method **`Activity`**; replies via **client results** (return value), not a separate send.
- Every reply frame carries **`protocolVersion: 1`** (`SocketProtocol.CurrentVersion`) — APX rejects a
  mismatch as `ProtocolMismatch`.
- One-way activities (`ackRequired`) get a status-200 ack; invokes get `{ status, body }`.
- Outbound content sends stay on **HTTP** (`/v3/conversations/{id}/activities`), never the socket.

---

## Notes

- The `messagingEndpoint` in the Bot Framework registration is a placeholder — socket mode never uses
  it. APX delivery uses the socket when the bot is socket-eligible and connected.
- Routing your Teams session's bot traffic to APX **Canary** (flighting) is an environment concern.
