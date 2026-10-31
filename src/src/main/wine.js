// Wine backend for Linux and macOS launchers.
//
// The client is a Windows build (python313.dll + pyds + ToonValley.exe), so on
// Linux and macOS it runs through Wine.  The runner is picked in this order:
//
//   1. Settings' winePath (an explicit runner)
//   2. a system wine64/wine on PATH (including Homebrew / MacPorts on macOS)
//   3. platform runners: macOS Wine apps (Wine Staging, Whisky, etc.) on macOS, Steam Proton on Linux
//   4. a runner we downloaded into <data>/runners/<name> (e.g. Gcenx macOS Wine builds)
//
// The prefix is created under the user's data dir unless Settings names one;
// if that dir is not writable the launcher falls back to its own folder
// (portable installs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// The overrides our own launch recipe uses (see notes/toonvalley-k8s.md and
// the run commands): Proton's bundled d3dcompiler/ffmpeg and a native Vulkan
// are the combination the client boots with.
const WINE_DLL_OVERRIDES =
  'd3dcompiler_47=n,b;ffmpeg=n,b;libEGL=n,b;libGLESv2=n,b;vk_swiftshader=n,b;vulkan-1=n,b;winhttp=n,b';

// On macOS, add opengl32=n,b to use WineMetalGL (OpenGL -> Apple Metal translation)
const WINE_MAC_DLL_OVERRIDES = WINE_DLL_OVERRIDES + ';opengl32=n,b';

function wineDllOverrides(platform = process.platform) {
  return platform === 'darwin' ? WINE_MAC_DLL_OVERRIDES : WINE_DLL_OVERRIDES;
}

// WineMetalGL version and URLs
const WINEMETALGL_VERSION = '3.7.0';
const WINEMETALGL_URL = (arch) =>
  `https://github.com/metalsharp/WineMetalGL/releases/download/winemetalgl-${WINEMETALGL_VERSION}/winemetalgl-${WINEMETALGL_VERSION}-${arch}.tar.gz`;

// Default free, portable Wine runner for macOS (Gcenx's official Wine-Staging build)
const DEFAULT_MAC_RUNNER_URL =
  'https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.21/wine-staging-11.21-osx64.tar.xz';

// How long wineboot may take on a cold prefix.
const WINEBOOT_TIMEOUT_MS = 15 * 60 * 1000;

// A prefix only has to hold the game's registry and drive mapping; the Mono
// and Gecko installers wineboot would otherwise run are what hang a Proton
// runner on a fresh prefix, and the game needs neither.
const WINEBOOT_DLL_OVERRIDES = 'mscoree=d;mshtml=d';

class WineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function which(name, envPath = process.env.PATH || '') {
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  if (process.platform === 'darwin') {
    for (const extra of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
      if (!dirs.includes(extra)) dirs.push(extra);
    }
  }
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function wineVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) return null;
  const raw = (result.stdout || result.stderr || '').trim();
  if (!raw) return null;
  return raw.split('\n')[0].trim() || null;
}

// Steam Proton installs, newest first.
function steamProtonRunners(home = os.homedir()) {
  const roots = [
    path.join(home, '.steam', 'steam', 'steamapps', 'common'),
    path.join(home, '.local', 'share', 'Steam', 'steamapps', 'common'),
    path.join(home, 'snap', 'steam', 'common', '.local', 'share', 'Steam', 'steamapps', 'common'),
  ];
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^Proton/i.test(entry.name)) continue;
      const wine = path.join(root, entry.name, 'files', 'bin', 'wine64');
      if (isExecutable(wine)) found.push({ command: wine, source: 'steam-proton', name: entry.name });
    }
  }
  // Proton 9 before Proton Experimental, then any.
  found.sort((a, b) => {
    // Proton 9 is the combination the client is tested with; 8 next, then the
    // rest (Proton 9.0 (Beta) is what Steam calls it on the Deck)
    const rank = (x) => (x.name.startsWith('Proton 9') ? 0 : x.name.startsWith('Proton 8') ? 1 : 2);
    return rank(a) - rank(b);
  });
  return found;
}

