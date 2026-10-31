const os = require('os');
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, safeStorage, session } = require('electron');

const { Config, updatesConfig } = require('./config');
const { checkGameServer, checkLoginApi } = require('./status');
const { AuthClient, AuthError } = require('./auth');
const { Line } = require('./line');
const { DownloadAuth } = require('./downloadAuth');
const { SavedLogin } = require('./credentials');
const game = require('./game');
const wine = require('./wine');
const { Patcher } = require('./patcher/patcher');
const { SelfUpdater, portableExePath } = require('./patcher/selfupdate');
const changelog = require('./changelog');
const { refreshShortcutIcons, shortcutFolders } = require('./shortcuts');
const { fetchNews } = require('./news');
const { linkAllowed, reportEmailUrl } = require('./links');

let mainWindow = null;
let config = null;
let auth = null;
let downloadAuth = null;
let savedLogin = null;
let gameProcess = null;
// The line for the game, while Play waits in it (line.js).
let line = null;
let quitWhenGameExits = false;
let patcher = null;
let patcherKey = '';
let closeAfterUpdate = false;
let selfUpdater = null;
let launcherUpdated = null;

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// Where the patcher installs the game when updates are on. On Windows that
// is the folder the installer puts Launcher.exe in, so the game lives next
// to it, as with TTR (per user, so updates need no administrator).
function defaultInstallDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', 'Toon Valley');
  }
  return path.join(app.getPath('userData'), 'Game');
}

// The copy of the game bundled with the full installer, if any. The patcher
// copies matching files from it instead of downloading them.
function bundledGameDir() {
  const dir = app.isPackaged ? path.join(process.resourcesPath, 'game') : null;
  return dir && fs.existsSync(dir) ? dir : null;
}

function getGameDir() {
  const settings = config.get();
  if (settings.gameDir) return settings.gameDir;
  if (updatesConfig(settings) && !updatesConfig(settings).problem) return defaultInstallDir();
  return game.defaultGameDir({
    packaged: app.isPackaged, appPath: app.getAppPath(), execPath: process.execPath, resourcesPath: process.resourcesPath,
  });
}

// The patcher for the current game folder and update settings, or null when
// updates are off.
function getPatcher() {
  const updates = updatesConfig(config.get());
  if (!updates || updates.problem) {
    if (updates) console.error(`Updates are off: ${updates.problem}.`);
    return null;
  }
  const installDir = getGameDir();
  const key = JSON.stringify([installDir, updates]);
  if (patcher && patcherKey === key) return patcher;
  if (patcher && patcher.busy) return patcher; // Settings changed mid-update: finish first.
  patcher = new Patcher({
    installDir, seedDirs: [bundledGameDir()], ...updates, getToken: downloadToken,
    // The newest release seen, so an older one can't be served in its
    // place (rollback.js). Kept with the launcher, not the game folder.
    releaseFile: path.join(app.getPath('userData'), 'update-releases.json'),
  });
  patcherKey = key;
  patcher.on('progress', (progress) => send('patcher:progress', progress));
  return patcher;
}

// The current download token for the patcher (null without one: a public
// update server doesn't need it).
function downloadToken() {
  return downloadAuth ? downloadAuth.getToken() : null;
}

// Launcher.exe updating itself from the release's launcher entry, when it
// is the portable Launcher.exe and updates are on.
function getSelfUpdater() {
  const exePath = portableExePath();
  const updates = updatesConfig(config.get());
  if (!exePath || !updates || updates.problem) return null;
  if (!selfUpdater) {
    const { mirrors, timeoutMs, retries } = updates;
    selfUpdater = new SelfUpdater({
      exePath, mirrors, timeoutMs, retries, log: (message) => patcher && patcher.log(message), getToken: downloadToken,
      currentVersion: app.getVersion(),
    });
  }
  return selfUpdater;
}

