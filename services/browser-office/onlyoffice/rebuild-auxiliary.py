#!/usr/bin/env python3
# SPDX-License-Identifier: MPL-2.0
"""Rebuild the four locked auxiliary modules locally; never modifies a selected runtime."""
import argparse
import hashlib
import json
import re
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import uuid

MODULES = {
    'zlib': ('OfficeUtils/js/zlib.json', 'OfficeUtils/js/deploy/zlib'),
    'spell': ('Common/3dParty/hunspell/hunspell.json', 'Common/3dParty/hunspell/deploy/spell/spell'),
    'hash': ('DesktopEditor/xmlsec/src/wasm/hash/hash.json', 'DesktopEditor/xmlsec/src/wasm/hash/deploy/engine'),
    'font': ('DesktopEditor/fontengine/js/libfont.json', 'DesktopEditor/fontengine/js/deploy/fonts'),
}
def digest(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-archive', required=True, type=Path)
    parser.add_argument('--receipt', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    def interrupted(signum, frame):
        raise KeyboardInterrupt('Build interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    receipt = json.loads(args.receipt.read_text())
    if receipt.get('schemaVersion') != 1:
        raise ValueError('Unsupported build receipt')
    image = receipt['compilerImage']
    if not re.fullmatch(r'emscripten/emsdk@sha256:[a-f0-9]{64}', image):
        raise ValueError('Compiler image must be pinned by SHA-256')
    if receipt.get('platform') != 'linux/amd64':
        raise ValueError('Unsupported compiler platform')
    if digest(args.source_archive) != receipt['sourceArchiveSha256']:
        raise ValueError('Source archive changed')
    expected = receipt['outputs']
    paths = {
        'zlib': 'sdkjs/common/zlib/engine/zlib',
        'spell': 'sdkjs/common/spell/spell/spell',
        'hash': 'sdkjs/common/hash/hash/engine',
        'font': 'sdkjs/common/libfont/engine/fonts',
    }
    expected_pairs = {(module, base + ext) for module, base in paths.items()
                      for ext in ('.js', '.wasm')}
    if (len(expected) != 8 or {(x['module'], x['path']) for x in expected} != expected_pairs
            or any(not re.fullmatch(r'[a-f0-9]{64}', x['sha256']) for x in expected)):
        raise ValueError('Receipt must bind exactly the four expected JS/WASM pairs')
    args.output.mkdir(parents=True, exist_ok=False)
    work = args.output.resolve() / 'work'
    work.mkdir()
    with tarfile.open(args.source_archive) as source:
        source.extractall(work, filter='data')
    assert not (work / 'core/Common/js/emsdk').exists()
    (work / 'core/Common/js/emsdk').symlink_to('/emsdk')
    report = {'status': 'running', 'sourceArchiveSha256': receipt['sourceArchiveSha256'],
              'compilerImage': image, 'platform': receipt['platform'], 'modules': [], 'outputs': []}
    name = 'spellbook-auxiliary-' + uuid.uuid4().hex[:12]
    try:
        for module, (recipe, _) in MODULES.items():
            with (args.output / (module + '.log')).open('w') as log:
                result = subprocess.run(['docker', 'run', '--rm', '--name', name,
                    '--platform', receipt['platform'], '--network', 'none', '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges', '--mount',
                    f'type=bind,source={work},target=/work', '--workdir', '/work/core/Common/js',
                    image, 'python3', 'make.py', '/work/core/' + recipe], stdout=log, stderr=subprocess.STDOUT)
            if result.returncode:
                raise RuntimeError(f'{module} build failed; see {module}.log')
            for entry in [x for x in expected if x['module'] == module]:
                ext = Path(entry['path']).suffix
                built = work / ('core/' + MODULES[module][1] + ext)
                actual = digest(built)
                if actual != entry['sha256']:
                    raise RuntimeError(f'Exact reproduction failed: {entry["path"]}: {actual}')
                target = args.output / entry['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(built, target)
                report['outputs'].append({**entry, 'reproduced': True})
            report['modules'].append(module)
            print(module + ' reproduced', flush=True)
        report['status'] = 'exact-reproduction-verified'
    except BaseException as error:
        report['status'] = 'failed'
        report['error'] = str(error)
        raise
    finally:
        # Removes only this invocation's disposable container, including on interruption.
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (args.output / 'reproduction.json').write_text(json.dumps(report, indent=2) + '\n')
if __name__ == '__main__':
    main()
