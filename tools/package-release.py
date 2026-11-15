"""Build deterministic, allow-listed extension and GitHub source ZIPs."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
extension = root / 'longshot-copy'
manifest = json.loads((extension / 'manifest.json').read_text())
version = manifest['version']
assert manifest['manifest_version'] == 3
assert len(manifest['description']) <= 132
assert 'key' not in manifest and 'update_url' not in manifest
assert set(manifest['permissions']) == {'activeTab', 'scripting', 'offscreen', 'clipboardWrite', 'contextMenus', 'debugger'}
assert 'host_permissions' not in manifest
files = ['manifest.json', 'background.js', 'capture.js', 'geometry.js', 'offscreen.js', 'offscreen.html']
files += [f'icons/{size}.png' for size in (16, 32, 48, 128)]
assert manifest['background']['service_worker'] in files
assert manifest['action']['default_popup'].split('?')[0] in files
assert all(path in files for path in manifest['icons'].values())
assert f"__longshotCopyInstalled === '{version}'" in (extension / 'capture.js').read_text()
package = json.loads((root / 'package.json').read_text())
assert package['version'] == version
assert package['license'] == 'MIT'
assert (root / 'LICENSE').read_text().startswith('MIT License\n')
output = root / 'dist'
output.mkdir(parents=True, exist_ok=True)
archive = output / f'longshot-copy-{version}.zip'
source_archive = output / f'longshot-copy-{version}-source.zip'


def write_archive(destination, contents):
    for name, path in contents.items():
        assert not path.is_symlink(), f'Symlink not allowed: {name}'
        assert path.is_file(), f'Missing file: {name}'
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in sorted(contents):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 15, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, contents[name].read_bytes())
    with zipfile.ZipFile(destination) as z:
        assert z.testzip() is None
        assert set(z.namelist()) == set(contents)
        for name, path in contents.items():
            assert z.read(name) == path.read_bytes(), name
    return hashlib.sha256(destination.read_bytes()).hexdigest()


extension_files = {name: extension / name for name in files}
extension_files.update({'README.md': extension / 'README.md', 'LICENSE': root / 'LICENSE'})
source_names = ['README.md', 'LICENSE', '.gitignore', 'package.json',
                'docs/DEVELOPMENT.md', 'docs/RELEASE.md',
                'tests/geometry.test.mjs', 'tests/browser.cjs', 'tools/package-release.py']
if (root / 'package-lock.json').exists():
    source_names.append('package-lock.json')
source_names += [f'longshot-copy/{name}' for name in files + ['README.md']]
source_files = {f'longshot-copy-source/{name}': root / name for name in source_names}
hashes = []
for destination, contents in [(archive, extension_files), (source_archive, source_files)]:
    digest = write_archive(destination, contents)
    hashes.append(f'{digest}  {destination.name}')
    print(json.dumps({'zip': str(destination), 'bytes': destination.stat().st_size,
                      'files': len(contents), 'sha256': digest}, ensure_ascii=False))
(output / 'SHA256SUMS.txt').write_text('\n'.join(hashes) + '\n')