// After a check or update, gets the release's launcher in the background;
// the page offers a restart once it's in place.
// Its progress and any failure go to the page too, so Settings doesn't say
// "Downloading" forever.
let launcherProgressSent = 0;
function updateLauncher(manifest) {
  const updater = getSelfUpdater();
  if (!updater || !manifest || launcherUpdated) return;
  const onProgress = (bytesDone, bytesTotal) => {
    const now = Date.now();
    if (now - launcherProgressSent < 250 && bytesDone < bytesTotal) return;
    launcherProgressSent = now;
    send('launcher:progress', { bytesDone, bytesTotal });
  };
  updater.update(manifest, onProgress).then((version) => {
    if (version) {
      launcherUpdated = version;
      send('launcher:updated', { version });
    }
  }).catch((err) => {
    if (patcher) patcher.log(`launcher update failed: ${err.message}`);
    send('launcher:failed', { message: err.message || 'The download failed.' });
  });
}

// Logged in, but this PC has no key for downloads, and the login API never
// refused one: registering it at login failed (the API slow or erroring,
// say under launch-day load). Tries once more.
async function registerDeviceIfMissed() {
  if (!downloadAuth || downloadAuth.problem || downloadAuth.hasDevice() || !auth || !auth.getSessionToken()) return;
  await downloadAuth.registerDevice(auth.getSessionToken());
}

function patcherErrorPayload(err) {
  if (err.code === 'login-required' && downloadAuth && !downloadAuth.problem && auth && auth.getSessionToken()) {
    // Logged in and never refused: the login API couldn't hand out a
    // download pass just now. Not the account's fault, so not "this
    // account can't download".
    return {
      ok: false, code: 'download-pass', retryable: true,
      message: "The login server couldn't give this PC a download pass just now. Wait a moment and press Retry.",
    };
  }
  // A download refused for want of a download token: the API's reason, if
  // it gave one when this PC's key was refused.
  const message = err.code === 'login-required' && downloadAuth ? downloadAuth.refusedMessage() : err.message;
  return { ok: false, code: err.code || 'unexpected', message: message || 'The update failed. Try again.', retryable: Boolean(err.retryable) };
}

// Settings sent to the page. The server addresses stay in this process.
function publicSettings() {
  const current = getPatcher();
  const { gameServerHost, gameServerPort, loginApiUrl, ...settings } = config.get();
  return {
    ...settings,
    resolvedGameDir: getGameDir(),
    platform: process.platform,
    appVersion: app.getVersion(),
    updatesEnabled: Boolean(current),
    installedVersion: current ? current.installedVersion() : null,
  };
}

// "Report an Issue" opens an email to support with the versions filled in.
function reportEmail(mailto) {
  const current = getPatcher();
  return reportEmailUrl(mailto, {
    launcherVersion: app.getVersion(),
    gameVersion: current && current.installedVersion(),
    system: `${os.type()} ${os.release()} (${process.arch})`,
  });
}

function errorPayload(err) {
  if (err instanceof AuthError || err instanceof game.GameError) {
    return { ok: false, code: err.code, message: err.message };
  }
  console.error('Unexpected error:', err && err.message);
  return { ok: false, code: 'unexpected', message: 'Something went wrong. Please try again.' };
}

