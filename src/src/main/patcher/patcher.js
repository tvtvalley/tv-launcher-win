// The patcher: keeps the game folder matching the latest manifest.
//
// check() compares the game folder with the manifest. update() then:
//   1. downloads (or copies from a seed folder, such as the copy of the game
//      bundled with the installer) every file that is missing or different
//      into .patcher/staging, each checked against its size and SHA-256;
//   2. writes .patcher/pending.json, then replaces each file atomically (the
//      staged file is moved, or copied if another file shares it, next to
//      it, then renamed over it) and deletes files the release removed;
//   3. records the new state in .patcher/state.json and removes the journal.
// A file is never replaced by anything unverified. If the launcher stops
// during step 2, pending.json is still there on the next start: the folder is
// then fully re-verified and the update finished from the staged files.
//
// state.json remembers each installed file's size, SHA-256 and modification
// time, so a normal start only re-hashes files whose size or time changed.
// Repair (update({ repair: true })) re-hashes everything.
//
// Only files a manifest lists are ever written or deleted, and anything in
// the game's own folders (bin) that the release doesn't have. Player data
// (logs, screenshots, game settings) can't be listed, see paths.js.
//
// A manifest older than one already seen from the same address is refused
// (rollback.js); releaseFile is where that is remembered between starts.
//
// getToken (optional) returns the current download token (downloadAuth.js);
// it is sent only to the update hosts: the manifest's origin and the
// mirrors' (download.js). A 401 or 403 for a file stops the update with a
// 'login-required' error instead of retrying.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { PATCHER_DIR, GAME_FOLDERS, LAUNCHER_FILES, PathError, checkRelativePath, safeResolve } = require('./paths');
const { ManifestError, parseManifest, verifySignature, fileUrls, updateOrigins } = require('./manifest');
const { ReleaseHistory, RollbackError } = require('./rollback');
const { DownloadError, fetchBytes, downloadFile, hashFile, describe } = require('./download');

const STATE_SCHEMA = 1;
const LOG_LIMIT = 1024 * 1024;
const FILE_LIST_LIMIT = 200;
const STAGED_NAME = /^[0-9a-f]{64}(\.part|\.tmp)?$/;
const LOGIN_REQUIRED = 'Log in with an account that has Alpha access to download the game.';
const DISK_FULL = 'There is not enough disk space for the update. Free some space on the drive the game is installed on, then try again.';

class PatchError extends Error {
  constructor(code, message, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

// Turns any failure into a PatchError with a message for players.
function toPatchError(err) {
  if (err instanceof PatchError) return err;
  if (err instanceof DownloadError) {
    if (err.code === 'cancelled') return new PatchError('cancelled', 'The update was cancelled.', true);
    if (err.code === 'checksum') return new PatchError('checksum', 'A downloaded file was damaged even after retrying. Try again later.', true);
    if (err.code === 'unauthorized') return Object.assign(new PatchError('login-required', LOGIN_REQUIRED), { status: err.status });
    return new PatchError('download', `${err.message} Check your internet connection and try again.`, true);
  }
  // Most likely a cache still handing out the release before last; it
  // clears by itself.
  if (err instanceof RollbackError) return new PatchError(err.code, err.message, true);
  if (err instanceof ManifestError || err instanceof PathError) return new PatchError(err.code, err.message);
  if (err && (err.code === 'ENOSPC' || err.code === 'EDQUOT')) return new PatchError('disk-full', DISK_FULL, true);
  if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
    return new PatchError('access', 'The launcher could not write to the game folder. Close the game and try again.', true);
  }
  return new PatchError('unexpected', `The update failed (${(err && err.code) || 'error'}). Try again.`, true);
}

// Runs worker over items, at most `limit` at a time.
async function pool(items, limit, worker) {
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch {
    return null;
  }
}

// Deletes a file, read-only or not (Windows refuses to delete a read-only
// one, as a file copied from somewhere else can be).
function unlinkFile(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
    fs.chmodSync(file, 0o666);
    fs.unlinkSync(file);
  }
}

