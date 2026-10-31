'use strict';

const api = window.launcher;
const $ = (id) => document.getElementById(id);

let settings = null;
let loggedIn = false;
let busy = false;
let gameRunning = false;
let lastStatus = null;
// The patcher, when updates are set up: the last check's result, or its error.
const patch = { enabled: false, status: null, installedVersion: null, latestVersion: null, downloadBytes: 0, error: null, running: false, updating: false };

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatEta(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return `about ${Math.max(1, seconds)} s left`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${(seconds / 3600).toFixed(1)} h left`;
}

// The progress board: bar state ('idle', 'busy', 'ready', 'error' or
// 'progress' with a percentage) and text.
function setProgress(state, text, { percent = null, detail = '' } = {}) {
  window.scene.trolley(state, percent);
  $('game-state').textContent = text;
  $('progress-detail').textContent = detail;
}

function showMessage(message) {
  $('message').textContent = message || '';
  $('message').hidden = !message;
}

// The small button on the progress board: Update, Retry or Cancel.
let patchAction = null;
// For accounts without Alpha access: a button to the website's account
// page, where they can enter a key or join the Alpha list.
function offerAccountPage() {
  if (settings.accountUrl) setPatchAction('Open my account', () => api.openLink(settings.accountUrl));
}

function setPatchAction(label, action) {
  patchAction = action;
  $('patch-action').textContent = label || '';
  $('patch-action').hidden = !label;
}

// The big button: LOG IN until logged in, then PLAY (or UPDATE when
// the game needs updating first).
function setButton({ mode, label, loading = false, disabled = false }) {
  const button = $('play-button');
  if (mode) button.dataset.mode = mode;
  if (label) button.querySelector('.label').textContent = label;
  button.classList.toggle('loading', loading || mode === 'updating');
  button.disabled = loading || disabled;
}

function needsUpdate() {
  return patch.enabled && !patch.error && ['update', 'not-installed', 'repair'].includes(patch.status);
}

function updateLabel() {
  return patch.status === 'not-installed' ? 'INSTALL' : (patch.status === 'repair' ? 'REPAIR' : 'UPDATE');
}

// Sets the round button for the current state, when nothing is running.
function showMainButton() {
  if (busy || gameRunning || patch.updating) return;
  if (!loggedIn) setButton({ mode: 'login', label: 'LOG IN' });
  // Still checking for updates: wait for the answer before playing.
  else if (patch.running) setButton({ mode: 'play', label: 'PLAY', loading: true });
  else if (needsUpdate()) setButton({ mode: 'update', label: updateLabel() });
  else setButton({ mode: 'play', label: 'PLAY' });
}

function showVersion() {
  const game = patch.installedVersion ? ` · Game v${patch.installedVersion}` : '';
  $('version').textContent = `Launcher v${settings.appVersion}${game} · ALPHA`;
  if (patch.enabled) {
    const installed = patch.installedVersion ? `Installed: v${patch.installedVersion}` : 'Not installed yet';
    const latest = patch.latestVersion ? ` · Latest: v${patch.latestVersion}` : '';
    $('game-version').textContent = installed + latest;
  }
}

// What the progress board says when nothing is happening.
function showIdleState() {
  if (busy || gameRunning || patch.running) return;
  showMainButton();
  setPatchAction(null);
  if (patch.enabled && patch.error) {
    setProgress('error', "Couldn't check for updates");
    // (Play checks for updates again first, and only the latest version
    // may play: so not "you can still play".)
    showMessage(patch.installedVersion ? `${patch.error.message} The game can start again once the update server answers.` : patch.error.message);
    if (patch.error.retryable) setPatchAction('Retry', checkForUpdates);
    return;
  }
  if (needsUpdate()) {
    showMessage('');
    const size = patch.downloadBytes ? ` (${formatBytes(patch.downloadBytes)})` : '';
    const text = patch.status === 'not-installed' ? `Toon Valley needs to be installed${size}`
      : patch.status === 'repair' ? `Some game files need repairing${size}`
        : `Update available${size}`;
    setProgress('idle', text);
    setPatchAction(patch.status === 'not-installed' ? 'Install' : (patch.status === 'repair' ? 'Repair' : 'Update'), () => startUpdate());
    return;
  }
  // Without the patcher, a game folder with files missing is worth saying.
  if (!patch.enabled && lastStatus && !lastStatus.files.ok) {
    setProgress('error', 'Game files are missing');
    showMessage(lastStatus.files.message);
  } else if (!loggedIn) {
    setProgress('idle', 'Log in to play!');
  } else {
    setProgress('ready', 'Ready to go!');
  }
}

function setPill(id, state, text) {
  const pill = $(id);
  pill.dataset.state = state;
  pill.querySelector('em').textContent = text;
}

// Server status.

// The lights are checked again this often while the launcher is on screen
// (and the game isn't running), so a server going down or coming back
// shows without pressing F5.
const STATUS_EVERY_MS = 60000;
let statusInFlight = null;
let statusCheckedAt = 0;

// One check at a time: a check asked for while one is running gets its answer.
function checkServers() {
  if (!statusInFlight) {
    statusInFlight = api.checkStatus().finally(() => {
      statusInFlight = null;
      statusCheckedAt = Date.now();
    });
  }
  return statusInFlight;
}

function showStatus(status) {
  setPill('status-api', status.loginApi.online ? 'online' : 'offline', status.loginApi.online ? 'Online' : status.loginApi.detail);
  setPill('status-game', status.gameServer.online ? 'online' : 'offline', status.gameServer.online ? 'Online' : status.gameServer.detail);
  lastStatus = status;
}

async function refreshStatus() {
  setPill('status-api', 'checking', 'Checking…');
  setPill('status-game', 'checking', 'Checking…');
  // Render can take a while to wake the login server.
  const slow = setTimeout(() => setPill('status-api', 'checking', 'Waking up…'), 5000);
  try {
    const status = await checkServers();
    showStatus(status);
    showIdleState();
    return status;
  } finally {
    clearTimeout(slow);
  }
}

// A check in the background: the lights change when the answer comes, with
// no "Checking…" in between, and nothing else on the page is touched.
async function refreshStatusQuietly() {
  if (document.hidden || gameRunning) return;
  try {
    showStatus(await checkServers());
  } catch {
    // The next one will try again.
  }
}

// Updates.

function applyCheckResult(result) {
  if (result.ok) {
    patch.status = result.status;
    patch.installedVersion = result.installedVersion;
    patch.latestVersion = result.latestVersion;
    patch.downloadBytes = result.downloadBytes;
    patch.error = null;
    patch.checkedAt = new Date();
  } else {
    patch.error = { message: result.message, retryable: result.retryable };
    if (result.installedVersion !== undefined) patch.installedVersion = result.installedVersion;
  }
  showVersion();
}

// A check asked for while logging in or playing runs once that's done.
let checkWhenIdle = false;

async function checkForUpdates() {
  if (!patch.enabled || patch.running) return;
  if (busy || gameRunning) {
    checkWhenIdle = true;
    return;
  }
  patch.running = true;
  setPatchAction(null);
  showMessage('');
  setProgress('busy', 'Checking for updates…');
  try {
    applyCheckResult(await api.checkUpdates());
  } finally {
    patch.running = false;
    showIdleState();
  }
}

async function startUpdate({ repair = false } = {}) {
  if (!patch.enabled || busy || gameRunning || patch.running) return;
  patch.running = true;
  patch.updating = true;
  showMessage('');
  setPatchAction('Cancel', () => api.cancelUpdate());
  // Logged out, the button stays LOG IN, so players can log in meanwhile.
  if (loggedIn) setButton({ mode: 'updating', label: repair ? 'REPAIRING' : 'UPDATING', disabled: true });
  setProgress('busy', repair ? 'Checking every game file…' : 'Starting the update…');
  let result;
  try {
    result = await api.update({ repair });
  } finally {
    patch.running = false;
    patch.updating = false;
  }
  setPatchAction(null);
  if (result.ok) {
    applyCheckResult(result);
    showIdleState();
    if (patch.status === 'up-to-date') {
      setProgress('ready', loggedIn ? 'All up to date. Ready to go!' : 'All up to date. Log in to play!');
      window.scene.confetti(0.5, 0.8);
      window.scene.sound('pop');
    }
  } else if (result.code === 'cancelled') {
    showIdleState();
    setProgress('idle', 'Update paused. It will continue where it stopped.');
    setPatchAction('Resume', () => startUpdate({ repair }));
  } else if (result.code === 'login-required') {
    // The download server wants an account with Alpha access. Logging in
    // registers this PC, and the board then offers the update again.
    showMainButton();
    setProgress('error', loggedIn ? "This account can't download the game yet" : 'Log in to download the game');
    showMessage(result.message);
    if (!loggedIn) setPatchAction('Log in', focusLogin);
    else offerAccountPage();
  } else {
    showMainButton();
    setProgress('error', repair ? "The repair didn't finish" : "The update didn't finish");
    showMessage(result.message);
    if (result.retryable) setPatchAction('Retry', () => startUpdate({ repair }));
  }
}

// The game's own files are never named: players see that files are being
// downloaded, how much and how fast, not which.
function handleUpdateProgress(p) {
  if (!patch.running) return;
  const percent = p.bytesTotal ? Math.floor((p.bytesDone / p.bytesTotal) * 100) : 0;
  if (p.stage === 'checking') {
    setProgress('busy', 'Checking for updates…');
  } else if (p.stage === 'verifying') {
    setProgress('progress', `Checking game files… ${percent}%`, { percent });
  } else if (p.stage === 'downloading') {
    const parts = [`${formatBytes(p.bytesDone)} of ${formatBytes(p.bytesTotal)}`];
    if (p.speed) parts.push(`${formatBytes(p.speed)}/s`);
    const eta = formatEta(p.eta);
    if (eta) parts.push(eta);
    setProgress('progress', `Downloading files… ${percent}%`, { percent, detail: parts.join(' · ') });
  } else if (p.stage === 'applying') {
    // Files are being replaced: this part can't be cancelled.
    setPatchAction(null);
    const filePercent = p.filesTotal ? Math.floor((p.filesDone / p.filesTotal) * 100) : 100;
    setProgress('progress', `Installing files… ${filePercent}%`, { percent: filePercent });
  } else if (p.stage === 'done') {
    setProgress('ready', 'Update complete!');
  }
}

// The server, in words (the addresses aren't shown).
function showServer() {
  $('server-line').textContent = `Playing on ${settings.serverName}`;
}

// Logging in and out.

function showLoggedIn(username) {
  loggedIn = true;
  $('player-name').textContent = username;
  showServer();
  $('login-form').hidden = true;
  $('play-card').hidden = false;
  showMainButton();
  $('play-button').focus();
}

// Clears the password box, hiding what's typed again.
function clearPassword() {
  $('password').value = '';
  if ($('password').type !== 'password') toggleShowPassword();
}

function focusLogin() {
  ($('username').value ? $('password') : $('username')).focus();
}

function showLoggedOut() {
  loggedIn = false;
  $('play-card').hidden = true;
  $('login-form').hidden = false;
  clearPassword();
  showMainButton();
  focusLogin();
  showSavedLogin();
}

// "Remember password": fills in the saved login, if any (it never logs in by
// itself), or greys the box out where passwords can't be kept securely.
async function showSavedLogin() {
  let result = null;
  try {
    result = await api.getSavedLogin();
  } catch {
    // Treated as nothing saved.
  }
  const box = $('remember-password');
  box.disabled = !(result && result.available);
  $('remember-password-label').title = box.disabled
    ? "This computer has nowhere secure to keep passwords, so the launcher can't remember yours." : '';
  box.checked = Boolean(result && result.saved);
  // Unless the player has started typing meanwhile.
  if (result && result.saved && !loggedIn && !$('password').value) {
    $('username').value = result.saved.username;
    $('password').value = result.saved.password;
    $('remember').checked = true;
    focusLogin();
  }
}

async function handleLogin() {
  if (busy) return;
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username) {
    showMessage('Enter your username.');
    return $('username').focus();
  }
  if (!password) {
    showMessage('Enter your password.');
    return $('password').focus();
  }
  showMessage('');
  busy = true;
  setButton({ loading: true });
  // An update (not just a check) keeps its own progress on the board.
  const updating = patch.updating;
  if (!updating) setProgress('busy', 'Logging in…');
  let ok = false;
  try {
    if ($('remember').checked !== settings.rememberUsername) {
      const saved = await api.saveSettings({ rememberUsername: $('remember').checked });
      settings = saved.settings;
    }
    const result = await api.login(username, password, $('remember-password').checked);
    ok = result.ok;
    if (ok) {
      clearPassword();
      busy = false;
      showLoggedIn(result.username);
      window.scene.confetti(0.84, 0.32, 60);
      window.scene.sound('pop');
    } else {
      showMessage(result.message);
      if (!updating) setProgress('error', "Couldn't log in");
      if (result.code === 'invalid-credentials') $('password').select();
      if (result.code === 'no-access') offerAccountPage();
    }
  } finally {
    busy = false;
    setButton({ loading: false });
    if (patch.updating) {
      if (loggedIn) setButton({ mode: 'updating', label: 'UPDATING', disabled: true });
    } else if (ok) {
      showIdleState();
    }
    runPendingCheck();
  }
}

function runPendingCheck() {
  if (checkWhenIdle && !busy && !gameRunning) {
    checkWhenIdle = false;
    checkForUpdates();
  }
}

async function handleLogout() {
  if (busy || gameRunning) return;
  await api.logout();
  showMessage('');
  showLoggedOut();
  showIdleState();
}

// The password box: show or hide what's typed, and warn about Caps Lock.

function toggleShowPassword() {
  const input = $('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const button = $('show-password');
  button.setAttribute('aria-pressed', String(show));
  button.title = show ? 'Hide password' : 'Show password';
  button.setAttribute('aria-label', button.title);
  input.focus();
}

function updateCapsWarning(event) {
  if (!event.getModifierState) return;
  $('caps-warning').hidden = !event.getModifierState('CapsLock');
}

// Playing.

// Waiting in line while Toon Valley is full (main/line.js): update is the
// place in line, { reconnecting } while the login server isn't answering,
// or null once the wait is over.
function showLine(update) {
  if (!update) {
    showMessage('');
    setPatchAction(null);
    setProgress('busy', 'Starting Toon Valley…');
    return;
  }
  setButton({ mode: 'line', label: 'IN LINE', loading: true });
  setPatchAction('Leave line', () => api.leaveLine());
  if (update.reconnecting) {
    setProgress('busy', 'Reconnecting to the login server… You keep your place.');
    return;
  }
  // (Not a problem, so not in the message box.)
  const { position, playing } = update;
  setProgress('busy', position === 1 ? "You're next in line!" : `You're number ${position} in line`, {
    detail: `Toon Valley is full right now, with ${playing} ${playing === 1 ? 'Toon' : 'Toons'} playing. `
      + "Keep the launcher open: the game starts by itself when it's your turn.",
  });
}