function createWindow() {
  quitWhenGameExits = false;
  mainWindow = new BrowserWindow({
    // A fixed-size, frameless window: the page draws its own title area and
    // minimize/close buttons, like a game launcher.
    width: 980,
    height: 640,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false,
    title: config.get().serverName,
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    backgroundColor: '#1d2433',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.removeMenu();
  // Closing while files are being replaced waits for that step to finish
  // (it takes seconds); downloads are simply cancelled and resume later.
  mainWindow.on('close', (event) => {
    if (patcher && patcher.applying) {
      event.preventDefault();
      closeAfterUpdate = true;
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  // The page never navigates or opens windows; links go through openLink.
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Only the launcher's own page (in the main window) may call the main
// process.
function fromLauncherPage(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  return Boolean(frame && !frame.parent && frame.url.startsWith('file:'));
}

function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromLauncherPage(event)) throw new Error('Not allowed.');
    return handler(event, ...args);
  });
}

function registerIpc() {
  handle('settings:get', () => publicSettings());

  handle('settings:save', (_event, changes) => {
    if (!changes || typeof changes !== 'object') return { ok: false, errors: {} };
    const result = config.update(changes);
    return { ...result, settings: publicSettings() };
  });

  handle('settings:reset', (_event, options) => {
    config.reset();
    savedLogin.reset(Boolean(options && options.rememberPassword === true));
    return publicSettings();
  });

  // The page passes where to start (the game folder it already found), so the
  // picker opens there instead of wherever the OS last was.
  handle('settings:chooseFolder', async (_event, startIn) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the game folder',
      defaultPath: typeof startIn === 'string' && startIn ? startIn : getGameDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('settings:chooseFile', async (_event, startIn) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose the Python program that runs the game',
      defaultPath: typeof startIn === 'string' && startIn ? startIn : undefined,
      properties: ['openFile'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  handle('status:check', async () => {
    const settings = config.get();
    const [gameServer, loginApi] = await Promise.all([
      checkGameServer(settings.gameServerHost, settings.gameServerPort),
      checkLoginApi(settings.loginApiUrl),
    ]);
    return { gameServer, loginApi, files: game.checkGameFiles(getGameDir()) };
  });

  handle('auth:login', async (_event, credentials) => {
    try {
      const { username, password, rememberPassword } = credentials || {};
      await auth.login(username, password);
      // This account can play: register this PC for updates, so the game
      // downloads now and later starts update without logging in. A
      // failure here doesn't stop the login.
      await downloadAuth.registerDevice(auth.getSessionToken());
      const settings = config.get();
      if (settings.rememberUsername) config.update({ username: auth.getUsername() });
      // "Remember password" is saved only after a login that worked;
      // unticked, a saved password is forgotten.
      if (rememberPassword === true) savedLogin.save(auth.getUsername(), password);
      else savedLogin.clear();
      return { ok: true, username: auth.getUsername() };
    } catch (err) {
      return errorPayload(err);
    }
  });

  // For the login form at start: whether "Remember password" can be offered
  // here, and the saved login to fill in, if any.
  handle('auth:savedLogin', () => ({ available: savedLogin.available(), saved: savedLogin.load() }));

  handle('auth:logout', () => {
    auth.logout();
    // Logging out also stops this PC getting updates without a login. The
    // key is forgotten at once; the server is told in the background.
    downloadAuth.logout().catch(() => {});
    return { ok: true };
  });

  handle('patcher:check', async () => {
    const current = getPatcher();
    if (!current) return { ok: true, enabled: false };
    if (current.busy) return { ok: false, code: 'busy', message: 'An update is already running.', retryable: true };
    try {
      const result = await current.check();
      // Also here, not only after an update: a game folder an older
      // launcher updated has nothing left to update.
      game.hideCodeFolders(current.installDir);
      updateLauncher(current.lastManifest);
      return { ok: true, enabled: true, ...result };
    } catch (err) {
      return { ...patcherErrorPayload(err), enabled: true, installedVersion: current.installedVersion() };
    }
  });

  handle('patcher:update', async (_event, options) => {
    const current = getPatcher();
    if (!current) return { ok: false, code: 'disabled', message: 'Updates are not set up for this launcher.' };
    if (gameProcess) return { ok: false, code: 'game-running', message: 'Close the game before updating.', retryable: true };
    try {
      await registerDeviceIfMissed();
      const result = await current.update({ repair: Boolean(options && options.repair) });
      game.hideCodeFolders(current.installDir);
      updateLauncher(current.lastManifest);
      return { ok: true, enabled: true, ...result };
    } catch (err) {
      return patcherErrorPayload(err);
    } finally {
      if (closeAfterUpdate && mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }
  });

  // Starts the updated Launcher.exe and closes this one.
  handle('launcher:restart', () => {
    const updater = getSelfUpdater();
    if (!updater || !launcherUpdated) return { ok: false, message: 'There is no launcher update to restart into.' };
    if (gameProcess) return { ok: false, message: 'Close the game first, then restart the launcher.' };
    if (patcher && patcher.busy) return { ok: false, message: 'Wait for the update to finish.' };
    // The new launcher would otherwise find this one still holding the lock.
    app.releaseSingleInstanceLock();
    // Where this launcher's file is locked while it runs, a script swaps in
    // the new one once it has exited, then starts it.
    try {
      if (!updater.finishOnExit({ restart: true })) {
        const { spawn } = require('child_process');
        spawn(updater.exePath, [], { detached: true, stdio: 'ignore', cwd: path.dirname(updater.exePath) }).unref();
      }
    } catch (err) {
      app.requestSingleInstanceLock();
      // The download was damaged and forgotten: the next check gets it again.
      if (!updater.pendingSwap) launcherUpdated = null;
      return { ok: false, message: `Couldn't restart into the new launcher (${err.message}). Close the launcher and open it again.` };
    }
    app.quit();
    return { ok: true };
  });

  handle('launcher:updated', () => launcherUpdated);
  handle('launcher:whatsNew', () => whatsNew);

  // Settings' "Check for update" for the launcher itself.
  handle('launcher:check', async () => {
    const updater = getSelfUpdater();
    if (!updater) return { ok: false, message: 'Only the installed Launcher.exe can update itself.' };
    if (launcherUpdated) return { ok: true, status: 'ready', version: launcherUpdated };
    const current = getPatcher();
    if (!current) return { ok: false, message: 'Updates are not set up for this launcher.' };
    try {
      const manifest = await current.confirmLatest();
      const entry = await updater.needed(manifest);
      if (!entry) return { ok: true, status: 'up-to-date', version: app.getVersion() };
      updateLauncher(manifest);
      return { ok: true, status: 'downloading', version: entry.version || null, size: entry.size };
    } catch (err) {
      return patcherErrorPayload(err);
    }
  });

  // The game's logs folder, for bug reports.
  handle('game:openLogs', async () => {
    const logs = path.join(getGameDir(), 'logs');
    if (!fs.existsSync(logs)) return { ok: false, message: 'There are no game logs yet: the game writes them the first time it runs.' };
    const problem = await shell.openPath(logs);
    return problem ? { ok: false, message: `Couldn't open the logs folder (${problem}). It is ${logs}` } : { ok: true };
  });

  handle('line:leave', () => {
    if (line) line.leave();
  });

  handle('patcher:cancel', () => {
    if (patcher) patcher.cancel();
  });

  handle('game:play', async () => {
    if (gameProcess) return { ok: false, code: 'already-running', message: 'The game is already running.' };
    if (line) return { ok: false, code: 'in-line', message: "You're already in line." };
    try {
      const current = getPatcher();
      if (current) {
        if (current.busy) return { ok: false, code: 'updating', message: 'Wait for the update to finish.' };
        // Check again now: an update may have come out since the last check,
        // and only the latest version may play.
        try {
          await current.confirmLatest();
        } catch (err) {
          return {
            ok: false, code: 'update-check-failed', retryable: true,
            message: `Couldn't check for updates, so the game can't start yet: ${err.message}`,
          };
        }
        updateLauncher(current.lastManifest);
        let ready = current.readyToPlay();
        if (!ready.ok) {
          // A newer release may change no game files; check() records it.
          try {
            await current.check();
          } catch {
            // readyToPlay below still says what's wrong.
          }
          ready = current.readyToPlay();
        }
        if (!ready.ok) return { ok: false, code: 'update-required', message: ready.reason };
      }
      const gameDir = getGameDir();
      const files = game.checkGameFiles(gameDir);
      if (!files.ok) return { ok: false, code: 'missing-files', message: files.message };
      game.hideCodeFolders(gameDir);
      const settings = config.get();
      const program = game.findGameProgram(gameDir, settings.pythonPath);
      // a Windows client on Linux/macOS: pick a runner and make the prefix first
      let wineLaunch = null;
      if (program.wine) {
        try {
          let runner;
          try {
            runner = wine.findWine({ settings, dataDir: app.getPath('userData') });
          } catch (err) {
            if (err.code === 'wine-missing' && process.platform === 'darwin') {
              send('game:event', { type: 'starting', detail: 'Downloading Wine runner' });
              runner = await wine.downloadRunner({
                dataDir: app.getPath('userData'),
                url: config.get().wineRunnerMacUrl,
                log: (text) => send('patcher:log', { text }),
                progress: (pct) => send('game:event', { type: 'starting', detail: `Downloading Wine (${pct}%)` }),
              });
            } else {
              throw err;
            }
          }
          const prefix = wine.resolvePrefix({
            settings,
            userDataDir: app.getPath('userData'),
            appDir: path.dirname(app.getPath('exe')),
            gameDir,
          });
          // The game folder usually sits inside a prefix of its own (a Wine
          // or Proton install); that prefix is used as it is.  Only a new
          // one has to be made, which is slow, so say so while it happens.
          if (!wine.prefixReady(prefix.dir)) {
            send('game:event', { type: 'starting', detail: 'Setting up Wine' });
            await wine.ensurePrefix(prefix.dir, runner, { dataDir: app.getPath('userData'), log: (text) => send('patcher:log', { text }) });
          } else if (process.platform === 'darwin') {
            await wine.ensureWineMetalGL(prefix.dir, runner, { dataDir: app.getPath('userData'), log: (text) => send('patcher:log', { text }) });
          }
          wineLaunch = { command: runner.command, prefix: prefix.dir, dllOverrides: wine.wineDllOverrides() };
        } catch (err) {
          return { ok: false, code: err.code || 'wine-missing', message: err.message };
        }
      }
      // While Toon Valley is full, this waits in line (line.js).
      line = new Line({ auth, onUpdate: (update) => send('line:update', update) });
      let playToken;
      try {
        playToken = await line.waitForTurn();
      } finally {
        const waited = line.waited;
        line = null;
        // It's their turn: get their attention if they've looked away.
        if (waited && playToken && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
          mainWindow.flashFrame(true);
        }
      }
      if (!playToken) return { ok: false, code: 'left-line', message: 'You left the line.' };
      const launch = game.buildLaunch({
        gameDir, program, host: settings.gameServerHost, port: settings.gameServerPort, playToken,
        gameVersion: current ? current.installedVersion() : null, wine: wineLaunch,
      });
      gameProcess = game.launchGame(launch, (event) => {
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        // Out of the way while the game runs (it gets the computer to
        // itself), and back when the game closes.
        if (event.type === 'running' && win) win.minimize();
        if (event.type === 'exited' || event.type === 'error') {
          gameProcess = null;
          if (quitWhenGameExits) app.quit();
          else if (win && win.isMinimized()) win.restore();
        }
        send('game:event', event);
      });
      return { ok: true };
    } catch (err) {
      gameProcess = null;
      return errorPayload(err);
    }
  });

  ipcMain.on('window:minimize', (event) => fromLauncherPage(event) && mainWindow.minimize());
  ipcMain.on('window:close', (event) => fromLauncherPage(event) && mainWindow.close());

  handle('link:open', (_event, url) => {
    if (typeof url !== 'string' || url.length > 2048 || !linkAllowed(url, config.get())) return;
    shell.openExternal(url.startsWith('mailto:') ? reportEmail(url) : url);
  });

  // The website's news, or null to keep the built-in news.
  handle('news:get', () => (config.get().newsUrl ? fetchNews(config.get().newsUrl) : null));
}

// "What's new" after the launcher has updated itself: the notes for the
// versions since the one that ran before, worked out once at start. The
// version that ran last is kept in its own small file, which Reset to
// defaults leaves alone.
let whatsNew = null;
function noteLauncherVersion() {
  const current = app.getVersion();
  const file = path.join(app.getPath('userData'), 'launcher-version.txt');
  let previous = null;
  try {
    previous = fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    // First start of a launcher that records its version.
  }
  // Launchers before 1.0.7 didn't record it: an installed game means this
  // player had an older launcher, rather than having just installed.
  const patcherNow = getPatcher();
  const updated = Boolean(patcherNow && patcherNow.installedVersion());
  whatsNew = changelog.whatsNew(previous, current, { updated });
  // A new launcher in place of the old one: show its icon on the shortcuts.
  // A few seconds after the window is up, so nothing here can keep the
  // launcher from opening.
  const exePath = portableExePath();
  if (previous !== current && (previous || updated) && exePath && process.platform === 'win32') {
    setTimeout(() => {
      try {
        refreshShortcutIcons({
          exePath, folders: shortcutFolders(app), shell, spawn: require('child_process').spawn,
          log: (message) => patcherNow && patcherNow.log(message),
        });
      } catch {
        // Only the icons; never worth stopping the launcher for.
      }
    }, 5000);
  }
  if (previous !== current) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, current);
    } catch {
      // Not important enough to stop the launcher.
    }
  }
}

// One launcher at a time: a second one would fight over the game folder.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (app.isReady() && config) {
      // Its window was closed while the game ran, so this launcher stayed on
      // in the background: opening the launcher again brings a window back,
      // rather than doing nothing.
      createWindow();
    }
  });
}

