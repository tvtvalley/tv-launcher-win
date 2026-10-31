# Toon Valley launcher

Electron launcher for Toon Valley. One branch per platform:

| branch | platform |
| --- | --- |
| `windows` | Windows, starts the Windows client directly |
| `linux` | Linux, runs the same Windows client through Wine (`src/src/main/wine.js`) |
| `mac` | this branch: macOS, runs the same Windows client through Wine (`src/src/main/wine.js`) |

```
src/      the Electron app (src/main, src/preload, src/renderer, config, assets)
tools/    release staging + asar repack helpers
release/  built launcher artifacts that the update manifest points at
```

## Build

The launcher ships **Electron 33.4.11** (`build.electronVersion`). That is the
version the 2.2.3 release runs; newer Electron builds start but never draw a
window under Wine, which is how Linux players and our own tests run the
Windows build. Do not bump it without testing both.

```sh
cd src
npm ci
npx electron-builder --mac       # this branch: dist/mac (Toon Valley Launcher.app)
```

`config/default.json` carries the server host/port, the login API and the
update manifest URL with its Ed25519 public key (the signing key stays on the
server side).

## Launcher updates come from this repository, like the game files

The launcher is patched the same way the client is: the update manifest lists
a file, the launcher downloads it from GitHub and checks its SHA-256. Only the
destination differs - a new launcher UI is written as
`Launcher/resources/app.asar.next` inside the install dir and swapped in on
quit (`src/src/main/asarSwap.js`), and a new `Launcher.exe` is swapped after
exit (`src/src/main/patcher/selfupdate.js`). No installer runs while the
launcher is open.

So built launcher files are committed to this branch under `release/`, and the
manifest entry points straight at the raw file:

```sh
python tools/make_launcher_release.py "dist/mac/Toon Valley Launcher.app/Contents/Resources/app.asar"
# -> release/app.asar (committed)
# -> prints: --extra "Launcher/resources/app.asar.next|release/app.asar|https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/mac/release/app.asar"
```

The macOS launcher itself is too big for the branch, so its installer is a release asset while the UI updates through `release/app.asar`:

```sh
python tools/bundle_mac_release.py dist/mac
# -> dist/release/toon-valley-launcher-<version>-mac.tar.gz
```

Attach that archive to the GitHub release; it needs no manifest entry.

Check the result before publishing - `check_manifest.js` runs the launcher's
own parser over it:

```sh
node tools/check_manifest.js dl/manifest.json --sig dl/manifest.json.sig --key <public key>
```

Add that `--extra` when the game manifest is built (server side, key required):

```sh
python build_manifest.py --src "/path/Toon Valley" --key /secure/manifest.key \
    --base https://raw.githubusercontent.com/tvtvalley/toon-valley-win/main \
    --extra "Launcher/resources/app.asar.next|release/app.asar|https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/mac/release/app.asar" \
    -o dl/manifest.json --version 1.0.0
```

| what | pulled from |
| --- | --- |
| game files (`bin/`, `phase_*.mf`, `ToonValley.exe`, ...) | `https://raw.githubusercontent.com/tvtvalley/toon-valley-win/<branch>` |
| launcher UI (`app.asar.next`) | `https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/mac/release/app.asar` |
| launcher exe (`Launcher.exe`) | `https://raw.githubusercontent.com/tvtvalley/tv-launcher-win/mac/release/Launcher.exe` |