class Patcher extends EventEmitter {
  constructor({
    installDir, manifestUrl, mirrors = [], concurrency = 4, timeoutMs = 30000, retries = 3, publicKey = '',
    seedDirs = [], allowHttp = false, fsOps = {}, baseDelayMs, getToken = null, releaseFile = null,
  }) {
    super();
    this.installDir = path.resolve(installDir);
    this.manifestUrl = manifestUrl;
    this.mirrors = mirrors;
    this.concurrency = Math.max(1, concurrency);
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.publicKey = publicKey;
    this.seedDirs = seedDirs.filter((dir) => dir && path.resolve(dir) !== this.installDir);
    this.allowHttp = allowHttp;
    this.baseDelayMs = baseDelayMs;
    this.getToken = getToken;
    this.releases = new ReleaseHistory(releaseFile);
    this.fsOps = { copyFile: fs.promises.copyFile, rename: fs.promises.rename, ...fsOps };
    this.busy = false;
    this.applying = false;
    this.controller = null;
    this.lastManifest = null;
  }

  get patcherDir() { return path.join(this.installDir, PATCHER_DIR); }
  get stateFile() { return path.join(this.patcherDir, 'state.json'); }
  get journalFile() { return path.join(this.patcherDir, 'pending.json'); }
  get stagingDir() { return path.join(this.patcherDir, 'staging'); }