async function handlePlay() {
  if (busy || gameRunning || patch.running) return;
  busy = true;
  showMessage('');
  setPatchAction(null);
  setButton({ loading: true });
  setProgress('busy', patch.enabled ? 'Checking for updates…' : 'Starting Toon Valley…');
  const result = await api.play();
  if (!result.ok) {
    busy = false;
    setButton({ loading: false });
    if (result.code === 'left-line') {
      showIdleState();
      showMessage(result.message);
      return;
    }
    if (result.code === 'update-required' && patch.enabled) {
      // Show the update that's needed (the round button becomes UPDATE).
      await checkForUpdates();
      if (needsUpdate()) return;
    }
    showMessage(result.message);
    setProgress('error', "Couldn't start the game");
    if (result.code === 'expired') showLoggedOut();
    if (result.code === 'no-access') offerAccountPage();
    if (result.code === 'update-required' && patch.enabled) {
      setPatchAction('Update', () => startUpdate());
    } else if (result.code === 'update-check-failed') {
      setPatchAction('Retry', handlePlay);
    }
  }
}

// How long a play session lasted, in words.
function formatPlayTime(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} h${rest ? ` ${rest} min` : ''}`;
}

let sessionStart = null;

function handleGameEvent(event) {
  if (event.type === 'starting') {
    setProgress('busy', event.detail || 'Starting…');
  } else if (event.type === 'started') {
    setProgress('busy', 'Loading the game…');
    window.scene.sound('bell', 0.4);
  } else if (event.type === 'running') {
    gameRunning = true;
    sessionStart = Date.now();
    window.scene.setGameRunning(true);
    $('session-line').hidden = true;
    setProgress('ready', 'Toon Valley is running. Have fun!');
    setButton({ mode: 'playing', label: 'PLAYING', loading: false, disabled: true });
  } else if (event.type === 'exited' || event.type === 'error') {
    busy = false;
    gameRunning = false;
    window.scene.setGameRunning(false);
    if (sessionStart) {
      $('session-line').textContent = `You played for ${formatPlayTime(Date.now() - sessionStart)}. See you soon!`;
      $('session-line').hidden = false;
      sessionStart = null;
    }
    setButton({ loading: false, disabled: false });
    showMainButton();
    if (event.type === 'error') {
      showMessage(event.message);
      setProgress('error', "Couldn't start the game");
    } else if (event.code !== 0 && event.code !== null) {
      showMessage(`The game closed unexpectedly (exit code ${event.code}).${event.output ? `\n${event.output}` : ''}\nIts log is in the logs folder: press Open logs, and send the newest one with your bug report.`);
      setProgress('error', 'The game closed unexpectedly');
      setPatchAction('Open logs', openLogs);
    } else {
      showIdleState();
    }
    runPendingCheck();
    // The servers may have changed while the game ran (or be why it closed).
    refreshStatusQuietly();
  }
}

function handleBigButton() {
  if ($('play-button').disabled) return;
  window.scene.sound('click', 0.35);
  if (!loggedIn) handleLogin();
  else if (needsUpdate()) startUpdate({ repair: patch.status === 'repair' });
  else handlePlay();
}

// News and links, from the launcher's configuration.

// The news, as the pages of a Shticker Book: the built-in news first,
// then the website's once it arrives. The pages turn by themselves every
// little while, unless someone's reading.
const news = { items: [], page: 0, timer: null };
const PAGE_SECONDS = 9;

function renderNews(items = settings.news) {
  news.items = Array.isArray(items) ? items.filter((item) => item && (item.title || item.body)) : [];
  news.page = 0;
  const pages = $('news');
  const dots = $('news-dots');
  pages.replaceChildren();
  dots.replaceChildren();
  if (!news.items.length) {
    const page = document.createElement('article');
    page.className = 'page';
    page.dataset.pos = 'current';
    const empty = document.createElement('p');
    empty.textContent = 'No news yet. Check back soon!';
    page.append(empty);
    pages.append(page);
  }
  news.items.forEach((item, index) => {
    const page = document.createElement('article');
    page.className = 'page';
    const title = document.createElement('h3');
    title.textContent = item.title || '';
    const body = document.createElement('p');
    body.textContent = item.body || '';
    page.append(title, body);
    if (item.date || item.url) {
      const footer = document.createElement('div');
      footer.className = 'date';
      footer.textContent = item.date || '';
      if (item.url) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'read-more';
        more.textContent = 'Read more';
        more.addEventListener('click', () => api.openLink(item.url));
        footer.append(more);
      }
      page.append(footer);
    }
    pages.append(page);
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'dot';
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-label', `Page ${index + 1}: ${item.title || ''}`);
    dot.addEventListener('click', () => showPage(index));
    dots.append(dot);
  });
  $('news-prev').hidden = news.items.length < 2;
  $('news-next').hidden = news.items.length < 2;
  showPage(0, true);
}

function showPage(index, quiet = false) {
  const count = news.items.length;
  if (!count) return;
  news.page = (index + count) % count;
  $('news').querySelectorAll('.page').forEach((page, i) => {
    page.dataset.pos = i === news.page ? 'current' : (i < news.page ? 'before' : 'after');
    page.setAttribute('aria-hidden', String(i !== news.page));
    if (i === news.page) page.scrollTop = 0;
  });
  $('news-dots').querySelectorAll('.dot').forEach((dot, i) => dot.setAttribute('aria-selected', String(i === news.page)));
  if (!quiet) window.scene.sound('click', 0.2);
  scheduleNextPage();
}

function scheduleNextPage() {
  clearTimeout(news.timer);
  if (news.items.length < 2) return;
  news.timer = setTimeout(() => {
    const book = document.querySelector('.book');
    // Not while someone's reading, or the game is running.
    if (book.matches(':hover') || book.contains(document.activeElement) || gameRunning || document.hidden) scheduleNextPage();
    else showPage(news.page + 1, true);
  }, PAGE_SECONDS * 1000);
}

// A Toon Tip under the news, a new one now and then.
const TIPS = [
  'Press the Halloween Town button on your Shticker Book map to visit the spookiest place in the valley.',
  'Toon-Up gags heal your friends, not you: team up!',
  'Lure a Cog before you Throw or Squirt for extra damage.',
  "Fish in every pond: each one has fish the others don't.",
  "Plant flowers at your estate. They grow while you're away.",
  'Find Toons to play with in the Group Tracker, in your Shticker Book.',
  'Challenge a friend to a duel from their Toon Card.',
  'Sound gags hit every Cog at once.',
  'Report a bug from the links below, and send the newest game log with it.',
];

function showTip() {
  const tip = TIPS[Math.floor(Math.random() * TIPS.length)];
  const line = $('toon-tip');
  line.replaceChildren();
  const label = document.createElement('b');
  label.textContent = 'Toon Tip: ';
  line.append(label, tip);
}

const ICONS = {
  chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/></svg>',
  web: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/></svg>',
  discord: '<svg viewBox="0 0 127.14 96.36" aria-hidden="true"><path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15zM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69z"/></svg>',
};

function renderLinks() {
  const textLinks = $('text-links');
  const icons = $('icon-links');
  textLinks.textContent = '';
  icons.querySelectorAll('.icon:not(.settings)').forEach((el) => el.remove());
  const links = (settings.links || []).filter((link) => link && link.url);
  for (const link of links) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = link.url.startsWith('mailto:') ? `Email ${link.url.slice(7)}` : link.url;
    button.addEventListener('click', () => api.openLink(link.url));
    if (link.place === 'icon') {
      button.className = `icon ${ICONS[link.icon] ? link.icon : 'web'}`;
      button.setAttribute('aria-label', link.label);
      button.innerHTML = ICONS[link.icon] || ICONS.web; // Fixed markup from ICONS, never from config.
      icons.insertBefore(button, $('open-settings'));
    } else {
      if (textLinks.children.length) textLinks.appendChild(document.createElement('span'));
      button.textContent = link.label;
      textLinks.appendChild(button);
    }
  }
}

// Settings: updates and logs.

function fillSettingsForm() {
  $('game-files').hidden = !patch.enabled;
  $('repair-button').disabled = patch.running || gameRunning;
  showVersion();
  showSettingsGameState();
  fillRuntimeSettings();
  $('launcher-help').textContent = `Launcher v${settings.appVersion}`;
}

// The Game section: which folder the game is in, and (where the game is a
// Windows build run through Wine) which Wine and which prefix to use. Blank
// means automatic: the launcher finds the game next to itself, and the prefix
// the game is installed in (or one of its own).
function fillRuntimeSettings() {
  // The game folder is always choosable; the Wine rows only exist where the
  // game runs through Wine (the game runs natively on Windows).
  const asksForWine = settings.platform !== 'win32';
  $('game-folder-help').textContent = settings.gameDir || `${settings.resolvedGameDir} (found automatically)`;
  $('reset-game-folder').hidden = !settings.gameDir;
  $('wine-settings').hidden = !asksForWine;
  if (!asksForWine) return;
  $('wine-help').textContent = settings.winePath || (settings.platform === 'darwin'
    ? 'Automatic: system Wine, then installed Wine apps, then a downloaded runner.'
    : 'Automatic: system Wine, then Steam Proton, then a downloaded runner.');
  $('reset-wine').hidden = !settings.winePath;
  $('wine-prefix-help').textContent = settings.winePrefix || "Automatic: the prefix the game is installed in, else the launcher's own.";
  $('reset-wine-prefix').hidden = !settings.winePrefix;
}

// Saves one of the Game section's settings and shows the result (the chosen
// folder may not be a game folder, which the status line then says).
async function saveRuntimeSetting(changes) {
  const result = await api.saveSettings(changes);
  settings = result.settings;
  fillRuntimeSettings();
  if (!result.ok) {
    const message = Object.values(result.errors || {})[0] || 'That setting could not be saved.';
    $('game-folder-help').textContent = message;
    showMessage(message);
    return;
  }
  refreshStatus();
}

async function chooseGameFolder() {
  const dir = await api.chooseFolder(settings.gameDir || settings.resolvedGameDir);
  if (dir) await saveRuntimeSetting({ gameDir: dir });
}

async function chooseWine() {
  const file = await api.chooseFile(settings.winePath || '');
  if (file) await saveRuntimeSetting({ winePath: file });
}

async function chooseWinePrefix() {
  const dir = await api.chooseFolder(settings.winePrefix || '');
  if (dir) await saveRuntimeSetting({ winePrefix: dir });
}

// The Game files row in Settings: versions, and whether there's an update.
function showSettingsGameState() {
  const button = $('check-game');
  if (patch.error) {
    $('game-version').textContent += ` · ${patch.error.message}`;
  }
  if (needsUpdate()) {
    button.textContent = patch.status === 'not-installed' ? 'Install now' : (patch.status === 'repair' ? 'Repair now' : 'Update now');
    button.dataset.mode = 'update';
  } else {
    button.textContent = 'Check for updates';
    button.dataset.mode = 'check';
    if (!patch.error && patch.status === 'up-to-date') $('game-version').textContent += ' · Up to date';
  }
  $('game-checked').textContent = patch.checkedAt
    ? `Last checked at ${patch.checkedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  button.disabled = patch.running || busy || gameRunning;
}

