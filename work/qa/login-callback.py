"""Exercise the installed-design loopback OAuth handoff without an OpenAI account."""
import importlib.util
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

src = Path("Deftly-Put/helper/native_host.py").resolve()
spec = importlib.util.spec_from_file_location("native_host_qa", str(src))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

class FakeClient:
    def __init__(self, folder, redirect):
        self.redirect = redirect
        self.ok = False
    def begin_login(self, new_account=False):
        return "https://example.invalid/?"+urllib.parse.urlencode({"redirect_uri":self.redirect, "state":"qa-state"})
    def finish_login(self, params):
        assert params == {"state":"qa-state","code":"qa-code"}
        self.ok = True
    def status(self):
        assert self.ok
        return {"signedIn":True,"connected":True,"account":"qa"}

reports = []
errors = []
threads = []
def open_mock(args, **kwargs):
    config = urllib.parse.parse_qs(urllib.parse.urlsplit(args[1]).query)
    redir = config["redirect_uri"][0]
    def visit():
        try:
            for query in ["?state=bad&code=qa-code","?state=qa-state&code=qa-code"]:
                try:
                    with urllib.request.urlopen(redir+query, timeout=3) as resp:
                        reports.append((resp.status, resp.headers["Cache-Control"]))
                except urllib.error.HTTPError as exc:
                    reports.append((exc.code, exc.headers["Cache-Control"]))
        except Exception as exc:
            errors.append(exc)
    thread = threading.Thread(target=visit)
    thread.start()
    threads.append(thread)
    return SimpleNamespace(returncode=0)

with tempfile.TemporaryDirectory() as scratch, patch.object(host,"Client",FakeClient), patch.object(host.subprocess,"run",open_mock):
    assert host.login(Path(scratch))["connected"] is True
for thread in threads:
    thread.join()
assert not errors, errors
assert reports == [(400,"no-store"),(200,"no-store")], reports
print("PASS loopback listener refused unmatched browser request, accepted matching callback, completed native login")
