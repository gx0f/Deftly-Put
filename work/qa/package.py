from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json
import os
import stat
import tempfile

folder = Path('Deftly-Put').resolve()
manifest = json.loads((folder/'extension/manifest.json').read_text())
scripts = [f for item in manifest['content_scripts'] for f in item['js']]
# Ship only the runtime sources and license so a local key, log, or test recording cannot
# slip into the release archive when new files appear in the checkout.
files = {folder / name: f'{folder.name}/{name}' for name in (
    '使用说明.txt', '安装本机助手.command',
    'extension/manifest.json', 'extension/background.js', 'extension/content.js',
    'extension/language-settings.js', 'extension/popup.html', 'extension/popup.css', 'extension/popup.js',
    'helper/native_host.py', 'helper/openai_plan.py', 'helper/edit_language.py', 'helper/public_thread.py',
)}
files[folder.parent / 'LICENSE'] = f'{folder.name}/LICENSE'
for f in [*scripts,manifest['background']['service_worker'],manifest['action']['default_popup']]:
    assert (folder/'extension'/f) in files
archive = folder.with_suffix('.zip')
with tempfile.NamedTemporaryFile(suffix='.zip',dir=archive.parent,delete=False) as stream:
    stage=Path(stream.name)
try:
    with ZipFile(stage,'w',compression=ZIP_DEFLATED) as z:
        for source, name in files.items():
            z.write(source, name)
    with ZipFile(stage) as z:
        assert z.testzip() is None
        assert sorted(z.namelist()) == sorted(files.values())
        for source, name in files.items():
            assert z.read(name) == source.read_bytes()
            if source.name.endswith('.command'):
                assert (z.getinfo(name).external_attr>>16)&stat.S_IXUSR
    stage.chmod(0o644)
    os.replace(stage,archive)
finally:
    if stage.exists():
        stage.unlink()
print(archive.name, len(files), 'files,',archive.stat().st_size,'bytes, ZIP contents matched source')
