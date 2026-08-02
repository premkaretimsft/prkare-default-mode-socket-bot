import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";
import * as inspector from "inspector";
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

// Max consecutive failed connect attempts before giving up (keeps the existing 1s..30s backoff timing).
// Set generously (20) because Canary load-balances the connect across net472 (503 stub) and net8
// (real direct-mint) BFE instances during the .NET Core rollout, so several retries can be needed
// before a request lands on a net8 instance.
const MAX_CONNECT_ATTEMPTS = 20;

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

// The Node inspector (debugger) port from --inspect=<port> in dev; undefined for `npm start`.
function getInspectPort(): number | undefined {
  for (const arg of process.execArgv) {
    const m = arg.match(/^--inspect(?:-brk)?(?:=(?:.*:)?(\d+))?$/);
    if (m) {
      return m[1] ? Number(m[1]) : 9229;
    }
  }
  return undefined;
}

// Force-kill any OTHER process currently LISTENING on `port` (an orphaned prior run) so the port is
// free to reuse. Cross-platform: Windows netstat+taskkill /F, *nix lsof+kill -9.
function killListenersOnPort(port: number): void {
  const self = String(process.pid);
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
      const pids = new Set<string>();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(new RegExp(`[:.]${port}\\b.*\\bLISTENING\\b\\s+(\\d+)\\s*$`, "i"));
        if (m && m[1] !== self) {
          pids.add(m[1]);
        }
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore", windowsHide: true });
          console.log(`[port] force-freed :${port} (killed PID ${pid})`);
        } catch {
          /* already gone */
        }
      }
    } else {
      const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN || true`, { encoding: "utf8" });
      for (const pid of out.split(/\s+/).filter(Boolean)) {
        if (pid !== self) {
          try {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
            console.log(`[port] force-freed :${port} (killed PID ${pid})`);
          } catch {
            /* already gone */
          }
        }
      }
    }
  } catch (e) {
    console.warn(`[port] could not inspect/free :${port}: ${(e as Error).message}`);
  }
}

// If a prior run still holds the inspector port, force-free it and re-open the debugger on it, so a
// relaunch never dies with "address already in use" and VS Code can still attach — no manual kill.
function freeInspectorPortIfBusy(): void {
  const port = getInspectPort();
  if (port === undefined) {
    return; // not launched with --inspect (e.g. `npm start`); nothing to manage
  }
  if (inspector.url()) {
    return; // our own inspector bound fine; the port was not contended
  }

  console.warn(`[inspector] port ${port} was busy at startup; force-freeing it from any prior run.`);
  killListenersOnPort(port);

  try {
    inspector.open(port, "127.0.0.1", false);
    console.log(`[inspector] reopened on 127.0.0.1:${port}`);
  } catch (e) {
    console.warn(`[inspector] could not reopen on ${port}: ${(e as Error).message}`);
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
  let failedAttempts = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let conn: HubConnection | undefined;
    try {
      const { connection, expiresIn } = await buildConnection(label, (env) => handleActivity(env));
      conn = connection;
      backoffMs = 0; // negotiate + connect succeeded — reset backoff
      failedAttempts = 0; // and reset the give-up counter for this fresh session
      console.log(`[${label}] ready (token ~${expiresIn}s). Awaiting invokes over client results.`);

      const renegotiateInMs = Math.max(60, expiresIn * config.renegotiateFraction) * 1000;
      const reason = await waitForRenegotiate(connection, renegotiateInMs);
      console.log(`[${label}] re-negotiating via APX (${reason})`);
    } catch (e) {
      failedAttempts += 1;
      if (failedAttempts >= MAX_CONNECT_ATTEMPTS) {
        console.error(
          `[${label}] connect via APX failed ${failedAttempts}/${MAX_CONNECT_ATTEMPTS} times; giving up: ${(e as Error).message}`
        );
        return;
      }
      // Negotiate (APX) or the initial connect failed — APX may be down/restarting. Back off and keep
      // retrying (1s, 2s, 4s, ... capped at 30s), up to MAX_CONNECT_ATTEMPTS.
      backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, 30000);
      console.error(
        `[${label}] connect via APX failed (attempt ${failedAttempts}/${MAX_CONNECT_ATTEMPTS}), retrying in ${backoffMs}ms: ${(e as Error).message}`
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
  freeInspectorPortIfBusy();

  console.log(
    `prkare-default-mode-socket-bot starting. apx=${config.apxBaseUrl} botKey=${config.botKey} ` +
      `defaultDirective=${config.defaultDirective}`
  );

  await manageConnection("conn1");

  // manageConnection only returns after MAX_CONNECT_ATTEMPTS failures — stop instead of looping forever.
  console.error(`[bot] stopped after ${MAX_CONNECT_ATTEMPTS} failed connection attempts. Exiting.`);
  process.exit(1);
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