async function checkGameFromSettings() {
  if (patch.running || busy || gameRunning) return;
  if ($('check-game').dataset.mode === 'update' && needsUpdate()) {
    closeSettings();
    startUpdate();
    return;
  }
  $('check-game').disabled = true;
  $('check-game').textContent = 'Checking…';
  await checkForUpdates();
  showSettingsGameState();
}

async function checkLauncherFromSettings() {
  const button = $('check-launcher');
  const help = $('launcher-help');
  button.disabled = true;
  button.textContent = 'Checking…';
  const result = await api.checkLauncher();
  button.disabled = false;
  button.textContent = 'Check for update';
  const current = `Launcher v${settings.appVersion}`;
  if (!result.ok) help.textContent = `${current} · ${result.message}`;
  else if (result.status === 'up-to-date') help.textContent = `${current} · Up to date`;
  else if (result.status === 'ready') help.textContent = `Launcher v${result.version} is ready: press Restart.`;
  else {
    launcherDownload = { version: result.version, size: result.size };
    help.textContent = `Downloading launcher${result.version ? ` v${result.version}` : ''} (${formatBytes(result.size)})… A Restart button appears when it's ready.`;
  }
}

// The launcher downloading its own update, as Settings shows it.
let launcherDownload = null;
function showLauncherProgress({ bytesDone, bytesTotal }) {
  if (!bytesTotal) return;
  const version = launcherDownload && launcherDownload.version ? ` v${launcherDownload.version}` : '';
  const percent = Math.floor((bytesDone / bytesTotal) * 100);
  $('launcher-help').textContent = `Downloading launcher${version}… ${percent}% (${formatBytes(bytesDone)} of ${formatBytes(bytesTotal)}). A Restart button appears when it's ready.`;
}