// Discover free Wine apps on macOS (Wine Staging, Whisky, Wineskin, etc.)
function macOSWineRunners(home = os.homedir()) {
  const apps = [
    '/Applications',
    path.join(home, 'Applications'),
  ];
  const appNames = [
    'MetalSharp-Wine.app',
    'MetalSharp Wine.app',
    'Wine Staging.app',
    'Wine Devel.app',
    'Wine Crossover.app',
    'Wine Stable.app',
    'Wine.app',
  ];
  const found = [];
  const checked = new Set();

  function addCandidate(cmd, source, name) {
    if (!cmd || checked.has(cmd) || !isExecutable(cmd)) return;
    checked.add(cmd);
    found.push({ command: cmd, source, name });
  }

  // 1. Gcenx macOS Wine builds / Homebrew Cask Wine apps
  for (const appDir of apps) {
    for (const appName of appNames) {
      const fullApp = path.join(appDir, appName);
      for (const rel of [
        ['Contents', 'Resources', 'wine', 'bin', 'wine64'],
        ['Contents', 'Resources', 'wine', 'bin', 'wine'],
        ['Contents', 'MacOS', 'wine'],
      ]) {
        addCandidate(path.join(fullApp, ...rel), 'mac-app', appName.replace(/\.app$/, ''));
      }
    }
  }

  // 2. Whisky runner
  const whiskyRoots = [
    path.join(home, 'Library', 'Application Support', 'com.isaacmarovitz.Whisky', 'Libraries', 'Wine', 'bin'),
    path.join(home, 'Library', 'Application Support', 'Whisky', 'Libraries', 'Wine', 'bin'),
  ];
  for (const root of whiskyRoots) {
    addCandidate(path.join(root, 'wine64'), 'whisky', 'Whisky Wine');
    addCandidate(path.join(root, 'wine'), 'whisky', 'Whisky Wine');
  }

  // 3. Wineskin engines
  const wineskinEngines = path.join(home, 'Library', 'Application Support', 'Wineskin', 'Engines');
  try {
    const engines = fs.readdirSync(wineskinEngines, { withFileTypes: true });
    for (const ent of engines) {
      if (!ent.isDirectory()) continue;
      const candidates = [
        path.join(wineskinEngines, ent.name, 'Wineskin.app', 'Contents', 'Frameworks', 'bin', 'wine64'),
        path.join(wineskinEngines, ent.name, 'Wineskin.app', 'Contents', 'Frameworks', 'bin', 'wine'),
        path.join(wineskinEngines, ent.name, 'bin', 'wine64'),
        path.join(wineskinEngines, ent.name, 'bin', 'wine'),
      ];
      for (const cand of candidates) {
        addCandidate(cand, 'wineskin', `Wineskin (${ent.name})`);
      }
    }
  } catch {}

  // 4. Apple Game Porting Toolkit / Homebrew opt
  for (const dir of ['/opt/homebrew/opt/game-porting-toolkit/bin', '/usr/local/opt/game-porting-toolkit/bin']) {
    addCandidate(path.join(dir, 'wine64'), 'gptk', 'Game Porting Toolkit');
    addCandidate(path.join(dir, 'wine'), 'gptk', 'Game Porting Toolkit');
  }

  return found;
}

// Find a wine binary within a runner directory
function findRunnerBinary(baseDir) {
  const rels = [
    ['bin', 'wine64'],
    ['bin', 'wine'],
    ['files', 'bin', 'wine64'],
    ['files', 'bin', 'wine'],
    ['Contents', 'Resources', 'wine', 'bin', 'wine64'],
    ['Contents', 'Resources', 'wine', 'bin', 'wine'],
  ];
  for (const rel of rels) {
    const candidate = path.join(baseDir, ...rel);
    if (isExecutable(candidate)) return candidate;
  }
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.isDirectory()) {
        for (const rel of rels) {
          const candidate = path.join(baseDir, ent.name, ...rel);
          if (isExecutable(candidate)) return candidate;
        }
      }
    }
  } catch {}
  return null;
}

// Runners we downloaded ourselves (downloadRunner puts them here).
function downloadedRunners(dataDir) {
  const root = path.join(dataDir, 'runners');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const baseDir = path.join(root, entry.name);
    const wine = findRunnerBinary(baseDir);
    if (wine) {
      found.push({ command: wine, source: 'downloaded', name: entry.name });
    }
  }
  return found;
}

// Download a remote URL to destination with redirect tracking and progress reporting
function fetchUrl(targetUrl, destinationPath, onProgress) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    function get(u, redirectsLeft = 5) {
      let parsed;
      try {
        parsed = new URL(u);
      } catch (err) {
        return reject(err);
      }
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(u, { headers: { 'User-Agent': 'ToonValleyLauncher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
          const next = new URL(res.headers.location, u).href;
          return get(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Failed to download runner: HTTP ${res.statusCode}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const fileStream = fs.createWriteStream(destinationPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total > 0 && onProgress) {
            onProgress(Math.round((received / total) * 100));
          }
        });
        res.pipe(fileStream);
        fileStream.on('finish', () => fileStream.close(resolve));
        fileStream.on('error', (err) => {
          try { fs.unlinkSync(destinationPath); } catch {}
          reject(err);
        });
      });
      req.on('error', (err) => {
        try { fs.unlinkSync(destinationPath); } catch {}
        reject(err);
      });
    }
    get(targetUrl);
  });
}

