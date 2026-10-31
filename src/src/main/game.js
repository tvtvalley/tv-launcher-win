// Finds the game client and starts it from the game folder, with GAME_SERVER
// and LOGIN_TOKEN in the environment (read by toontown/launcher/QuickLauncher.py),
// and gives it another play token when it asks (PlayTokenRequests):
// ToonValley.exe in a player's game folder (tools/build_game_exe.py), or, in
// a checkout, `<python> -m toontown.launcher.QuickStartLauncher` the way
// win32/start_game.bat and linux/start-game.sh do.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { RETRYABLE } = require('./line');

// Files the client needs; their absence means the game folder is wrong or
// incomplete.
// On Windows the game exe runs directly; on Linux/macOS it runs under Wine.
// ToonValleyStub.exe (our runtime, stdlib on disk) wins when present.
const GAME_EXE = {
  win32: ['ToonValleyStub.exe', 'ToonValley.exe'],
  linux: ['ToonValleyStub.exe', 'ToonValley.exe'],
  darwin: ['ToonValleyStub.exe', 'ToonValley.exe'],
};
// The stub runs the game on a CPython we ship (runtime/python313.zip plus
// python313._pth) instead of the stdlib frozen into the original exe; without
// those two the stub exits before the game starts.
const STUB_EXE = 'ToonValleyStub.exe';
const STUB_REQUIRED_FILES = [
  ['python313._pth', 'the game runtime (python313._pth)'],
  ['runtime/python313.zip', 'the game runtime (runtime/python313.zip)'],
];
const EXE_REQUIRED_FILES = [
  ['phase_3.mf', 'the game resources (phase_3.mf)'],
];
const REQUIRED_FILES = [
  ['toontown/launcher/QuickStartLauncher.py', 'the game code (toontown/)'],
  ['otp/launcher/LauncherBase.py', 'the game code (otp/)'],
  ['etc/Configrc.prc', 'the client configuration (etc/Configrc.prc)'],
  ['etc/toon.dc', 'the network definitions (etc/toon.dc)'],
  ['resources/phase_3/models/gui/toonvalley.ico', 'the game resources (resources/)'],
];

class GameError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function defaultGameDir({ packaged, appPath, execPath, resourcesPath, platform = process.platform }) {
  // From source the launcher lives in <game>/launcher. A packaged launcher
  // either carries the game itself (the full installer puts it in
  // resources/game, see tools/make_client_bundle.py) or is installed inside
  // (or next to) the game folder: a built game (ToonValley.exe and its
  // phase files) or a checkout.
  if (!packaged) return path.resolve(appPath, '..');
  const exeDir = path.dirname(execPath);
  const candidates = [exeDir, path.dirname(exeDir), path.resolve(exeDir, '..', '..')];
  if (platform === 'darwin') {
    candidates.push(path.resolve(exeDir, '..', '..', '..'));
    candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'Toon Valley'));
    candidates.push(path.join(os.homedir(), 'Games', 'Toon Valley'));
  }
  if (resourcesPath) candidates.unshift(path.join(resourcesPath, 'game'));
  // a game installed inside a Wine/Proton prefix (the usual Linux case)
  try {
    const games = path.join(os.homedir(), 'Games');
    for (const prefix of fs.readdirSync(games)) {
      const users = path.join(games, prefix, 'drive_c', 'users');
      let names = [];
      try {
        names = fs.readdirSync(users);
      } catch {
        continue;
      }
      for (const user of names) {
        candidates.push(path.join(users, user, 'AppData', 'Local', 'Programs', 'Toon Valley'));
      }
    }
  } catch {
    // no ~/Games
  }
  for (const candidate of candidates) {
    if (gameExe(candidate, platform) || gameExe(candidate, 'win32')) return candidate;
    if (fs.existsSync(path.join(candidate, REQUIRED_FILES[0][0]))) return candidate;
  }
  return exeDir;
}