function showLauncherFailed({ message }) {
  launcherDownload = null;
  $('launcher-help').textContent = `The launcher update didn't download: ${message} Press Check for update to try again.`;
}

function openSettings() {
  fillSettingsForm();
  $('logs-help').textContent = 'Reporting a bug? Send the newest game log with it.';
  $('settings').hidden = false;
  window.scene.sound('click');
  $('close-settings').focus();
}

function closeSettings() {
  if ($('settings').hidden) return;
  $('settings').hidden = true;
  window.scene.sound('back');
  $('open-settings').focus();
}

// A new Launcher.exe was downloaded; it is used after a restart.
function showLauncherUpdate(version) {
  $('launcher-update-text').textContent = version && version !== 'new' ? `Launcher v${version} is ready.` : 'A new launcher is ready.';
  $('launcher-update').hidden = false;
  $('launcher-help').textContent = `${$('launcher-update-text').textContent} Press Restart on the main screen.`;
}

// Opens the game's logs folder. From Settings, a problem shows there (the
// panel covers the progress board).
async function openLogs() {
  const result = await api.openLogs();
  if (result.ok) return;
  if (!$('settings').hidden) $('logs-help').textContent = result.message;
  else showMessage(result.message);
}

// After the launcher updates itself, its first start says what changed.
function showWhatsNew(notes) {
  if (!notes || !notes.entries || !notes.entries.length) return;
  $('whats-new-lead').textContent = `The launcher is now v${notes.version}.`;
  const list = $('whats-new-list');
  list.replaceChildren();
  for (const entry of notes.entries) {
    if (notes.entries.length > 1) {
      const heading = document.createElement('h3');
      heading.textContent = `v${entry.version}`;
      list.append(heading);
    }
    const items = document.createElement('ul');
    for (const text of entry.items) {
      const item = document.createElement('li');
      item.textContent = text;
      items.append(item);
    }
    list.append(items);
  }
  $('whats-new').hidden = false;
  $('close-whats-new').focus();
}

