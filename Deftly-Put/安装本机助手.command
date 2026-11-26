#!/usr/bin/python3 -I
"""Install the native companion for this unpacked extension on macOS."""

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


HOST_ID = "app.xreply.translator"
EXT_ID = "hbddhnfhdjncdbolcapilkemcaccnoai"


def install(source, support):
    ext = json.loads((source / "extension/manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(base64.b64decode(ext["key"], validate=True)).hexdigest()
    if "".join(chr(97 + int(n, 16)) for n in digest[:32]) != EXT_ID:
        raise ValueError("扩展签名标识与本机助手不匹配，请使用同一份安装包。")
    files = sorted((source / "helper").glob("*.py"))
    if not {"native_host.py", "openai_plan.py", "public_thread.py", "edit_language.py"}.issubset({p.name for p in files}):
        raise ValueError("助手文件不完整，请完整解压后再运行。")
    payload = {p.name: p.read_bytes() for p in files}
    for name, content in payload.items():
        compile(content, name, "exec")
    build = hashlib.sha256()
    for name, content in sorted(payload.items()):
        build.update(name.encode() + b"\0" + content + b"\0")
    app_dir = support / "XReplyTranslator"
    runtime = app_dir / ("runtime-" + build.hexdigest()[:16])
    app_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Publish a complete runtime before pointing Chrome at it.
    if not runtime.exists():
        stage = Path(tempfile.mkdtemp(prefix=".install-", dir=app_dir))
        try:
            for name, content in payload.items():
                dest = stage / name
                dest.write_bytes(content)
                dest.chmod(0o700 if name == "native_host.py" else 0o600)
            try:
                stage.rename(runtime)
            except OSError:
                if not runtime.is_dir():
                    raise
        finally:
            if stage.exists():
                shutil.rmtree(stage)
    if any((runtime / n).read_bytes() != b for n, b in payload.items()):
        raise ValueError("本机助手副本与安装包不一致。请检查本机助手的 runtime 目录。")
    host_dir = support / "Google/Chrome/NativeMessagingHosts"
    host_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    dest = host_dir / (HOST_ID + ".json")
    origin = "chrome-extension://" + EXT_ID + "/"
    manifest = {
        "name": HOST_ID, "description": "Deftly Put 的本机 ChatGPT 连接助手",
        "type": "stdio", "path": str(runtime / "native_host.py"), "allowed_origins": [origin],
    }
    if dest.exists():
        old = json.loads(dest.read_text(encoding="utf-8"))
        if old.get("name") != HOST_ID or old.get("allowed_origins") != [origin]:
            raise ValueError("Chrome 中已注册同名的其他助手，请先检查原有配置。")
        if old == manifest:
            return dest
    with tempfile.NamedTemporaryFile(dir=host_dir, delete=False, mode="w", encoding="utf-8") as stream:
        temp = Path(stream.name)
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    try:
        os.replace(temp, dest)
    finally:
        if temp.exists():
            temp.unlink()
    return dest


if __name__ == "__main__":
    os.umask(0o077)
    root = Path(__file__).resolve().parent
    try:
        install(root, Path.home() / "Library/Application Support")
    except (OSError, ValueError, KeyError, SyntaxError) as exc:
        print("安装失败。", exc, file=sys.stderr)
        sys.exit(1)
    print("Deftly Put 的 Chrome 本机助手已就绪。")
    print("在 chrome://extensions 开启开发者模式，点击“加载已解压的扩展程序”，选择：")
    print(root / "extension")
    print("然后打开「Deftly Put」，登录 ChatGPT 并授权使用套餐。")
