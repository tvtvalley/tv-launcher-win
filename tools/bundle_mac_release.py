#!/usr/bin/env python3
"""Bundle the built macOS launcher into the archive we attach to a release.

The macOS launcher is an Electron app directory (`dist/mac`), far too
big for the git branch, so it ships as a GitHub release asset while the
launcher UI keeps updating through `release/app.asar` on the `mac` branch.

    python tools/bundle_mac_release.py dist/mac
    # -> dist/release/toon-valley-launcher-<version>-mac.tar.gz
"""
import argparse
import json
import os
import sys
import tarfile


def version():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    try:
        return json.load(open(os.path.join(root, 'src', 'package.json')))['version']
    except Exception:
        return '0.0.0'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('built', help='the electron-builder output dir (dist/mac) or .app')
    parser.add_argument('-o', '--output', default=None)
    parser.add_argument('--root-name', default=None,
                        help='folder inside the archive (default: preserves .app or toon-valley-launcher)')
    args = parser.parse_args()

    built = os.path.abspath(args.built)
    if not os.path.exists(built):
        sys.exit('no such path: %s' % built)

    output = args.output or os.path.join(
        os.path.dirname(built) if built.endswith('.app') else built,
        '..', 'release',
        'toon-valley-launcher-%s-mac.tar.gz' % version()
    )
    output = os.path.abspath(output)
    os.makedirs(os.path.dirname(output), exist_ok=True)

    # If pointing at dist/mac, look for the .app inside it
    target = built
    if os.path.isdir(built) and not built.endswith('.app'):
        apps = [f for f in os.listdir(built) if f.endswith('.app')]
        if apps:
            target = os.path.join(built, apps[0])

    arcname = args.root_name or os.path.basename(target)
    count = 0
    with tarfile.open(output, 'w:gz') as archive:
        archive.add(target, arcname=arcname)
        count = sum(1 for _ in archive.getmembers())

    size = os.path.getsize(output)
    print('%d items, %.1f MiB -> %s' % (count, size / 1048576.0, output))
    print('')
    print('Attach it to the release:')
    print('  https://github.com/tvtvalley/tv-launcher-win/releases -> upload %s'
          % os.path.basename(output))
    print('')
    print('Launcher UI updates still ship through the branch:')
    app_asar = os.path.join(target, 'Contents', 'Resources', 'app.asar')
    if not os.path.isfile(app_asar):
        app_asar = os.path.join(built, 'resources', 'app.asar')
    print('  python tools/make_launcher_release.py "%s"' % app_asar)
    return 0


if __name__ == '__main__':
    sys.exit(main())