function closeWhatsNew() {
  $('whats-new').hidden = true;
}

async function restartLauncher() {
  const result = await api.restartLauncher();
  if (!result.ok) showMessage(result.message);
}

async function init() {
  settings = await api.getSettings();
  document.title = settings.serverName;
  patch.enabled = Boolean(settings.updatesEnabled);
  patch.installedVersion = settings.installedVersion;
  showVersion();
  renderNews();
  api.getNews().then((news) => {
    if (news) renderNews(news);
  }).catch(() => {});
  renderLinks();
  showServer();
  $('remember').checked = settings.rememberUsername;
  $('username').value = settings.username || '';
  // Remembering the password remembers the username too.
  $('remember-password').addEventListener('change', () => {
    if ($('remember-password').checked) $('remember').checked = true;
  });
  $('remember').addEventListener('change', () => {
    if (!$('remember').checked) $('remember-password').checked = false;
  });

  // Enter in either box logs in (the form has no submit button of its own).
  for (const id of ['username', 'password']) {
    $(id).addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleLogin();
      }
    });
  }
  $('show-password').addEventListener('click', toggleShowPassword);
  $('password').addEventListener('keydown', updateCapsWarning);
  $('password').addEventListener('keyup', updateCapsWarning);
  $('password').addEventListener('blur', () => { $('caps-warning').hidden = true; });
  $('forgot-password').addEventListener('click', () => settings.forgotPasswordUrl && api.openLink(settings.forgotPasswordUrl));
  $('forgot-password').hidden = !settings.forgotPasswordUrl;
  $('play-button').addEventListener('click', handleBigButton);
  $('logout-button').addEventListener('click', handleLogout);
  $('refresh-status').addEventListener('click', refreshStatus);
  $('open-settings').addEventListener('click', openSettings);
  $('close-settings').addEventListener('click', closeSettings);
  $('settings').addEventListener('click', (event) => {
    if (event.target === $('settings')) closeSettings();
  });
  $('news-prev').addEventListener('click', () => showPage(news.page - 1));
  $('news-next').addEventListener('click', () => showPage(news.page + 1));
  $('news').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showPage(news.page - 1);
    if (event.key === 'ArrowRight') showPage(news.page + 1);
  });
  showTip();
  setInterval(() => {
    if (!document.hidden && !gameRunning) showTip();
  }, 45 * 1000);
  $('patch-action').addEventListener('click', () => patchAction && patchAction());
  $('repair-button').addEventListener('click', () => {
    closeSettings();
    startUpdate({ repair: true });
  });
  api.onUpdateProgress(handleUpdateProgress);
  $('launcher-restart').addEventListener('click', restartLauncher);
  $('open-logs').addEventListener('click', openLogs);
  $('check-game').addEventListener('click', checkGameFromSettings);
  $('choose-game-folder').addEventListener('click', chooseGameFolder);
  $('reset-game-folder').addEventListener('click', () => saveRuntimeSetting({ gameDir: '' }));
  $('choose-wine').addEventListener('click', chooseWine);
  $('reset-wine').addEventListener('click', () => saveRuntimeSetting({ winePath: '' }));
  $('choose-wine-prefix').addEventListener('click', chooseWinePrefix);
  $('reset-wine-prefix').addEventListener('click', () => saveRuntimeSetting({ winePrefix: '' }));
  $('check-launcher').addEventListener('click', checkLauncherFromSettings);
  api.onLauncherUpdated(({ version }) => showLauncherUpdate(version));
  api.onLauncherProgress(showLauncherProgress);
  api.onLauncherFailed(showLauncherFailed);
  api.launcherUpdated().then((version) => version && showLauncherUpdate(version));
  $('win-min').addEventListener('click', () => api.minimize());
  $('win-close').addEventListener('click', () => api.close());
  $('close-whats-new').addEventListener('click', closeWhatsNew);
  document.addEventListener('keydown', (event) => {
    const panelOpen = !$('whats-new').hidden || !$('settings').hidden;
    if (event.key === 'Escape' && !$('whats-new').hidden) closeWhatsNew();
    else if (event.key === 'Escape' && !$('settings').hidden) closeSettings();
    else if (event.key === 'F5') {
      event.preventDefault();
      refreshStatus();
    } else if (event.key === ',' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if ($('settings').hidden) openSettings();
      else closeSettings();
    } else if (event.key === 'Enter' && loggedIn && !panelOpen && !event.target.closest('button, input, a')) {
      // Enter anywhere plays (or updates), once logged in.
      event.preventDefault();
      handleBigButton();
    }
  });
  api.onGameEvent(handleGameEvent);
  api.onLineUpdate(showLine);

  showLoggedOut();
  api.whatsNew().then(showWhatsNew);
  setProgress('busy', 'Checking the servers…');
  // The lights kept up to date while the launcher is on screen, and checked
  // again on coming back into sight after a while away.
  setInterval(refreshStatusQuietly, STATUS_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - statusCheckedAt > STATUS_EVERY_MS) refreshStatusQuietly();
  });
  // Both at once: the login server can take a while to wake up, and the
  // update check shouldn't wait for it (players often log in meanwhile).
  await Promise.all([refreshStatus(), checkForUpdates()]);
}

init();
