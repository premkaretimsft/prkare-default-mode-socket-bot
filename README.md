# prkare-default-mode-socket-bot

A minimal Teams bot **socket-mode test client** for exercising APX (`async_messaging_botapiservice`)
in **Azure SignalR DEFAULT mode** — an app-hosted hub plus **client results**. The bot opens an
outbound SignalR connection (negotiated through APX), receives invoke envelopes on the `Activity`
client method, and **returns** the reply. There is no public endpoint, no Teams manifest, and no
tunnel.

## How it works

```
Teams/INT test ──invoke──▶ APX BotNotifications (pod Pn)
                              │  resolve botKey→connectionId (Redis directory)
                              │  Clients.Client(connId).InvokeAsync<InvokeReplyFrame>("Activity", env)
                              ▼
                    Azure SignalR Service ──"Activity"──▶ this bot (owner pod Po's socket)
                              ▲                                │  handler returns InvokeReplyFrame
                              └────────client result──────────┘  (Service routes the completion
                                                                  back to the invoking pod Pn)
```

The whole point of Default mode: the bot's reply comes back to the **exact invoker pod** natively via
client results — the Azure SignalR Service correlates the completion by invocation id. So there is
**no Redis reply backplane, no upstream webhook, and no manual correlation** (contrast the serverless
test bot, which sent a separate `invokeResponse` frame up through a webhook). Redis is still used by
APX, but only as the `botKey → connectionId` **directory** the invoker pod reads to pick a target.

The bot's handler simply **returns** the reply:

```ts
connection.on("Activity", (envelope) => handleActivity(envelope)); // returns Promise<InvokeReplyFrame>
```

## Prerequisites

- **Node.js ≥ 18** (`fetch` and `@microsoft/signalr` v8 client results).
- A local **APX** build of the `user/prkare/socket-default-mode` branch, run from
  `BotNotificationsRole.ConsoleApp.NETCore` (net8 — client results is ASP.NET Core only).
- An **Azure SignalR** resource in **Default** service mode (the test resource `prkaretestsocket` is
  already switched to Default; the Upstream webhook is deleted — that was serverless-only).
- **Local Redis** for APX's connection directory (`.\start-local-redis.ps1`).
- For the F5 flow: **Teams Toolkit** (VS Code) or `@microsoft/teamsapp-cli`, signed into an M365
  account that can create an Entra app.

## APX-side setup (one time)

APX reads its socket config from environment variables, so no secret is committed. Set these for the
APX process (the SignalR connection string is a **secret** — never commit it):

```powershell
# Azure SignalR (Default mode) connection string — from the resource's Keys blade.
$env:APX_LOCAL_SIGNALR_CONNECTIONSTRING = "Endpoint=https://prkaretestsocket.service.signalr.net;AccessKey=<KEY>;Version=1.0;"

# Local Redis for the botKey -> connectionId directory.
$env:APX_LOCAL_REDIS_CONNECTIONSTRING = "localhost:6379"

# Force the socket path on locally without ECS flags (skips the SocketModeHubEnabled gate).
$env:APX_LOCAL_SIGNALR_ENABLED = "true"

# Optional: scope the socket path to just this bot during a focused run.
# $env:APX_LOCAL_SIGNALR_BOT_ALLOWLIST = "<this bot's MSA AppId>"
```

Then start Redis and run APX:

```powershell
.\start-local-redis.ps1
# run BotNotificationsRole.ConsoleApp.NETCore (net8) from Visual Studio / dotnet-free MSBuild output
```

## Run the bot

### Option A — F5 (Teams Toolkit, self-provisioning)

1. Open this folder in VS Code with Teams Toolkit installed.
2. Copy `env/.env.local.sample` → `env/.env.local` (leave `BOT_ID` empty to mint a new registration).
3. Press **F5** (or run the *Run Default-mode socket bot (local)* launch config). The toolkit:
   - validates prerequisites, runs `npm install`,
   - **provisions** a Microsoft Entra app (its client id becomes the socket `botKey`),
   - **deploys** the runtime env to `.localConfigs` (gitignored),
   - starts the bot (`npm run dev:teamsfx`).
4. Watch for `connected to Azure SignalR (Default mode)`.

### Option B — manual (`npm run dev`)

```powershell
npm install
copy .env.example .env
# set BOT_KEY to any GUID (the DEBUG local APX negotiate accepts ?botKey=<this> unauthenticated)
npm run dev
```

> The bot connects to the **Azure SignalR Service URL** returned by negotiate, not to APX directly.
> APX only mints the client token (and validates the bot in a non-DEBUG build).

## Driving scenarios — directives

Each invoke's behavior is driven by `payload.value.directive` (or `DEFAULT_DIRECTIVE` when absent), so
one bot exercises every path:

| directive | bot behavior | APX outcome |
|-----------|--------------|-------------|
| `ok` (default) | return `200` + the real invoke-response body for the invoke name | socket reply served; HTTP skipped |
| `error` | return `500` + error body | socket reply served (bot-reported failure) |
| `delay` | sleep `value.delayMs` (default `27000`) then return `200` | exceeds the 25s deadline → APX **timeout → HTTP fallback** |
| `drop` | never return (invocation stays pending) | APX hits its deadline → **timeout → HTTP fallback** |

The `ok` reply body is the same Bot Framework invoke-response shape an HTTP bot returns (see
`src/invokeResponses.ts`), so APX's `InvokeHelper.ProcessInvokeResponse` handles both transports
identically.

## Triggering an invoke

- **INT tests** (`async_messaging_botapi-tests`, branch `user/prkare/socket-default-mode-tests`) send
  an invoke for this bot's MSA AppId; or
- a **real Teams client** interacting with a messaging-extension/adaptive-card bot whose AppId matches
  this bot's `botKey`.

Watch the bot console for `[recv] <-- APX` and `[reply] --> APX (client result)`, and the APX log for
`Socket invoke SERVED botKey=… status=… -> bypassing HTTP.`

## The no-reroute proof (E1)

A single local pod can't prove the cross-pod reply path (the invoker pod **is** the owner pod). To
prove it: run **two** `BotNotificationsRole.ConsoleApp.NETCore` pods against the same Default-mode
resource **and the same local Redis directory**; this bot connects (owned by pod A); fire an invoke at
pod B; verify the reply returns to **B**. That demonstrates client results routing the completion home
without any backplane.

## Files

| Path | Purpose |
|------|---------|
| `src/config.ts` | Env-sourced config (`apxBaseUrl`, `botKey`, directive). |
| `src/negotiate.ts` | `POST /v3/websockets/connect` → `{ url, accessToken, expiresIn }`. |
| `src/socketClient.ts` | Builds the hub connection; registers the **returning** `Activity` handler. |
| `src/handler.ts` | Reads an invoke envelope and **returns** the `InvokeReplyFrame` (directive-driven). |
| `src/invokeResponses.ts` | Bot Framework invoke-response bodies per invoke name (HTTP-parity shapes). |
| `src/index.ts` | Single-instance guard + resilient negotiate/connect/re-negotiate loop. |
| `start-local-redis.ps1` | Portable local Redis for the APX connection directory. |
| `teamsapp*.yml`, `.vscode/`, `env/` | Teams Toolkit (M365 Agents Toolkit) F5 self-provision. |

## Security

- The Azure SignalR **connection string (AccessKey) is a secret** — it lives only in the APX process
  env, never in this repo.
- `.localConfigs`, `env/.env.local`, and `env/.env.local.user` hold provisioned secrets and are
  **gitignored**. Only the `*.sample` / `.env.example` templates are tracked.
