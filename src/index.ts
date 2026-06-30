import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { config } from "./config";
import { buildConnection } from "./socketClient";
import { handleActivity } from "./handler";
import type { HubConnection } from "@microsoft/signalr";

// Single-instance guard. An orphaned bot process survives APX restarts (resilient reconnect) and
// would keep an extra connection registered in APX's directory — so an invoke could target the stale
// socket. Closing a terminal doesn't always kill a detached node, and the --inspect port then just
// collides while the orphan keeps its socket. A PID lockfile fixes it: on startup SIGTERM any prior
// instance, then claim the lock.
const LOCK_FILE = path.join(os.tmpdir(), "prkare-default-mode-socket-bot.lock");

async function enforceSingleInstance(): Promise<void> {
  try {
    let killed = false;
    if (fs.existsSync(LOCK_FILE)) {
      const prev = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (prev && prev !== process.pid) {
        try {
          process.kill(prev, 0); // throws if the process is already gone (stale lock)
          process.kill(prev, "SIGTERM");
          killed = true;
          console.log(`[singleton] killed prior bot instance PID ${prev}`);
        } catch {
          /* stale lockfile — prior process already exited */
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    if (killed) {
      await sleep(300); // let the old socket fully close on Azure SignalR before we connect
    }
  } catch (e) {
    console.warn(`[singleton] could not enforce single instance: ${(e as Error).message}`);
  }
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE) && fs.readFileSync(LOCK_FILE, "utf8").trim() === String(process.pid)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {
    /* ignore */
  }
}

// Keeps one socket connection alive indefinitely and resilient to APX being unavailable.
//
// The data socket is to Azure SignalR, negotiated THROUGH APX (POST /v3/websockets/connect). A brief
// APX restart therefore does NOT drop the socket — APX is only needed to (re)negotiate: on cold
// start, at token expiry, or after the SignalR socket closes for good. This loop:
//   * retries the APX negotiate with exponential backoff (1s..30s) until APX is reachable,
//   * re-negotiates immediately when the live socket closes (auto-reconnect exhausted / token
//     rejected) instead of waiting out the expiry timer,
//   * relies on SignalR's withAutomaticReconnect for fast recovery of transient drops.
async function manageConnection(label: string): Promise<void> {
  let backoffMs = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let conn: HubConnection | undefined;
    try {
      const { connection, expiresIn } = await buildConnection(label, (env) => handleActivity(env));
      conn = connection;
      backoffMs = 0; // negotiate + connect succeeded — reset backoff
      console.log(`[${label}] ready (token ~${expiresIn}s). Awaiting invokes over client results.`);

      const renegotiateInMs = Math.max(60, expiresIn * config.renegotiateFraction) * 1000;
      const reason = await waitForRenegotiate(connection, renegotiateInMs);
      console.log(`[${label}] re-negotiating via APX (${reason})`);
    } catch (e) {
      // Negotiate (APX) or the initial connect failed — APX may be down/restarting. Back off and keep
      // retrying until APX answers (1s, 2s, 4s, ... capped at 30s).
      backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, 30000);
      console.error(
        `[${label}] connect via APX failed (APX unavailable?), retrying in ${backoffMs}ms: ${(e as Error).message}`
      );
      await sleep(backoffMs);
    } finally {
      try {
        await conn?.stop();
      } catch {
        /* ignore */
      }
    }
  }
}

// Resolves when the token nears expiry OR the connection closes for good (whichever first), so an
// exhausted auto-reconnect triggers a fresh APX negotiate right away.
function waitForRenegotiate(conn: HubConnection, renegotiateInMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reason);
    };
    const timer = setTimeout(() => finish("token near expiry"), renegotiateInMs);
    conn.onclose((err) => finish(err ? `socket closed: ${err.message}` : "socket closed"));
  });
}

async function main(): Promise<void> {
  if (!config.botKey) {
    console.error(
      "Bot identity is required: set BOT_ID (filled by Teams Toolkit provision) or BOT_KEY in .env / " +
        ".localConfigs. Exiting."
    );
    process.exit(1);
  }

  await enforceSingleInstance();

  console.log(
    `prkare-default-mode-socket-bot starting. apx=${config.apxBaseUrl} botKey=${config.botKey} ` +
      `defaultDirective=${config.defaultDirective}`
  );

  await manageConnection("conn1");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

process.on("exit", releaseLock);
process.on("SIGINT", () => {
  console.log("\nShutting down.");
  releaseLock();
  process.exit(0);
});
process.on("SIGTERM", () => {
  releaseLock();
  process.exit(0);
});

void main();