  log(message) {
    try {
      fs.mkdirSync(this.patcherDir, { recursive: true });
      const file = path.join(this.patcherDir, 'patcher.log');
      if ((lstat(file) || { size: 0 }).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`);
      fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Logging must never break an update.
    }
  }

  progress(info) {
    this.emit('progress', info);
  }

  // A development checkout (a git repository) is never patched: its files are
  // the source the releases are made from.
  checkManageable() {
    if (fs.existsSync(path.join(this.installDir, '.git'))) {
      throw new PatchError('dev-folder', 'The game folder is a development copy of the game, so it is not updated automatically.');
    }
  }

  manifestLocation() {
    return this.manifestUrl.replace(/\{platform\}/g, process.platform).replace(/\{arch\}/g, process.arch);
  }

  // Where the download token may be sent.
  authOrigins() {
    return updateOrigins(this.manifestLocation(), this.mirrors);
  }

  downloadOptions(signal) {
    return {
      timeoutMs: this.timeoutMs, retries: this.retries, signal, allowHttp: this.allowHttp, baseDelayMs: this.baseDelayMs,
      getToken: this.getToken, authOrigins: this.authOrigins(),
    };
  }

  async fetchManifest(signal) {
    const url = this.manifestLocation();
    const options = this.downloadOptions(signal);
    let bytes;
    try {
      bytes = await fetchBytes(url, options);
    } catch (err) {
      if (err.code === 'cancelled' || err.code === 'unauthorized') throw err;
      this.log(`manifest fetch failed from ${describe(url)}: ${err.message}`);
      throw new PatchError('unreachable', "Couldn't reach the update server. Check your internet connection and try again.", true);
    }
    if (this.publicKey) {
      let signature;
      try {
        signature = await fetchBytes(`${url}.sig`, { ...options, maxBytes: 4096 });
      } catch (err) {
        if (err.code === 'cancelled' || err.code === 'unauthorized') throw err;
        throw new PatchError('unreachable', "Couldn't download the update's signature. Try again.", true);
      }
      verifySignature(bytes, signature.toString('utf8'), this.publicKey);
    }
    const manifest = parseManifest(bytes, { allowHttp: this.allowHttp });
    try {
      this.releases.accept(url, manifest.published);
    } catch (err) {
      this.log(`manifest from ${describe(url)} refused: ${manifest.version} (published ${manifest.published || 'unknown'}) is older than one already seen`);
      throw err;
    }
    manifest.url = url;
    if (process.platform !== 'win32' && Array.isArray(manifest.files)) {
      manifest.files = manifest.files.filter((entry) => !entry.path.replace(/\\/g, '/').toLowerCase().endsWith('launcher/resources/app.asar.next'));
    }
    return manifest;
  }

  readState() {
    try {
      const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      if (data.schema !== STATE_SCHEMA || typeof data.version !== 'string' || !data.files || typeof data.files !== 'object') return null;
      const files = {};
      for (const [rel, info] of Object.entries(data.files)) {
        if (checkRelativePath(rel) || !info || typeof info.sha256 !== 'string') continue;
        files[rel] = { size: info.size, sha256: info.sha256, mtimeMs: info.mtimeMs };
      }
      return { version: data.version, files };
    } catch {
      return null;
    }
  }

  writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  // Compares the game folder with the manifest.
  async scan(manifest, { full, signal }) {
    const state = this.readState();
    const interrupted = fs.existsSync(this.journalFile);
    const fullCheck = full || interrupted || !state;
    const needed = [];
    const toHash = [];
    let present = 0;
    for (const entry of manifest.files) {
      const target = safeResolve(this.installDir, entry.path);
      const st = lstat(target);
      if (!st || !st.isFile()) {
        needed.push(entry);
        continue;
      }
      present++;
      if (st.size !== entry.size) {
        needed.push(entry);
        continue;
      }
      const known = state && state.files[entry.path];
      if (!fullCheck && known && known.sha256 === entry.sha256 && known.size === st.size && known.mtimeMs === st.mtimeMs) continue;
      toHash.push({ entry, target });
    }

    const hashTotal = toHash.reduce((sum, item) => sum + item.entry.size, 0);
    let hashed = 0;
    let lastReport = 0;
    for (const { entry, target } of toHash) {
      const digest = await hashFile(target, signal, (n) => {
        hashed += n;
        const now = Date.now();
        if (now - lastReport > 100) {
          lastReport = now;
          this.progress({ stage: 'verifying', bytesDone: hashed, bytesTotal: hashTotal, file: entry.path });
        }
      });
      if (digest !== entry.sha256) needed.push(entry);
    }

    // Files to delete: ones this patcher installed that the release no longer
    // has, ones the manifest says were removed, and anything else in the
    // game's own folders (GAME_FOLDERS). Never anything else.
    const listed = new Set(manifest.files.map((entry) => entry.path.toLowerCase()));
    const candidates = new Set([...Object.keys((state && state.files) || {}), ...manifest.removed, ...this.gameFolderFiles()]);
    const toDelete = [];
    const seen = new Set();
    for (const rel of candidates) {
      const key = rel.toLowerCase();
      if (listed.has(key) || LAUNCHER_FILES.includes(key) || seen.has(key)) continue;
      seen.add(key);
      let target;
      try {
        target = safeResolve(this.installDir, rel);
      } catch {
        continue;
      }
      const st = lstat(target);
      if (st && st.isFile()) toDelete.push(rel);
    }
    return { state, interrupted, needed, toDelete, present };
  }

  // Every file in the game's own folders (GAME_FOLDERS), as manifest paths.
  // Links aren't followed.
  gameFolderFiles() {
    const files = [];
    const walk = (dir, prefix) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) files.push(rel);
      }
    };
    for (const folder of GAME_FOLDERS) {
      const dir = path.join(this.installDir, folder);
      const st = lstat(dir);
      if (st && st.isDirectory()) walk(dir, folder);
    }
    return files;
  }

  summarize(manifest, scanned) {
    const { state, interrupted, needed, toDelete, present } = scanned;
    const unique = new Map(needed.map((entry) => [entry.sha256, entry.size]));
    const downloadBytes = [...unique.values()].reduce((a, b) => a + b, 0);
    let status;
    if (!needed.length && !toDelete.length && !interrupted && state && state.version === manifest.version) status = 'up-to-date';
    else if (!present && !state) status = 'not-installed';
    else if (state && state.version === manifest.version) status = 'repair';
    else status = 'update';
    return {
      status,
      installedVersion: state ? state.version : null,
      latestVersion: manifest.version,
      downloadBytes,
      downloadFiles: needed.length,
      deleteFiles: toDelete.length,
      // Which files an update would download and remove, biggest first, for
      // the launcher to show (capped; the counts above are complete).
      changedFiles: [...needed].sort((a, b) => b.size - a.size).slice(0, FILE_LIST_LIMIT).map(({ path: rel, size }) => ({ path: rel, size })),
      removedFiles: toDelete.slice(0, FILE_LIST_LIMIT),
      interrupted,
    };
  }

  begin() {
    if (this.busy) throw new PatchError('busy', 'An update is already running.');
    this.busy = true;
    this.controller = new AbortController();
    return this.controller.signal;
  }

  end() {
    this.busy = false;
    this.applying = false;
    this.controller = null;
  }

  // Checks for updates. Doesn't change any files.
  async check({ full = false } = {}) {
    const signal = this.begin();
    try {
      this.checkManageable();
      this.progress({ stage: 'checking' });
      const manifest = await this.fetchManifest(signal);
      let scanned = await this.scan(manifest, { full, signal });
      this.lastManifest = manifest;
      if (scanned.state && !scanned.interrupted && !scanned.needed.length && !scanned.toDelete.length
          && scanned.state.version !== manifest.version) {
        // A release with none of this game's files changed (a launcher-only
        // release, say): nothing to download, so just record its version.
        this.applying = true;
        try {
          await this.apply(manifest, [], []);
        } finally {
          this.applying = false;
        }
        this.log(`now at ${manifest.version} (no game files changed)`);
        scanned = { ...scanned, state: this.readState() };
      }
      const result = this.summarize(manifest, scanned);
      this.log(`check: installed ${result.installedVersion || 'none'}, latest ${result.latestVersion}, ${result.status}, ${result.downloadFiles} files to get`);
      return result;
    } catch (err) {
      throw toPatchError(err);
    } finally {
      this.end();
    }
  }

  cancel() {
    if (this.controller && !this.applying) this.controller.abort();
  }

  // Brings the game folder up to date (or repairs it, re-hashing every file).
  async update({ repair = false } = {}) {
    const signal = this.begin();
    try {
      this.checkManageable();
      fs.mkdirSync(this.installDir, { recursive: true });
      this.progress({ stage: 'checking' });
      const manifest = await this.fetchManifest(signal);
      const scanned = await this.scan(manifest, { full: repair, signal });
      this.lastManifest = manifest;
      this.log(`update to ${manifest.version}${repair ? ' (repair)' : ''}: ${scanned.needed.length} files to get, ${scanned.toDelete.length} to remove`);
      await this.stage(manifest, scanned.needed, signal);
      this.applying = true;
      await this.apply(manifest, scanned.needed, scanned.toDelete);
      this.cleanStaging();
      this.log(`now at ${manifest.version}`);
      this.progress({ stage: 'done' });
      return this.summarize(manifest, { ...scanned, state: this.readState(), interrupted: false, needed: [], toDelete: [] });
    } catch (err) {
      const error = toPatchError(err);
      this.log(`update failed: ${error.code}: ${error.message}`);
      throw error;
    } finally {
      this.end();
    }
  }

  // Puts a verified copy of every needed file in the staging folder.
  async stage(manifest, needed, signal) {
    fs.mkdirSync(this.stagingDir, { recursive: true });
    const blobs = new Map();
    for (const entry of needed) if (!blobs.has(entry.sha256)) blobs.set(entry.sha256, entry);

    const done = new Map();
    const bytesTotal = [...blobs.values()].reduce((sum, entry) => sum + entry.size, 0);
    let lastBytes = 0;
    let lastTime = Date.now();
    let speed = 0;
    let lastReport = 0;
    let currentFile = '';
    let filesDone = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 150) return;
      lastReport = now;
      const bytesDone = [...done.values()].reduce((a, b) => a + b, 0);
      if (now - lastTime >= 500) {
        const sample = ((bytesDone - lastBytes) * 1000) / (now - lastTime);
        speed = speed ? speed * 0.7 + sample * 0.3 : sample;
        lastBytes = bytesDone;
        lastTime = now;
      }
      const eta = speed > 0 ? Math.round((bytesTotal - bytesDone) / speed) : null;
      this.progress({ stage: 'downloading', bytesDone, bytesTotal, speed: Math.max(0, Math.round(speed)), eta, file: currentFile, filesDone, filesTotal: blobs.size });
    };

    // Files the game folder already has, by checksum, at the paths the last
    // update put them: a release that moves files (to bin\, say) copies
    // them over instead of downloading them again.
    const installed = new Map();
    for (const [rel, info] of Object.entries((this.readState() || { files: {} }).files)) {
      if (!installed.has(info.sha256)) installed.set(info.sha256, []);
      installed.get(info.sha256).push(rel);
    }
    const remaining = [];
    for (const [sha256, entry] of blobs) {
      const staged = path.join(this.stagingDir, sha256);
      if (await this.isStaged(staged, entry, signal) || await this.copyFromSeed(staged, entry, manifest, signal, installed)) {
        done.set(sha256, entry.size);
        filesDone++;
      } else {
        remaining.push(entry);
      }
    }
    report(true);

    // Biggest first: the big texture packs start at once, side by side,
    // and the many small files (the game's code) fill the other slots
    // around them, instead of one big file trailing on its own at the end.
    remaining.sort((a, b) => b.size - a.size);
    await pool(remaining, this.concurrency, async (entry) => {
      const staged = path.join(this.stagingDir, entry.sha256);
      currentFile = entry.path;
      await downloadFile({
        ...this.downloadOptions(signal),
        urls: fileUrls(entry, manifest, manifest.url, this.mirrors),
        size: entry.size,
        sha256: entry.sha256,
        partPath: `${staged}.part`,
        finalPath: staged,
        onProgress: (bytes) => {
          done.set(entry.sha256, bytes);
          currentFile = entry.path;
          report();
        },
      });
      filesDone++;
      report(true);
    });
  }

  async isStaged(staged, entry, signal) {
    const st = lstat(staged);
    if (!st || !st.isFile()) return false;
    if (st.size === entry.size && await hashFile(staged, signal) === entry.sha256) return true;
    fs.rmSync(staged, { force: true });
    return false;
  }

  // Copies a file with the right checksum from a seed folder (e.g. the game
  // bundled with the installer), or from wherever the game folder already
  // has it (installed: checksum -> paths), instead of downloading it.
  async copyFromSeed(staged, entry, manifest, signal, installed = new Map()) {
    const paths = manifest.files.filter((other) => other.sha256 === entry.sha256).map((other) => other.path);
    const sources = [...this.seedDirs.map((seed) => [seed, paths]), [this.installDir, installed.get(entry.sha256) || []]];
    for (const [seed, rels] of sources) {
      for (const rel of rels) {
        let source;
        try {
          source = safeResolve(seed, rel);
        } catch {
          continue;
        }
        const st = lstat(source);
        if (!st || !st.isFile() || st.size !== entry.size) continue;
        if (await hashFile(source, signal) !== entry.sha256) continue;
        const tmp = `${staged}.tmp`;
        await this.fsOps.copyFile(source, tmp);
        if (await hashFile(tmp, signal) !== entry.sha256) {
          fs.rmSync(tmp, { force: true });
          continue;
        }
        fs.renameSync(tmp, staged);
        return true;
      }
    }
    return false;
  }

  // Replaces files, deletes removed ones and records the new state. The
  // journal is written first, so an interruption is noticed on the next
  // start; each file is replaced atomically.
  async apply(manifest, needed, toDelete) {
    this.progress({ stage: 'applying', filesDone: 0, filesTotal: needed.length });
    this.writeJson(this.journalFile, { version: manifest.version, startedAt: new Date().toISOString() });
    let filesDone = 0;
    // The last file to use each staged download takes it over (a rename, as
    // the staging folder is in the game folder) rather than copying it,
    // which would write the whole update to disk a second time.
    const lastUse = new Map();
    for (const entry of needed) lastUse.set(entry.sha256, entry);
    for (const entry of needed) {
      const target = safeResolve(this.installDir, entry.path);
      const tmp = `${target}.tvpatch`;
      const staged = path.join(this.stagingDir, entry.sha256);
      let moved = false;
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        safeResolve(this.installDir, entry.path); // Nothing became a link meanwhile.
        if (lastUse.get(entry.sha256) === entry) {
          try {
            await this.fsOps.rename(staged, tmp);
            moved = true;
          } catch {
            // Copy it instead, below.
          }
        }
        if (!moved) await this.fsOps.copyFile(staged, tmp);
        if (fs.statSync(tmp).size !== entry.size) throw new Error('size changed while copying');
        await this.fsOps.rename(tmp, target);
      } catch (err) {
        // Keep the download staged for the next try.
        try {
          if (moved) fs.renameSync(tmp, staged);
        } catch {
          // Downloaded again next time.
        }
        fs.rmSync(tmp, { force: true });
        this.log(`could not replace ${entry.path}: ${err.code || err.message}`);
        if (err.code === 'ENOSPC' || err.code === 'EDQUOT') throw new PatchError('disk-full', DISK_FULL, true);
        throw new PatchError('replace-failed', `Couldn't update ${entry.path}. Close the game and any program using its files, then try again.`, true);
      }
      filesDone++;
      this.progress({ stage: 'applying', filesDone, filesTotal: needed.length, file: entry.path });
    }

    for (const rel of toDelete) {
      const target = safeResolve(this.installDir, rel);
      try {
        unlinkFile(target);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          throw new PatchError('replace-failed', `Couldn't remove the old file ${rel}. Close the game and try again.`, true);
        }
      }
      this.removeEmptyParents(path.dirname(target));
    }

