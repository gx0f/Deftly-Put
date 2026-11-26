#!/usr/bin/python3 -I
"""Chrome native messaging entry point. stdout is reserved for framed JSON."""

import fcntl
import hmac
import json
import os
import re
import struct
import subprocess
import sys
import time
from contextlib import contextmanager
from html import escape
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from openai_plan import Client, LANGUAGE, PlanError, concrete_language
from public_thread import MAX_ANCESTORS, read_public_ancestors

EXTENSION_ORIGIN = "chrome-extension://hbddhnfhdjncdbolcapilkemcaccnoai/"
MAX_FRAME = 1024 * 1024


class HostError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def read_frame(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise HostError("INVALID_REQUEST", "收到的插件消息不完整。")
    size, = struct.unpack("=I", header)
    if not 0 < size <= MAX_FRAME:
        raise HostError("INVALID_REQUEST", "插件消息的大小超出范围。")
    data = stream.read(size)
    if len(data) != size:
        raise HostError("INVALID_REQUEST", "收到的插件消息不完整。")
    try:
        obj = json.loads(data.decode("utf-8"))
    except (UnicodeError, ValueError, RecursionError):
        raise HostError("INVALID_REQUEST", "无法读取插件消息。")
    if not isinstance(obj, dict):
        raise HostError("INVALID_REQUEST", "插件消息格式不正确。")
    return obj


def write_frame(stream, obj):
    data = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(data)) + data)
    stream.flush()


@contextmanager
def login_lock(data_dir):
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(str(data_dir / ".browser-login.lock"), os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "wb") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise HostError("LOGIN_IN_PROGRESS", "已有登录窗口打开，请先完成登录或等待它超时。")
        yield


class CallbackServer(HTTPServer):
    def get_request(self):
        conn, addr = super().get_request()
        conn.settimeout(2)
        return conn, addr

    def handle_error(self, request, client_address):
        pass  # Never log an OAuth callback URL or its query parameters.


class LoginCallback(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def page(self, status, title, message):
        body = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
                '<meta name="viewport" content="width=device-width,initial-scale=1">'
                '<title>Deftly Put</title><main><h1>' + escape(title) + '</h1><p>'
                + escape(message) + '</p></main></html>').encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        server = self.server
        parts = urlsplit(self.path)
        if self.headers.get("Host") != server.authority or parts.path != "/auth/callback":
            self.page(404, "未找到页面", "请从插件的登录按钮打开授权页。")
            return
        values = parse_qs(parts.query, keep_blank_values=True)
        states = values.get("state", [])
        if (len(states) != 1 or not states[0].isascii()
                or not hmac.compare_digest(states[0], server.oauth_state)
                or any(len(v) != 1 for v in values.values())):
            self.page(400, "登录请求不匹配", "请返回刚才打开的 OpenAI 授权页继续。")
            return
        try:
            if "error" in values:
                raise HostError("LOGIN_CANCELLED", "未获得套餐使用权限。可以从扩展菜单重新登录并授权。")
            server.client.finish_login({k: v[0] for k, v in values.items()})
            server.result = {"ok": True, **server.client.status()}
        except (HostError, PlanError) as exc:
            server.result = error_reply(exc)
        if server.result["ok"]:
            self.page(200, "已连接 ChatGPT", "现在可以关闭这个页面，回到 X 用 Deftly Put 写回复了。")
        else:
            self.page(400, "未能完成登录", server.result["error"])