// Where the patcher installs the game when updates are on. On Windows, the
// folder the installer put Launcher.exe in (exePath, the player's pick; it
// has uninstall.exe beside it), so the game lives next to the launcher, as
// with TTR; a Launcher.exe run from anywhere else (Downloads, say) uses the
// installer's usual folder. Elsewhere, Game in the launcher's own folder.
function installDir({ platform = process.platform, exePath, localAppData, appData, userData, exists = fs.existsSync }) {
  if (platform !== 'win32') return path.join(userData, 'Game');
  if (exePath && exists(path.join(path.dirname(exePath), 'uninstall.exe'))) return path.dirname(exePath);
  return path.join(localAppData || appData, 'Programs', 'Toon Valley');
}

// The built game's executable in gameDir, or null for a checkout.
// The stub is only usable with the CPython it loads (python313._pth and
// runtime/python313.zip).  An install mid-update, or one published before
// those files existed, still has the standalone ToonValley.exe, so fall back
// to it instead of refusing to play.
function stubRuntimePresent(gameDir) {
  return STUB_REQUIRED_FILES.every(([file]) => fs.existsSync(path.join(gameDir, file)));
}

function gameExe(gameDir, platform = process.platform) {
  for (const name of GAME_EXE[platform] || ['ToonValley']) {
    const exe = path.join(gameDir, name);
    if (!fs.existsSync(exe)) continue;
    if (name === STUB_EXE && !stubRuntimePresent(gameDir)) continue;
    return exe;
  }
  return null;
}

function checkGameFiles(gameDir, platform = process.platform) {
  if (!gameDir || !fs.existsSync(gameDir) || !fs.statSync(gameDir).isDirectory()) {
    return { ok: false, missing: ['the game folder'], message: 'The game folder could not be found. Choose it in Settings.' };
  }
  const exe = gameExe(gameDir, platform);
  let required = exe ? EXE_REQUIRED_FILES : REQUIRED_FILES;
  if (!exe && fs.existsSync(path.join(gameDir, STUB_EXE))) {
    // only the stub is there and it cannot run without its runtime
    required = EXE_REQUIRED_FILES.concat(STUB_REQUIRED_FILES);
  }
  const missing = required.filter(([file]) => !fs.existsSync(path.join(gameDir, file))).map(([, what]) => what);
  if (missing.length) {
    return {
      ok: false,
      missing,
      message: `The game folder is missing ${missing.join(', ')}. Check the folder in Settings, or download the game again.`,
    };
  }
  return { ok: true, missing: [] };
}

// The Python that runs the game: the one bundled with the game by the full
// installer, then, as the start scripts do, the venv made by the
// build-Panda3D scripts and the Panda3D SDK path in PPYTHON_PATH.
function findPython(gameDir, override, platform = process.platform) {
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new GameError('python-missing', `The Python program set in Settings was not found: ${override}`);
  }
  if (platform === 'win32') {
    const bundledPython = path.join(gameDir, 'python', 'python.exe');
    if (fs.existsSync(bundledPython)) return bundledPython;
  }
  const venvPython = platform === 'win32'
    ? path.join(gameDir, 'venv', 'Scripts', 'python.exe')
    : path.join(gameDir, 'venv', 'bin', 'python3');
  if (fs.existsSync(venvPython)) return venvPython;

  const ppythonFile = path.join(gameDir, 'PPYTHON_PATH');
  if (fs.existsSync(ppythonFile)) {
    let ppython = fs.readFileSync(ppythonFile, 'utf8').trim().replace(/^"(.*)"$/, '$1');
    // A relative path (as in the installer's bundled SDK) is relative to the
    // game folder, as it is for the start scripts.
    if (ppython && !path.win32.isAbsolute(ppython) && !path.isAbsolute(ppython)) {
      ppython = path.join(gameDir, ...ppython.split(/[\\/]/));
    }
    if (ppython && fs.existsSync(ppython)) return ppython;
  }
  throw new GameError(
    'python-missing',
    'Panda3D could not be found. Install the Panda3D SDK (and point PPYTHON_PATH at it) or build it with the build-Panda3D script, or choose Python in Settings.',
  );
}

