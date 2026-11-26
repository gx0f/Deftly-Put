"""Read a public X conversation from post detail HTML, without a browser tab."""
import http.client
import json
import re
import time
from urllib.error import HTTPError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request

from openai_plan import HTTP  # Plain urllib opener; redirects are handled below.

MAX_ANCESTORS = 3
MAX_BYTES = 3 * 1024 * 1024
STATUS_ID = re.compile(r"[0-9]{1,20}\Z")
RESULT = re.compile(r'kind:"Result\.Ok",value:(?=")')


def add_post(posts, wrapper):
    tweet = (wrapper or {}).get("result") or {}
    if tweet.get("__typename") == "TweetWithVisibilityResults":
        tweet = tweet.get("tweet") or {}
    status_id = tweet.get("rest_id")
    if tweet.get("__typename") != "Tweet" or not isinstance(status_id, str):
        return
    legacy = tweet.get("legacy") or {}
    note = (((tweet.get("note_tweet") or {}).get("note_tweet_results") or {}).get("result") or {})
    text = note.get("text") or (tweet.get("details") or {}).get("full_text") or legacy.get("full_text")
    user = (((tweet.get("core") or {}).get("user_results") or {}).get("result") or {})
    handle = (user.get("core") or {}).get("screen_name") or (user.get("legacy") or {}).get("screen_name")
    parent = (tweet.get("reply_to_results") or {}).get("rest_id") or legacy.get("in_reply_to_status_id_str")
    posts[status_id] = (parent, {
        "author": "@" + handle if isinstance(handle, str) and re.fullmatch(r"[A-Za-z0-9_]{1,15}", handle) else "",
        "text": text.strip()[:1000] if isinstance(text, str) else "",
    })


def parse_detail(html, status_id):
    # The public page embeds two layers of JSON. Decode the data strings
    # without executing page scripts or using the order of timeline entries.
    posts = {}
    decoder = json.JSONDecoder()
    for marker in RESULT.finditer(html):
        try:
            encoded, _ = decoder.raw_decode(html, marker.end())
            data = json.loads(encoded)["data"]
            focal = data.get("tweet_result_by_rest_id") or {}
            if focal.get("rest_id") != status_id:
                continue
            add_post(posts, focal)
            conversation = data.get("threaded_conversation_with_injections_v2") or {}
            for instruction in conversation.get("instructions", []):
                for entry in instruction.get("entries", []):
                    content = (entry.get("content") or {}).get("content") or {}
                    add_post(posts, content.get("tweet_results"))
        except (AttributeError, KeyError, TypeError, ValueError, RecursionError):
            continue
    return posts


def read_detail(status_id, deadline):
    url = "https://x.com/i/web/status/" + status_id
    for _ in range(3):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return {}
        req = Request(url, headers={"Accept": "text/html", "User-Agent": "Deftly-Put/1.1.1"})
        try:
            with HTTP.open(req, timeout=remaining) as resp:
                if resp.headers.get_content_type() != "text/html":
                    return {}
                body = bytearray()
                while time.monotonic() < deadline:
                    part = resp.read1(65536)
                    if not part:
                        return parse_detail(body.decode("utf-8", "replace"), status_id)
                    body.extend(part)
                    if len(body) > MAX_BYTES:
                        break
                return {}
        except HTTPError as error:
            with error:
                if error.code not in (301, 302, 303, 307, 308):
                    return {}
                url = urljoin(url, error.headers.get("Location", ""))
                dest = urlsplit(url)
                if (dest.scheme != "https" or dest.netloc != "x.com" or dest.query or
                        not re.fullmatch(r"/(?:i/web|[A-Za-z0-9_]+)/status/" + status_id + r"/?", dest.path)):
                    return {}
    return {}


def read_public_ancestors(status_id):
    if not isinstance(status_id, str) or not STATUS_ID.fullmatch(status_id):
        return []
    chain = []
    deadline = time.monotonic() + 6
    try:
        posts = read_detail(status_id, deadline)
        while len(chain) < MAX_ANCESTORS and status_id in posts:
            parent, _ = posts[status_id]
            if not isinstance(parent, str) or not STATUS_ID.fullmatch(parent) or int(parent) >= int(status_id):
                break
            if parent not in posts or not posts[parent][1]["text"]:
                posts.update(read_detail(parent, deadline))
            if parent not in posts or not posts[parent][1]["text"]:
                break
            chain.insert(0, posts[parent][1])
            status_id = parent
    except (OSError, ValueError, http.client.HTTPException):
        pass  # A private, unavailable or slow thread still has local context.
    return chain
