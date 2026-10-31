#!/usr/bin/env python3
"""Check a built launcher before it is distributed.

    python tools/verify_release.py src/dist/win-unpacked --branch windows
    python tools/verify_release.py src/dist/linux-unpacked --branch linux

Verifies, from the packaged app.asar itself:
  * version, and that the changelog has an entry for it
  * the game-folder picker and (Linux) the Wine rows are in the page
  * the update manifest URL and public key
  * the stub / fallback logic is present
and that release/launcher-entries.json matches this asar (size + sha256) and
points at this branch.
"""
import argparse
import hashlib
import json
import os
import struct
import sys

EXPECTED_KEY = 'MCowBQYDK2VwAyEAMCEH9laAKmlqkNKUWVX3XyRWeZz82U+wRw7e2CR1QLc='
EXPECTED_URL = 'https://toonvalley.sapi.click/dl/manifest.json'
WINDOWS_DLLS = ('d3dcompiler_47.dll', 'ffmpeg.dll', 'libEGL.dll',
                'libGLESv2.dll', 'vk_swiftshader.dll', 'vulkan-1.dll')

failures = []


def check(what, ok, detail=''):
    print('%-52s %s%s' % (what, 'ok' if ok else 'FAIL',
                         '' if ok or not detail else '  (%s)' % detail))
    if not ok:
        failures.append(what)


def asar_files(path):
    raw = open(path, 'rb').read()
    _m, header_size, _s, json_size = struct.unpack('<IIII', raw[:16])
    header = json.loads(raw[16:16 + json_size])
    data = raw[8 + header_size:]

    def walk(node, prefix=''):
        for name, entry in node.items():
            if 'files' in entry:
                yield from walk(entry['files'], prefix + name + '/')
            else:
                yield prefix + name, entry
    return {name: data[int(entry['offset']):int(entry['offset']) + int(entry['size'])]
            for name, entry in walk(header['files'])}


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('built', help='win-unpacked, linux-unpacked, or mac')
    parser.add_argument('--branch', default=None, help='expected branch in the URLs')
    parser.add_argument('--entries', default='release/launcher-entries.json')
    parser.add_argument('--platform', choices=('win', 'linux', 'mac'), default=None,
                        help='default: guessed from the folder name')
    args = parser.parse_args()

    platform = args.platform or ('win' if 'win' in os.path.basename(args.built) else ('mac' if 'mac' in os.path.basename(args.built) else 'linux'))
    asar_path = os.path.join(args.built, 'resources', 'app.asar')
    if not os.path.isfile(asar_path):
        for cand in (
            os.path.join(args.built, 'Toon Valley Launcher.app', 'Contents', 'Resources', 'app.asar'),
            os.path.join(args.built, 'Contents', 'Resources', 'app.asar'),
        ):
            if os.path.isfile(cand):
                asar_path = cand
                break
    check('app.asar exists', os.path.isfile(asar_path), asar_path)
    if failures:
        return 1

    files = asar_files(asar_path)
    package = json.loads(files['package.json'])
    version = package['version']
    print('  version %s, %d files in the asar, %.1f MiB'
          % (version, len(files), os.path.getsize(asar_path) / 1048576.0))

    changelog = files['src/main/changelog.js'].decode('utf-8', 'replace')
    check('changelog has notes for %s' % version, "'%s'" % version in changelog)

    html = files['src/renderer/index.html'].decode('utf-8', 'replace')
    check('game folder picker in the page', 'game-folder-help' in html)
    check('Wine rows present (hidden on Windows)', 'wine-settings' in html)

    config = json.loads(files['config/default.json'])
    updates = config['updates']
    check('manifest URL', updates.get('manifestUrl') == EXPECTED_URL,
          updates.get('manifestUrl'))
    check('public key', updates.get('publicKey') == EXPECTED_KEY)

    game_js = files['src/main/game.js'].decode('utf-8', 'replace')
    check('stub is preferred', "win32: ['ToonValleyStub.exe'" in game_js.replace('\\r\\n', '\\n')
          or "'ToonValleyStub.exe'" in game_js)
    check('falls back when the stub has no runtime', 'stubRuntimePresent' in game_js)
    main_js = files['src/main/main.js'].decode('utf-8', 'replace')
    check('exe self-update works from an unpacked launcher',
          'process.execPath' in main_js)
    check('asar swap pulls from the game folder too', 'finishAsarSwap' in main_js)
    # electron-builder strips the build block from the packaged package.json,
    # so read the Electron version out of the binary itself
    if platform == 'win':
        binary = os.path.join(args.built, 'Toon Valley Launcher.exe')
    elif platform == 'mac':
        # On macOS the Electron version string is in Electron Framework
        framework = os.path.join(args.built, 'Toon Valley Launcher.app', 'Contents', 'Frameworks',
                                 'Electron Framework.framework', 'Electron Framework')
        if not os.path.isfile(framework):
            framework = os.path.join(args.built, 'Contents', 'Frameworks',
                                     'Electron Framework.framework', 'Electron Framework')
        binary = framework if os.path.isfile(framework) else os.path.join(
            args.built, 'Toon Valley Launcher.app', 'Contents', 'MacOS', 'Toon Valley Launcher')
        if not os.path.isfile(binary):
            binary = os.path.join(args.built, 'Contents', 'MacOS', 'Toon Valley Launcher')
    else:
        binary = os.path.join(args.built, 'toon-valley-launcher')
    marker = '?'
    if os.path.isfile(binary):
        with open(binary, 'rb') as handle:
            blob = handle.read()
        index = blob.find(b'Electron/')
        if index != -1:
            marker = blob[index:index + 24].split(b'\x00')[0].decode('ascii', 'replace')
    check('built with the Electron the release ships', 'Electron/33.' in marker, marker)

    if platform == 'win':
        exe = os.path.join(args.built, 'Toon Valley Launcher.exe')
        check('launcher exe', os.path.isfile(exe), exe)
        if os.path.isfile(exe):
            size = os.path.getsize(exe)
            check('exe size is the Electron 33 build (~189 MB)',
                  180_000_000 < size < 200_000_000, '%d bytes' % size)
        for name in WINDOWS_DLLS:
            check('ships %s' % name, os.path.isfile(os.path.join(args.built, name)))

    if os.path.isfile(args.entries):
        entries = json.load(open(args.entries))
        entry = next((e for e in entries.get('files', [])
                      if e['path'] == 'Launcher/resources/app.asar.next'), None)
        check('entries list the launcher asar', entry is not None)
        if entry:
            check('entries asar size matches', entry['size'] == os.path.getsize(asar_path),
                  '%s vs %s' % (entry['size'], os.path.getsize(asar_path)))
            check('entries asar sha256 matches', entry['sha256'] == sha256(asar_path))
            if args.branch:
                check('asar URL uses the %s branch' % args.branch,
                      '/' + args.branch + '/release/app.asar' in entry['url'], entry['url'])
        launcher = entries.get('launcher')
        if platform == 'win':
            check('entries carry a launcher exe', bool(launcher))
            if launcher:
                check('launcher exe version', launcher.get('version') == version,
                      launcher.get('version'))
                check('launcher exe is an https release asset',
                      launcher['url'].startswith('https://github.com/'), launcher['url'])
    else:
        print('  (no %s to compare against)' % args.entries)

    print('')
    print('%d problem(s)' % len(failures))
    for failure in failures:
        print(' -', failure)
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
