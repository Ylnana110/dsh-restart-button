/**
 * Host half of the restart button.
 *
 * It serves three local routes for the Web GUI and, on request, starts one small
 * helper outside the application's process tree. The helper waits for the
 * browser to receive its answer, stops the application and Host process trees,
 * and then either starts the application again or leaves it stopped. Windows
 * uses a PowerShell worker created through WMI; macOS uses a POSIX shell worker
 * in its own session. In a plain `dsh web` process the routes stay reachable but
 * the actions report themselves as unsupported: nothing would start the server
 * again.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeCommand, launcherProgram, posixWorkerProgram, workerProgram } from './worker.js';

/** The Host this plugin runs in must own the browser HTTP carrier. */
export const inject = ['webServer'];

const STATUS_PATH = '/dsh-restart/status';
const RESTART_PATH = '/dsh-restart/restart';
const QUIT_PATH = '/dsh-restart/quit';

/** How long the Host waits for the detached helper to announce itself. */
const LAUNCH_TIMEOUT_MS = 8000;

/** Absolute launcher path, so a trimmed PATH cannot prevent the restart. */
const POWERSHELL = process.env.SystemRoot === undefined
  ? 'powershell.exe'
  : join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** Whether this Host can restart the Desktop application. */
function desktopHost() {
  return (process.platform === 'win32' || process.platform === 'darwin') && typeof process.send === 'function';
}

/**
 * Read the `.app` bundle containing one macOS executable.
 * @param executable - absolute path of the running executable.
 * @returns the bundle path, or an empty string outside a bundle.
 */
function appBundleOf(executable) {
  const match = /^(.+?\.app)\/Contents\/MacOS\//.exec(executable);
  return match === null ? '' : match[1];
}

/**
 * Write one JSON answer on a Node server response.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Whether the request may drive the restart route.
 *
 * The Desktop shell strips `Origin` while forwarding on the application's own
 * authenticated protocol, so a missing Origin is inside the app. A browser
 * request must come from the page's own origin and carry the plugin's header,
 * which turns a cross-site POST into a preflighted request this route never
 * grants.
 * @param req - incoming request.
 * @returns whether the caller is the application page.
 */
function isApplicationRequest(req) {
  if (req.headers['x-dsh-restart-request'] !== '1') return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === 'dsh-app://app') return true;
  if (typeof req.headers.host !== 'string') return false;
  return origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

/**
 * Read the port of this Host's listener, or 0 when it is unknown.
 * @param ctx - plugin context.
 * @returns the listening port.
 */
function listenerPort(ctx) {
  try {
    const port = Number(new URL(ctx.webServer.getOrigin()).port);
    return Number.isSafeInteger(port) && port > 0 ? port : 0;
  } catch {
    return 0;
  }
}

/**
 * Poll for a file until it appears or the deadline passes.
 * @param file - absolute path.
 * @param timeoutMs - budget.
 * @returns whether the file appeared.
 */
async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return existsSync(file);
}

/**
 * Start one detached worker for the current request.
 * @param ctx - plugin context.
 * @param options - `relaunch: false` quits without starting the application again.
 * @returns status and body reported to the page.
 */
async function startPower(ctx, options) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(tmpdir(), `dsh-restart-${process.pid}-${stamp}`);
  const files = {
    marker: join(dir, 'launcher.ready'),
    go: join(dir, 'restart.go'),
    log: join(dir, 'restart.log'),
  };
  mkdirSync(dir, { recursive: true });
  const facts = {
    mainPid: process.ppid,
    hostPid: process.pid,
    executable: process.execPath,
    appDir: dirname(process.execPath),
    appBundle: appBundleOf(process.execPath),
    port: listenerPort(ctx),
    relaunch: options.relaunch !== false,
  };
  writeFileSync(files.log, '', 'utf8');
  const note = (text) => {
    try {
      appendFileSync(files.log, `${text}\n`, 'utf8');
    } catch {
      // The response still reports the failure without the note.
    }
  };
  if (process.platform === 'darwin') {
    // Without a way to start the app again, a restart would leave it closed.
    if (facts.relaunch && facts.appBundle === '' && !existsSync(facts.executable)) {
      return { status: 409, body: { ok: false, reason: 'unsupported' } };
    }
    const script = join(dir, 'worker.sh');
    writeFileSync(script, posixWorkerProgram(files, facts), { mode: 0o700 });
    const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' });
    child.on('error', (error) => note(`worker spawn failed: ${error instanceof Error ? error.message : String(error)}`));
    child.unref();
  } else {
    // A detached Windows spawn starts the process with DETACHED_PROCESS, which
    // makes PowerShell 5.1 exit immediately without running the script. The
    // launcher only needs about a second, and the worker it creates through WMI
    // is the process that must survive, so this child stays attached.
    const launcher = launcherProgram(workerProgram(files, facts));
    const child = spawn(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encodeCommand(launcher)],
      { stdio: 'ignore', windowsHide: true },
    );
    child.on('error', (error) => note(`launcher spawn failed: ${error instanceof Error ? error.message : String(error)}`));
    child.on('exit', (code, signal) => note(`launcher exited code=${String(code)} signal=${String(signal)}`));
    child.unref();
  }
  const ready = await waitForFile(files.marker, LAUNCH_TIMEOUT_MS);
  if (!ready) return { status: 503, body: { ok: false, reason: 'launcher', log: files.log } };
  setTimeout(() => {
    try {
      writeFileSync(files.go, 'go', 'utf8');
    } catch {
      // The worker times out and leaves the application alone.
    }
  }, 150);
  return { status: 200, body: { ok: true, log: files.log } };
}

/**
 * Register the routes the Web GUI uses.
 * @param ctx - plugin context with `webServer`.
 */
export function apply(ctx) {
  let busy = false;
  const power = (relaunch) => async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, { ok: false, reason: 'method' });
      return;
    }
    if (!isApplicationRequest(req)) {
      sendJson(res, 403, { ok: false, reason: 'forbidden' });
      return;
    }
    if (!desktopHost()) {
      sendJson(res, 409, { ok: false, reason: 'unsupported' });
      return;
    }
    if (busy) {
      sendJson(res, 429, { ok: false, reason: 'pending' });
      return;
    }
    busy = true;
    // A helper that never stops the application must not wedge every later
    // attempt: the page may retry once the deadline passes.
    const release = setTimeout(() => { busy = false; }, 30000);
    try {
      const outcome = await startPower(ctx, { relaunch });
      if (outcome.body.ok !== true) busy = false;
      sendJson(res, outcome.status, outcome.body);
    } catch (error) {
      busy = false;
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { ok: false, reason: 'failed', message });
    } finally {
      release.unref?.();
    }
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.setHeader('allow', 'GET, HEAD');
        sendJson(res, 405, { ok: false, reason: 'method' });
        return;
      }
      sendJson(res, 200, {
        supported: desktopHost(),
        platform: process.platform,
        desktop: desktopHost(),
        quit: desktopHost(),
      });
    },
  }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: RESTART_PATH, handler: power(true) }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: QUIT_PATH, handler: power(false) }));
}