// What to run: the game's executable, unless Settings names a Python (for a
// checkout), otherwise Python with the game's start module.
function findGameProgram(gameDir, pythonOverride, platform = process.platform) {
  const exe = !pythonOverride && gameExe(gameDir, platform);
  if (exe) {
    // a Windows build on a non-Windows host runs through Wine
    if (platform === 'win32') return { command: exe, args: [] };
    return { exe, wine: true };
  }
  return { command: findPython(gameDir, pythonOverride, platform), args: ['-m', 'toontown.launcher.QuickStartLauncher'] };
}

// Builds the command without a shell: arguments are passed as a list and
// the login token only travels in the child's environment (later ones on
// its input). program comes from findGameProgram; python alone means
// `<python> -m ...`. gameVersion, the installed release, is shown in the
// game's corner (ToontownStart).
function buildLaunch({ gameDir, program, python, host, port, playToken, gameVersion, baseEnv = process.env, wine = null }) {
  // PYTHONUNBUFFERED lets the launcher follow the client's progress.
  // LOGIN_TOKEN_PIPE: the game may ask for another play token.
  let env = { ...baseEnv, GAME_SERVER: `${host}:${port}`, LOGIN_TOKEN: playToken, LOGIN_TOKEN_PIPE: '1', PYTHONUNBUFFERED: '1' };
  if (wine && wine.prefix) {
    env = { ...env, WINEPREFIX: wine.prefix, WINEDLLOVERRIDES: wine.dllOverrides, WINEDEBUG: '-all' };
    if (process.platform === 'darwin') {
      env.WINEMAC_NO_FLICKER = '1';
      env.WINEMSYNC = '1';
      env.WINEMETALGL = '1';
    }
  }
  if (gameVersion) env.GAME_VERSION = gameVersion;
  else delete env.GAME_VERSION;
  // Never hand the launcher's own overrides or secrets to the client.
  delete env.MONGODB_URI;
  delete env.MONGO_URI;
  if (program && program.wine) {
    if (!wine || !wine.command) throw new Error('Wine is needed to run the game on this system.');
    return {
      command: wine.command,
      args: [program.exe],
      options: { cwd: gameDir, env, shell: false, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] },
    };
  }
  return {
    command: program ? program.command : python,
    args: program ? program.args : ['-m', 'toontown.launcher.QuickStartLauncher'],
    options: { cwd: gameDir, env, shell: false, windowsHide: false, stdio: ['pipe', 'pipe', 'pipe'] },
  };
}

// The game asks for another play token to log in again with, after a
// district reset or a lost connection (a play token works for one login;
// toontown/launcher/LauncherPipe.py), with a line "@launcher play-token <n>"
// on its output, and "@launcher leave-line <n>" if the player gives up
// waiting. The launcher answers request n on the game's input with a line of
// JSON: {"request": n, "token": "..."}, {"request": n, "waiting":
// {"position": 3}} while in line (then more), or {"request": n, "error":
// "...", "code": "...", "retryable": true}.
const GAME_REQUEST = /^@launcher (play-token|leave-line) ([0-9]{1,9})\r?$/;

// Gets the game its play tokens, as Play does: newLine(onUpdate) makes a
// Line (line.js) to wait for the player's turn in. One at a time: asking
// again while one is on its way takes over its answer (and place in line).
class PlayTokenRequests {
  constructor({ write, newLine, onToken = () => {} }) {
    this.write = write;
    this.newLine = newLine;
    this.onToken = onToken;
    this.request = null;
    this.line = null;
  }

  handle(text) {
    const match = GAME_REQUEST.exec(text);
    if (!match) return false;
    const id = Number(match[2]);
    if (match[1] === 'leave-line') {
      if (this.line && id === this.request) this.line.leave();
      return true;
    }
    const busy = this.request !== null;
    this.request = id;
    if (!busy) this.get();
    return true;
  }

  async get() {
    let answer;
    try {
      if (!this.newLine) throw Object.assign(new Error("The launcher can't get the game a play token."), { code: 'not-available' });
      this.line = this.newLine((update) => {
        if (update && update.position) this.answer({ waiting: { position: update.position } });
      });
      const token = await this.line.waitForTurn();
      if (token) this.onToken(token);
      answer = token ? { token } : { error: 'You left the line.', code: 'left-line', retryable: true };
    } catch (err) {
      answer = err.code
        ? { error: err.message, code: err.code, retryable: RETRYABLE.has(err.code) }
        : { error: 'Something went wrong. Please try again.', code: 'unexpected', retryable: true };
    }
    this.line = null;
    this.answer(answer);
    this.request = null;
  }