// Download and install a free standalone Wine runner (Gcenx's macOS Wine build)
async function downloadRunner({ dataDir, url = null, log = () => {}, progress = () => {} } = {}) {
  const downloadUrl = url || DEFAULT_MAC_RUNNER_URL;
  const runnersDir = path.join(dataDir, 'runners');
  const targetDir = path.join(runnersDir, 'wine-staging');
  const archivePath = path.join(runnersDir, 'wine-staging-download.tar.xz');

  fs.mkdirSync(runnersDir, { recursive: true });
  fs.mkdirSync(targetDir, { recursive: true });

  log(`Downloading Wine runner from ${downloadUrl}`);
  await fetchUrl(downloadUrl, archivePath, progress);

  log('Extracting Wine runner…');
  const tarRes = spawnSync('tar', ['-xJf', archivePath, '-C', targetDir]);
  try { fs.unlinkSync(archivePath); } catch {}
  if (tarRes.status !== 0) {
    throw new WineError('runner-extract-failed', 'Failed to extract Wine runner archive.');
  }

  // Clear macOS quarantine attribute to prevent Gatekeeper warnings
  if (process.platform === 'darwin') {
    try { spawnSync('xattr', ['-dr', 'com.apple.quarantine', targetDir]); } catch {}
  }

  const binary = findRunnerBinary(targetDir);
  if (!binary) {
    throw new WineError('runner-not-found', 'Wine binary was not found after extracting the runner.');
  }
  log(`Wine runner ready: ${binary}`);
  return {
    command: binary,
    source: 'downloaded',
    name: 'wine-staging',
    version: wineVersion(binary),
  };
}

// The runner to use: { command, source, name, version }.
function findWine({ settings = {}, dataDir, home = os.homedir() } = {}) {
  if (settings.winePath) {
    const command = expandHome(settings.winePath);
    if (!isExecutable(command)) {
      throw new WineError('wine-missing', `The Wine runner in Settings was not found: ${command}`);
    }
    return { command, source: 'settings', name: path.basename(command), version: wineVersion(command) };
  }

  const system = which('wine64') || which('wine');
  if (system) {
    return { command: system, source: 'system', name: path.basename(system), version: wineVersion(system) };
  }

  if (process.platform === 'darwin') {
    const macRunners = macOSWineRunners(home);
    if (macRunners.length) {
      return { ...macRunners[0], version: wineVersion(macRunners[0].command) };
    }
  } else {
    const proton = steamProtonRunners(home);
    if (proton.length) {
      return { ...proton[0], version: wineVersion(proton[0].command) };
    }
  }

  const downloaded = dataDir ? downloadedRunners(dataDir) : [];
  if (downloaded.length) {
    return { ...downloaded[0], version: wineVersion(downloaded[0].command) };
  }

  throw new WineError(
    'wine-missing',
    process.platform === 'darwin'
      ? 'Wine was not found. Install Wine (e.g. Wine Staging / Homebrew), or choose a runner in Settings.'
      : 'Wine was not found. Install Wine, or let the launcher download a runner in Settings.',
  );
}

// The prefix the game is installed in, if any: a game folder under
// <prefix>/drive_c (which is how Wine and Proton installers lay it out) works
// best in the prefix it was installed in -- its registry, drives and any
// runtime it registered are there.  Returns null for a game folder that is
// not inside a prefix.
function gamePrefix(gameDir) {
  let dir = path.resolve(gameDir);
  for (let depth = 0; depth < 10; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    if (fs.existsSync(path.join(dir, 'drive_c'))) return dir;
  }
  return null;
}

// The Windows prefix: Settings' choice, else the prefix the game is installed
// in, else the user data dir, else the launcher's own folder (portable).  Only the first is created if missing.
function resolvePrefix({ settings = {}, userDataDir, appDir, gameDir, home = os.homedir() } = {}) {
  if (settings.winePrefix) {
    return { dir: expandHome(settings.winePrefix), source: 'settings', create: true };
  }
  if (gameDir) {
    const installed = gamePrefix(gameDir);
    if (installed) return { dir: installed, source: 'game-folder', create: false };
  }
  if (userDataDir) {
    return { dir: path.join(userDataDir, 'prefix'), source: 'user-data', create: true };
  }
  return { dir: path.join(appDir || home, 'prefix'), source: 'app-folder', create: true };
}

