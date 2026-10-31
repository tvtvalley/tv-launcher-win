// Swaps in a launcher app.asar that was downloaded as `app.asar.next`.
//
// Windows keeps the running app.asar mapped by the Electron process, so the
// patcher can never overwrite it while the launcher is up. Instead the update
// manifest ships `Launcher/resources/app.asar.next`; on quit this starts a
// detached script that waits for the process to go away, renames the old asar
// aside and moves the new one into place, so the next start runs the new UI.
//
// Same idea as selfupdate.js uses for Launcher.exe itself.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const NEXT = 'app.asar.next';
const OLD = 'app.asar.old';

function pendingPath(resourcesPath) {
  return path.join(resourcesPath, NEXT);
}

function hasPending(resourcesPath) {
  try {
    return fs.statSync(pendingPath(resourcesPath)).size > 0;
  } catch {
    return false;
  }
}

// Writes the helper script and starts it detached. Windows only (the game is
// Windows-only); elsewhere it just renames what it can.
function trace(line) {
  try {
    fs.appendFileSync(path.join(os.tmpdir(), 'tv-asar-swap.log'),
                      `${new Date().toISOString()} ${line}\r\n`);
  } catch {}
}

function finishOnExit(resourcesPath, log = () => {}) {
  trace(`finishOnExit resources=${resourcesPath} pending=${hasPending(resourcesPath)}`);
  if (!hasPending(resourcesPath)) return false;

  const target = path.join(resourcesPath, 'app.asar');
  const next = pendingPath(resourcesPath);
  const old = path.join(resourcesPath, OLD);

  if (process.platform !== 'win32') {
    // Non-Windows platforms (macOS/Linux) run native builds.
    // The server update manifest delivers a Windows app.asar.next, which must NEVER
    // overwrite the native app bundle! Clean it up if staged here.
    try { fs.unlinkSync(next); } catch {}
    return false;
  }

  const script = path.join(os.tmpdir(), `tv-asar-swap-${process.pid}.cmd`);
  const q = (p) => `"${p}"`;
  const body = [
    '@echo off',
    'setlocal',
    `:wait`,
    `move /y ${q(target)} ${q(old)} >nul 2>&1`,
    `if errorlevel 1 (`,
    `  ping -n 2 127.0.0.1 >nul`,
    `  goto wait`,
    `)`,
    `move /y ${q(next)} ${q(target)} >nul 2>&1`,
    `del ${q(old)} >nul 2>&1`,
    `del "%~f0" >nul 2>&1`,
    '',
  ].join('\r\n');

  try {
    fs.writeFileSync(script, body, 'utf8');
    const child = spawn('cmd.exe', ['/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    trace(`swap scheduled via ${script}`);
    log(`launcher app.asar: swap scheduled (${next})`);
    return true;
  } catch (err) {
    trace(`scheduling failed: ${err.message}`);
    log(`launcher app.asar: couldn't schedule the swap: ${err.message}`);
    return false;
  }
}

module.exports = { hasPending, finishOnExit, pendingPath };

if (require.main === module) {
  // `node asarSwap.js <resources dir>` for testing
  const dir = process.argv[2] || '.';
  console.log(finishOnExit(dir, console.log) ? 'scheduled' : 'nothing to do');
}
