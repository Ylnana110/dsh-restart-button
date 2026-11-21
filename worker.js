/**
 * PowerShell programs used by the restart bridge.
 *
 * The launcher is short-lived and only starts the worker through WMI, which
 * makes the worker's parent the WMI provider host instead of this Harness
 * process. The worker therefore survives the shutdown it performs.
 */

/** How long the worker waits for the Host to confirm it answered the browser. */
export const GO_TIMEOUT_MS = 12000;

/**
 * Turn a PowerShell program into the argument of `-EncodedCommand`.
 * @param source - UTF-8 PowerShell source.
 * @returns base64 of the UTF-16LE encoding PowerShell expects.
 */
export function encodeCommand(source) {
  return Buffer.from(source, 'utf16le').toString('base64');
}

/**
 * Quote one value for a single-quoted PowerShell literal.
 * @param value - text to embed.
 * @returns the literal, quotes included.
 */
export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the detached worker program.
 *
 * With `facts.relaunch` false the worker only stops the application and its
 * Host, which is the quit action; otherwise it starts the application again.
 * @param files - marker, go, and log paths.
 * @param facts - process identities and launch facts.
 * @returns the program source.
 */
export function workerProgram(files, facts) {
  const mainPid = String(facts.mainPid);
  const hostPid = String(facts.hostPid);
  const relaunch = facts.relaunch === false ? '0' : '1';
  return `$ErrorActionPreference = 'Continue'
$log = ${literal(files.log)}
function Write-Log([string]$message) {
  try { Add-Content -LiteralPath $log -Value ('[{0}] {1}' -f (Get-Date).ToString('o'), $message) -Encoding UTF8 } catch {}
}
$mainPid = ${mainPid}
$hostPid = ${hostPid}
$executable = ${literal(facts.executable)}
$appDir = ${literal(facts.appDir)}
$port = ${String(facts.port)}
$marker = ${literal(files.marker)}
$go = ${literal(files.go)}
$relaunch = ${relaunch}
Write-Log ('worker started pid=' + $PID + ' relaunch=' + $relaunch)
try { Set-Content -LiteralPath $marker -Value 'ready' -Encoding ASCII } catch {}
$commandLine = $null
try { $commandLine = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $mainPid) -ErrorAction Stop).CommandLine } catch {}
Write-Log ('application command line: ' + $commandLine)
$deadline = (Get-Date).AddMilliseconds(${String(GO_TIMEOUT_MS)})
while (-not (Test-Path -LiteralPath $go)) {
  if ((Get-Date) -gt $deadline) { Write-Log 'no confirmation; leaving the application alone'; exit 2 }
  Start-Sleep -Milliseconds 100
}
Write-Log 'confirmed by the Host'
Start-Sleep -Milliseconds 700
& taskkill.exe /PID $mainPid /T /F 2>$null | Out-Null
Write-Log 'stopped the application process tree'
Start-Sleep -Milliseconds 400
if (Get-Process -Id $hostPid -ErrorAction SilentlyContinue) {
  & taskkill.exe /PID $hostPid /T /F 2>$null | Out-Null
  Write-Log 'stopped the Host process tree'
}
if ($relaunch -eq 0) {
  Start-Sleep -Milliseconds 1200
  $left = @(Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($executable)) -ErrorAction SilentlyContinue)
  Write-Log ('application stopped; remaining processes: ' + $left.Count)
  exit 0
}
if ($port -gt 0) {
  $until = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $until) {
    $listening = $null
    try { $listening = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop) } catch { $listening = $null }
    if ($null -eq $listening) { break }
    if ($listening.Count -eq 0) { break }
    Start-Sleep -Milliseconds 250
  }
  Write-Log 'listening port released or wait expired'
}
$name = [System.IO.Path]::GetFileNameWithoutExtension($executable)
$started = $false
for ($attempt = 1; $attempt -le 4; $attempt++) {
  try {
    if ($commandLine) {
      Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine; CurrentDirectory = $appDir } | Out-Null
    } else {
      Start-Process -FilePath $executable -WorkingDirectory $appDir
    }
  } catch { Write-Log ('launch attempt ' + $attempt + ' failed: ' + $_) }
  Start-Sleep -Seconds 2
  if (@(Get-Process -Name $name -ErrorAction SilentlyContinue).Count -gt 0) {
    $started = $true
    Write-Log ('application started on attempt ' + $attempt)
    break
  }
}
if (-not $started) { Write-Log 'the application did not start' }
`;
}