function prefixReady(prefixDir) {
  return fs.existsSync(path.join(prefixDir, 'system.reg'));
}

// Install WineMetalGL (OpenGL -> Apple Metal translation) into the prefix and Wine installation
async function ensureWineMetalGL(prefixDir, wine, { dataDir, log = () => {} } = {}) {
  const sys32 = path.join(prefixDir, 'drive_c', 'windows', 'system32');
  const installedDll = path.join(sys32, 'winemetalgl.dll');
  const installedOpengl = path.join(sys32, 'opengl32.dll');
  if (fs.existsSync(installedDll) && fs.existsSync(installedOpengl)) {
    return;
  }

  // Find the Wine install folder
  let wineDir = path.dirname(path.resolve(wine.command));
  if (path.basename(wineDir) === 'bin') wineDir = path.dirname(wineDir);
  if (fs.existsSync(path.join(wineDir, 'Resources', 'wine'))) {
    wineDir = path.join(wineDir, 'Resources', 'wine');
  }

  // MetalSharp Wine already provides WineMetalGL for every prefix
  if (fs.existsSync(path.join(wineDir, 'lib', 'winemetalgl')) ||
      (wine.command && wine.command.includes('MetalSharp'))) {
    return;
  }

  log('Setting up WineMetalGL (OpenGL -> Metal translation)…');

  // Detect Wine architecture (aarch64 vs x86_64)
  const libWine = path.join(wineDir, 'lib', 'wine');
  const isArm = fs.existsSync(path.join(libWine, 'aarch64-unix', 'ntdll.so')) &&
               !fs.existsSync(path.join(libWine, 'x86_64-unix', 'ntdll.so'));
  const arch = isArm ? 'arm64' : 'x86_64';
  const winDir = isArm ? 'aarch64-windows' : 'x86_64-windows';
  const unixDir = isArm ? 'aarch64-unix' : 'x86_64-unix';

  // Cache directory for downloaded WineMetalGL release
  const cacheBase = dataDir || path.join(os.homedir(), 'Library', 'Caches', 'WineMetalGL');
  const cacheDir = path.join(cacheBase, 'winemetalgl', WINEMETALGL_VERSION, arch);
  const extractDir = path.join(cacheDir, `winemetalgl-${WINEMETALGL_VERSION}-${arch}`);
  const moduleDir = path.join(extractDir, 'module');

  if (!fs.existsSync(path.join(moduleDir, unixDir, 'libwinemetalgl.dylib'))) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tarPath = path.join(cacheDir, `winemetalgl-${WINEMETALGL_VERSION}-${arch}.tar.gz`);
    const downloadUrl = WINEMETALGL_URL(arch);
    log(`Downloading WineMetalGL from ${downloadUrl}`);
    await fetchUrl(downloadUrl, tarPath);
    spawnSync('tar', ['-xzf', tarPath, '-C', cacheDir]);
    try { fs.unlinkSync(tarPath); } catch {}
  }

  const copySafe = (src, dst) => {
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    } catch {}
  };

  // Try installing into Wine lib directory if writable
  copySafe(path.join(moduleDir, winDir, 'winemetalgl.dll'), path.join(libWine, winDir, 'winemetalgl.dll'));
  copySafe(path.join(moduleDir, 'i386-windows', 'winemetalgl.dll'), path.join(libWine, 'i386-windows', 'winemetalgl.dll'));
  copySafe(path.join(moduleDir, unixDir, 'winemetalgl.so'), path.join(libWine, unixDir, 'winemetalgl.so'));
  copySafe(path.join(moduleDir, unixDir, 'libwinemetalgl.dylib'), path.join(libWine, unixDir, 'libwinemetalgl.dylib'));

  for (const f of ['winemetalgl.so', 'libwinemetalgl.dylib']) {
    const full = path.join(libWine, unixDir, f);
    if (fs.existsSync(full)) {
      try { spawnSync('xattr', ['-dr', 'com.apple.quarantine', full]); } catch {}
      try { spawnSync('codesign', ['-f', '-s', '-', full]); } catch {}
    }
  }

  // Install into prefix system32 and syswow64
  fs.mkdirSync(sys32, { recursive: true });
  copySafe(path.join(moduleDir, winDir, 'opengl32.dll'), path.join(sys32, 'opengl32.dll'));
  copySafe(path.join(moduleDir, winDir, 'winemetalgl.dll'), path.join(sys32, 'winemetalgl.dll'));

  const syswow64 = path.join(prefixDir, 'drive_c', 'windows', 'syswow64');
  if (fs.existsSync(syswow64)) {
    copySafe(path.join(moduleDir, 'i386-windows', 'opengl32.dll'), path.join(syswow64, 'opengl32.dll'));
    copySafe(path.join(moduleDir, 'i386-windows', 'winemetalgl.dll'), path.join(syswow64, 'winemetalgl.dll'));
  }

  // Set registry override opengl32=native in prefix
  spawnSync(wine.command, ['reg', 'add', 'HKCU\\Software\\Wine\\DllOverrides', '/v', 'opengl32', '/d', 'native', '/f'], {
    env: { ...process.env, WINEPREFIX: prefixDir, WINEDEBUG: '-all' },
  });

  log('WineMetalGL enabled (Metal-accelerated OpenGL active).');
}