app.whenReady().then(() => {
  if (!singleInstance) return;
  Menu.setApplicationMenu(null);
  config = new Config(path.join(app.getPath('userData'), 'settings.json'));
  auth = new AuthClient(() => config.get().loginApiUrl);
  // The page never needs a camera, notifications or the like.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  downloadAuth = new DownloadAuth({
    getBaseUrl: () => config.get().loginApiUrl,
    file: path.join(app.getPath('userData'), 'update-device.bin'),
    safeStorage,
    log: (message) => (patcher ? patcher.log(message) : console.log(message)),
  });
  savedLogin = new SavedLogin({
    file: path.join(app.getPath('userData'), 'saved-login.bin'),
    safeStorage,
    log: (message) => (patcher ? patcher.log(message) : console.log(message)),
  });
  // A PC registered earlier gets its download token straight away, so
  // updates work without logging in.
  downloadAuth.start().catch(() => {});
  const updater = getSelfUpdater();
  if (updater) updater.cleanUp();
  // Only the installed launcher has releases to talk about.
  if (app.isPackaged) noteLauncherVersion();
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Closed without pressing Restart: a downloaded launcher still replaces
// this one, ready for the next start.
// A newer launcher app.asar downloaded as app.asar.next is swapped in once
// this process is gone (see asarSwap.js).
// A downloaded launcher app.asar is normally written next to this launcher
// (Launcher/resources/app.asar.next, swapped in once we exit).  A launcher
// that lives outside the game folder - the Linux build, or one unpacked
// from the release zip - gets it inside the game folder instead, because
// the patcher can only write there; move it across and swap it too.
function finishAsarSwap(log) {
  const swap = require('./asarSwap');
  // On non-Windows platforms (macOS / Linux), the game manifest from the server
  // ships a Windows launcher app.asar. Never allow it to overwrite the native launcher!
  if (process.platform !== 'win32') {
    try {
      const staged = swap.pendingPath(path.join(getGameDir(), 'Launcher', 'resources'));
      if (fs.existsSync(staged)) fs.unlinkSync(staged);
    } catch {}
    try {
      const local = swap.pendingPath(process.resourcesPath);
      if (fs.existsSync(local)) fs.unlinkSync(local);
    } catch {}
    try {
      const old = path.join(process.resourcesPath, 'app.asar.old');
      if (fs.existsSync(old)) fs.unlinkSync(old);
    } catch {}
    return false;
  }
  try {
    if (swap.finishOnExit(process.resourcesPath, log)) return true;
  } catch (err) {
    log(`launcher app.asar: ${err.message}`);
  }
  try {
    const resources = process.resourcesPath;
    const staged = swap.pendingPath(path.join(getGameDir(), 'Launcher', 'resources'));
    if (!fs.existsSync(staged)) return false;
    const local = swap.pendingPath(resources);
    if (!fs.existsSync(local)) fs.copyFileSync(staged, local);
    fs.unlinkSync(staged);
    log('launcher app.asar: pulled the downloaded one out of the game folder');
    return swap.finishOnExit(resources, log);
  } catch (err) {
    log(`launcher app.asar: ${err.message}`);
    return false;
  }
}
app.on('will-quit', () => {
  finishAsarSwap((line) => patcher && patcher.log(line));

  if (selfUpdater) {
    try {
      selfUpdater.finishOnExit();
    } catch (err) {
      if (patcher) patcher.log(`launcher update: couldn't start the swap: ${err.message}`);
    }
  }
});

app.on('window-all-closed', () => {
  // Swap a downloaded app.asar in as soon as the last window is gone; on
  // Wine and on hard window closes `will-quit` doesn't always run.
  finishAsarSwap((line) => patcher && patcher.log(line));
  auth && auth.logout();
  if (patcher) patcher.cancel();
  // The game's output comes through a pipe to the launcher, so quitting now
  // could crash it: stay in the background until the game exits.
  if (gameProcess) {
    quitWhenGameExits = true;
    return;
  }
  if (process.platform !== 'darwin') app.quit();
});