/**
 * Quote one value for a POSIX shell word.
 * @param value - text to embed.
 * @returns the single-quoted word.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Build the detached worker for macOS.
 *
 * It runs in its own session, so killing the application's process tree does
 * not reach it. The tree walk skips the worker's own PID because the worker is
 * still a child of the Host until that process dies.
 * @param files - marker, go, and log paths.
 * @param facts - process identities and launch facts.
 * @returns the shell program source.
 */
export function posixWorkerProgram(files, facts) {
  const mainPid = String(facts.mainPid);
  const hostPid = String(facts.hostPid);
  const port = String(facts.port);
  const relaunch = facts.relaunch === false ? '0' : '1';
  return `#!/bin/sh
LOG=${shellQuote(files.log)}
MAIN_PID=${mainPid}
HOST_PID=${hostPid}
EXE=${shellQuote(facts.executable)}
APP_BUNDLE=${shellQuote(facts.appBundle ?? '')}
PORT=${port}
RELAUNCH=${relaunch}
MARKER=${shellQuote(files.marker)}
GO=${shellQuote(files.go)}
log() { printf '[%s] %s\\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG" 2>/dev/null; }
log "worker started pid=$$ relaunch=$RELAUNCH"
: > "$MARKER" 2>/dev/null
if [ "$RELAUNCH" = "1" ]; then
  if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
    :
  elif [ -x "$EXE" ]; then
    :
  else
    log 'relaunch target missing; leaving the application alone'
    exit 3
  fi
fi
i=0
while [ ! -e "$GO" ]; do
  i=$((i + 1))
  if [ "$i" -gt 120 ]; then
    log 'no confirmation; leaving the application alone'
    exit 2
  fi
  sleep 0.1
done
log 'confirmed by the Host'
sleep 0.7
kill_tree() {
  for child in $(ps -axo pid=,ppid= | awk -v parent="$1" '$2 == parent { print $1 }'); do
    if [ "$child" != "$$" ]; then
      kill_tree "$child"
    fi
  done
  kill -9 "$1" 2>/dev/null
}
kill -TERM "$MAIN_PID" 2>/dev/null
sleep 0.5
kill_tree "$MAIN_PID"
log 'stopped the application process tree'
kill_tree "$HOST_PID"
log 'stopped the Host process tree'
if [ "$RELAUNCH" = "0" ]; then
  sleep 1.2
  log 'application stopped'
  exit 0
fi
if [ "$PORT" != "0" ]; then
  i=0
  while [ "$i" -lt 80 ]; do
    if ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
    i=$((i + 1))
  done
  log 'listening port released or wait expired'
fi
started=0
for attempt in 1 2 3 4; do
  if [ -n "$APP_BUNDLE" ] && [ -d "$APP_BUNDLE" ]; then
    open -n "$APP_BUNDLE" >/dev/null 2>&1
  else
    nohup "$EXE" >/dev/null 2>&1 &
  fi
  sleep 2
  if pgrep -f "$EXE" >/dev/null 2>&1; then
    started=1
    log "application started on attempt $attempt"
    break
  fi
done
if [ "$started" = "0" ]; then
  log 'the application did not start'
fi
`;
}

/**
 * Build the short-lived launcher program.
 *
 * The worker is created with `Win32_ProcessStartup.ShowWindow = 0`: a console
 * process started through WMI otherwise gets a visible console window, and
 * PowerShell's own `-WindowStyle Hidden` only hides it after that window was
 * already shown.
 * @param worker - the worker program source.
 * @returns the launcher program source.
 */
export function launcherProgram(worker) {
  const encoded = encodeCommand(worker);
  return `$ErrorActionPreference = 'Stop'
$powershell = Join-Path $PSHOME 'powershell.exe'
$command = '"' + $powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'
$processClass = [wmiclass]'Win32_Process'
$startupClass = [wmiclass]'Win32_ProcessStartup'
$startup = $startupClass.CreateInstance()
$startup.ShowWindow = 0
$result = $processClass.Create($command, $null, $startup)
if ($result.ReturnValue -ne 0) { exit 1 }
`;
}