// Create the prefix once (wineboot -u); a missing prefix makes the first
// launch slow but it is the same step a manual setup does.  Asynchronous: the
// launcher window (and its progress text) stays alive while Wine works.
function ensurePrefix(prefixDir, wine, { log = () => {}, timeoutMs = WINEBOOT_TIMEOUT_MS, dataDir } = {}) {
  const setupMetalGL = () => {
    if (process.platform === 'darwin') {
      return ensureWineMetalGL(prefixDir, wine, { dataDir, log });
    }
    return Promise.resolve();
  };

  if (prefixReady(prefixDir)) {
    return setupMetalGL().then(() => ({ created: false, dir: prefixDir }));
  }
  fs.mkdirSync(prefixDir, { recursive: true });
  log(`Creating the Wine prefix in ${prefixDir}`);
  const env = {
    ...process.env,
    WINEPREFIX: prefixDir,
    WINEDEBUG: '-all',
    WINEDLLOVERRIDES: WINEBOOT_DLL_OVERRIDES,
  };
  if (process.platform === 'darwin') {
    env.WINEMAC_NO_FLICKER = '1';
    env.WINEMSYNC = '1';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(wine.command, ['wineboot', '-u'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    // Wait for wineboot to finish: system.reg is written early, and launching
    // while the prefix is still being built (wineboot --init, Wow64Install)
    // leaves the game hanging on a half-made prefix.
    const done = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ created: true, dir: prefixDir });
    };
    child.stdout.on('data', (c) => { stderr += c.toString().slice(0, 4000); });
    child.stderr.on('data', (c) => { stderr += c.toString().slice(0, 4000); });
    const timer = setTimeout(() => {
      // Minutes on a first prefix are normal; only give up when there is
      // nothing to show for it.
      if (prefixReady(prefixDir)) {
        log('wineboot is still finishing the prefix; starting anyway');
        done(null);
      } else {
        done(new WineError('wineboot-failed', `Wine did not finish creating its prefix in ${Math.round(timeoutMs / 60000)} min.`));
      }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    child.on('error', (err) => {
      done(new WineError('wineboot-failed', `The Wine prefix could not be created: ${err.message}`));
    });
    child.on('exit', (code) => {
      if (code === 0 || prefixReady(prefixDir)) {
        done(null);
        return;
      }
      const detail = stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      done(new WineError(
        'wineboot-failed',
        `Wine could not set up its prefix (exit ${code}).${detail ? ` ${detail}` : ''}`,
      ));
    });
  }).then(async (res) => {
    await setupMetalGL();
    return res;
  });
}

// Environment for a Wine launch (the game's own env is merged by the caller).
function wineEnv(prefixDir, baseEnv = process.env) {
  const env = {
    ...baseEnv,
    WINEPREFIX: prefixDir,
    WINEDLLOVERRIDES: wineDllOverrides(),
    WINEDEBUG: '-all',
  };
  if (process.platform === 'darwin') {
    env.WINEMAC_NO_FLICKER = '1';
    env.WINEMSYNC = '1';
    env.WINEMETALGL = '1';
  }
  return env;
}

module.exports = {
  DEFAULT_MAC_RUNNER_URL,
  WINEMETALGL_VERSION,
  WINE_DLL_OVERRIDES,
  WINE_MAC_DLL_OVERRIDES,
  WineError,
  downloadRunner,
  downloadedRunners,
  ensurePrefix,
  ensureWineMetalGL,
  findWine,
  gamePrefix,
  macOSWineRunners,
  prefixReady,
  resolvePrefix,
  steamProtonRunners,
  wineDllOverrides,
  wineEnv,
  wineVersion,
};