  answer(fields) {
    this.write(`${JSON.stringify({ request: this.request, ...fields })}\n`);
  }

  // The game has closed: out of the line.
  stop() {
    if (this.line) this.line.leave();
  }
}

// Starts the client. onEvent receives { type: 'started' | 'running' | 'exited' | 'error', ... }.
// newLine: for the game's play token requests (PlayTokenRequests).
function launchGame(launch, onEvent, spawnFn = spawn, { newLine = null } = {}) {
  // The login tokens the game has been given, kept out of its captured output.
  const secrets = [launch.options.env.LOGIN_TOKEN];
  let child;
  try {
    child = spawnFn(launch.command, launch.args, launch.options);
  } catch (err) {
    throw new GameError('spawn-failed', `The game could not be started (${err.code || err.message}).`);
  }
  let settled = false;
  let tail = '';
  const remember = (chunk) => {
    // Keep the end of the output for error reports, without the login tokens
    // (the client logs the account name it logs in with).
    tail = redact(tail + chunk.toString(), secrets).slice(-4000);
  };
  child.stdout && child.stdout.on('data', remember);
  child.stderr && child.stderr.on('data', remember);
  const requests = new PlayTokenRequests({
    newLine,
    onToken: (token) => secrets.push(token),
    write: (text) => {
      if (child.stdin && child.stdin.writable) child.stdin.write(text);
    },
  });
  // (Writing to a game that has just closed fails; nothing is waiting then.)
  child.stdin && child.stdin.on('error', () => {});
  let partial = '';
  child.stdout && child.stdout.on('data', (chunk) => {
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop().slice(-1000);
    for (const line of lines) requests.handle(line);
  });
  child.once('spawn', () => {
    onEvent({ type: 'started', pid: child.pid });
    // ToontownStart prints this once it starts the game itself (its detailed
    // log goes to logs/toontown-*.log in the game folder).
    const watch = (chunk) => {
      if (!settled && /ToontownStart: Starting the game/.test(chunk.toString())) {
        settled = true;
        onEvent({ type: 'running' });
      }
    };
    child.stdout && child.stdout.on('data', watch);
  });
  child.once('error', (err) => {
    onEvent({ type: 'error', message: `The game could not be started (${err.code || 'error'}).` });
  });
  child.once('exit', (code, signal) => {
    requests.stop();
    onEvent({ type: 'exited', code, signal, output: summarizeOutput(tail) });
  });
  return child;
}

// secrets: one, or a list.
function redact(text, secrets) {
  for (const secret of [].concat(secrets)) {
    if (secret) text = text.split(secret).join('[token]');
  }
  return text;
}

// Picks the useful lines out of the client's last output for an error
// message: a Python error or a connection/eject problem.
function summarizeOutput(output) {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const interesting = lines.filter((l) => /Error|Exception|booting us out|Lost connection|Failed to connect|Could not connect/i.test(l));
  return (interesting.length ? interesting : lines).slice(-3).join('\n');
}

// The game folder's bin folder (Python's and Panda3D's libraries and the
// game's code, see tools/build_game_exe.py) is marked hidden on Windows, so
// the folder shows players only the game, its phase files and logs. Hidden
// only hides it from File Explorer's normal view; the game loads it as usual.
const HIDDEN_FOLDERS = ['bin'];

function hideCodeFolders(gameDir, platform = process.platform, run = require('child_process').execFile) {
  if (platform !== 'win32' || !gameDir) return [];
  const hidden = [];
  for (const name of HIDDEN_FOLDERS) {
    const folder = path.join(gameDir, name);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) continue;
    run('attrib', ['+h', folder], { windowsHide: true }, () => {});
    hidden.push(folder);
  }
  return hidden;
}

module.exports = {
  REQUIRED_FILES, GameError, defaultGameDir, installDir, gameExe, checkGameFiles, findPython, findGameProgram, buildLaunch, launchGame,
  PlayTokenRequests, summarizeOutput, redact, hideCodeFolders,
};