    const files = {};
    for (const entry of manifest.files) {
      const st = fs.statSync(safeResolve(this.installDir, entry.path));
      files[entry.path] = { size: st.size, sha256: entry.sha256, mtimeMs: st.mtimeMs };
    }
    this.writeJson(this.stateFile, { schema: STATE_SCHEMA, version: manifest.version, files });
    fs.rmSync(this.journalFile, { force: true });
  }

  // Removes folders a deleted file leaves empty (only empty ones, never the
  // game folder itself).
  removeEmptyParents(dir) {
    let current = dir;
    while (current.startsWith(this.installDir + path.sep)) {
      try {
        fs.rmdirSync(current);
      } catch {
        return;
      }
      current = path.dirname(current);
    }
  }

  cleanStaging() {
    let names = [];
    try {
      names = fs.readdirSync(this.stagingDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (STAGED_NAME.test(name)) fs.rmSync(path.join(this.stagingDir, name), { force: true });
    }
  }

  // Quick check before starting the game: the last update finished and every
  // file is the size and age recorded when it was verified.
  // Fetches the latest release info again, right before playing, so a
  // release published while the launcher was open is noticed. Throws if the
  // update server can't be reached; readyToPlay() then compares with it.
  async confirmLatest() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      this.lastManifest = await this.fetchManifest(controller.signal);
    } catch (err) {
      // fetchManifest already logs; a timeout just means 'try again later'
      if (err && err.name === 'AbortError') {
        throw new PatchError('unreachable', "Couldn't reach the update server in time. Try again.", true);
      }
      throw toPatchError(err);
    } finally {
      clearTimeout(timeout);
    }
    return this.lastManifest;
  }

  readyToPlay() {
    if (fs.existsSync(this.journalFile)) return { ok: false, reason: 'An update did not finish. Press Update to finish it.' };
    const state = this.readState();
    if (!state) return { ok: false, reason: 'The game is not installed yet. Press Update to install it.' };
    if (this.lastManifest && this.lastManifest.version !== state.version) {
      return { ok: false, reason: `Version ${this.lastManifest.version} is available and needed to play. Press Update.` };
    }
    const entries = this.lastManifest ? this.lastManifest.files.map((entry) => [entry.path, { ...state.files[entry.path], sha256: entry.sha256 }]) : Object.entries(state.files);
    for (const [rel, known] of entries) {
      let st;
      try {
        st = lstat(safeResolve(this.installDir, rel));
      } catch {
        st = null;
      }
      if (!st || !st.isFile() || !known || st.size !== known.size || st.mtimeMs !== known.mtimeMs) {
        return { ok: false, reason: 'Some game files are missing or changed. Press Repair in Settings, or Update.' };
      }
    }
    return { ok: true, version: state.version };
  }

  installedVersion() {
    const state = this.readState();
    return state ? state.version : null;
  }
}

module.exports = { Patcher, PatchError, LOGIN_REQUIRED };