def login(data_dir, new_account=False):
    with login_lock(data_dir), CallbackServer(("127.0.0.1", 0), LoginCallback) as server:
        server.authority = "127.0.0.1:" + str(server.server_port)
        callback = "http://" + server.authority + "/auth/callback"
        server.client = Client(data_dir, callback)
        url = server.client.begin_login(new_account=new_account)
        server.oauth_state = parse_qs(urlsplit(url).query)["state"][0]
        server.result = None
        server.timeout = 0.5
        opened = subprocess.run(["/usr/bin/open", url], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if opened.returncode:
            raise HostError("BROWSER_OPEN", "未能打开默认浏览器，请检查 macOS 的默认浏览器设置。")
        deadline = time.monotonic() + 240
        while server.result is None and time.monotonic() < deadline:
            server.handle_request()
        if server.result is None:
            raise HostError("LOGIN_TIMEOUT", "登录已超时，请从扩展菜单重新登录。")
        return server.result


def checked_text(msg, name, limit):
    value = msg.get(name, "")
    if not isinstance(value, str) or len(value) > limit:
        raise HostError("INVALID_REQUEST", "原帖或草稿过长，或格式不正确。")
    return value


def thread_post(item):
    if not isinstance(item, dict):
        raise HostError("INVALID_REQUEST", "对话上下文格式不正确。")
    text = item.get("text")
    author = item.get("author", "")
    if not isinstance(text, str) or not text.strip() or len(text) > 1000 or not isinstance(author, str) or len(author) > 80:
        raise HostError("INVALID_REQUEST", "对话上下文格式不正确。")
    return {"author": author, "text": text}


def dispatch(msg, data_dir):
    action = msg.get("action")
    if action == "detectEditLanguage":
        from edit_language import detect_edit_language
        text = checked_text(msg, "text", 4096)
        return {"ok": True, "language": detect_edit_language(text)}
    if action in ("login", "switchAccount"):
        return login(data_dir, new_account=action == "switchAccount")
    client = Client(data_dir)
    if action == "status":
        return {"ok": True, **client.status()}
    if action == "logout":
        with login_lock(data_dir):
            revoked = client.logout()
        return {"ok": True, "signedIn": False, "revoked": revoked}
    if action == "backTranslate":
        text = checked_text(msg, "text", 65000)
        target = checked_text(msg, "target", 40)
        if not concrete_language(target):
            raise HostError("INVALID_REQUEST", "无法确定要回译成哪种语言。")
        checked = client.back_translate(text, target)
        return {"ok": True, "text": checked["translation"]}
    if action != "translate":
        raise HostError("INVALID_REQUEST", "未知的插件操作。")
    draft = checked_text(msg, "draft", 35_000)
    post = checked_text(msg, "post", 35_000)
    hint = checked_text(msg, "langHint", 48)
    source = checked_text(msg, "source", 40)
    target = checked_text(msg, "target", 48) or "auto"
    tone = checked_text(msg, "tone", 16) or "natural"
    if not draft.strip():
        raise HostError("EMPTY_DRAFT", "请先写下想翻译的回复。")
    if source and not concrete_language(source):
        raise HostError("INVALID_REQUEST", "请选择有效的源语言。")
    if (target != "auto" and not LANGUAGE.fullmatch(target)) or tone not in ("natural", "friendly", "polite"):
        raise HostError("INVALID_REQUEST", "请选择有效的目标语言和语气。")
    if target == "auto" and not post.strip():
        raise HostError("NO_CONTEXT", "未能定位被回复的原帖，请手动选择目标语言。")
    if not client.status()["connected"]:
        raise HostError("SIGNED_OUT", "请先在扩展菜单中登录 ChatGPT 并授权使用套餐。")
    ancestors = msg.get("ancestors", [])
    if not isinstance(ancestors, list):
        raise HostError("INVALID_REQUEST", "上游对话格式不正确。")
    context = {}
    if source:
        context["source"] = source
    if ancestors:
        context["ancestors"] = [thread_post(entry) for entry in ancestors[-MAX_ANCESTORS:]]
    lookup = msg.get("lookupStatusId")
    if isinstance(lookup, str) and re.fullmatch(r"[0-9]{1,20}", lookup) and len(ancestors) < MAX_ANCESTORS:
        remote = read_public_ancestors(lookup)
        if len(remote) > len(ancestors):
            context["ancestors"] = remote
    if msg.get("quotedPost") is not None:
        context["quoted_post"] = thread_post(msg["quotedPost"])
    translated = client.translate(post, draft, target, tone, lang_hint=hint if LANGUAGE.fullmatch(hint) else "", **context)
    result = {"ok": True, "text": translated["translation"], "language": translated.get("language", "")}
    if translated.get("source_language"):
        result["sourceLanguage"] = translated["source_language"]
    return result


def error_reply(exc):
    if isinstance(exc, (PlanError, HostError)):
        return {"ok": False, "code": getattr(exc, "code", "OPENAI_ERROR"), "error": str(exc)}
    return {"ok": False, "code": "HELPER_ERROR", "error": "本机助手遇到错误。请确认已安装最新助手，再重试。"}


def main():
    os.umask(0o077)
    if len(sys.argv) < 2 or sys.argv[1] != EXTENSION_ORIGIN:
        return 1
    data_dir = Path.home() / "Library/Application Support/XReplyTranslator/account"
    try:
        msg = read_frame(sys.stdin.buffer)
        if msg is None:
            return 0
        reply = dispatch(msg, data_dir)
    except Exception as exc:
        reply = error_reply(exc)
    write_frame(sys.stdout.buffer, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
