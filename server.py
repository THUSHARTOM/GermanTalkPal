"""German Speaking Partner backend.

Serves the frontend from ./static and keeps the LLM key off the browser.
Standard library only: run it with `python server.py`.

Set APP_PASSWORD to put the app behind a shared password. The server refuses
to listen on anything but this machine without one.
"""

import hashlib
import hmac
import json
import os
import sys
import threading
import time
from functools import partial
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from brain import LEVELS, BrainError, RateLimited, make_brain

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
MAX_BODY = 64 * 1024
MAX_TEXT = 2000

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")
SESSION_COOKIE = "gp_session"
SESSION_SECONDS = 30 * 24 * 3600
LOGIN_WINDOW = 10 * 60
LOGIN_TRIES_PER_CLIENT = 8
LOGIN_TRIES_TOTAL = 60


def load_env(path):
    """Read KEY=VALUE lines from .env; real environment variables win."""
    env = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    wanted = ("HOST", "PORT", "APP_PASSWORD")
    env.update({k: v for k, v in os.environ.items() if k.startswith("LLM_") or k in wanted})
    return env


class BadRequest(Exception):
    pass


class Auth:
    """A shared password, remembered in a cookie.

    The cookie value is derived from the password, so sessions survive a
    server restart and all end when the password changes.
    """

    def __init__(self, password):
        self.password = password
        self.token = (
            hmac.new(password.encode("utf-8"), b"german-partner-session-v1", hashlib.sha256).hexdigest()
            if password
            else ""
        )
        self._failures = []  # (time, client)
        self._lock = threading.Lock()

    @property
    def required(self):
        return bool(self.password)

    def has_session(self, cookie_header):
        if not self.required:
            return True
        try:
            morsel = SimpleCookie(cookie_header or "").get(SESSION_COOKIE)
        except Exception:  # malformed cookie header
            return False
        return bool(morsel) and hmac.compare_digest(morsel.value, self.token)

    def too_many_tries(self, client):
        now = time.time()
        with self._lock:
            self._failures = [f for f in self._failures if now - f[0] < LOGIN_WINDOW]
            mine = sum(1 for f in self._failures if f[1] == client)
            return mine >= LOGIN_TRIES_PER_CLIENT or len(self._failures) >= LOGIN_TRIES_TOTAL

    def check(self, client, attempt):
        ok = hmac.compare_digest(attempt.encode("utf-8"), self.password.encode("utf-8"))
        if not ok:
            with self._lock:
                self._failures.append((time.time(), client))
            time.sleep(0.5)  # slow down guessing
        return ok


def clean_history(raw):
    if not isinstance(raw, list):
        raise BadRequest("history must be a list")
    history = []
    for turn in raw:
        if not isinstance(turn, dict) or turn.get("role") not in ("learner", "partner"):
            raise BadRequest("each history entry needs a role of 'learner' or 'partner'")
        text = str(turn.get("text", "")).strip()[:MAX_TEXT]
        if text:
            history.append({"role": turn["role"], "text": text})
    return history


class Handler(SimpleHTTPRequestHandler):
    brain = None
    auth = None

    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            super().log_message(fmt, *args)

    def end_headers(self):
        # The frontend has no build step, so never serve a stale script.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, status, payload, cookie=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            raise BadRequest("request body missing or too large")
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise BadRequest("request body is not valid JSON")
        if not isinstance(data, dict):
            raise BadRequest("request body must be a JSON object")
        return data

    def _signed_in(self):
        return self.auth.has_session(self.headers.get("Cookie"))

    def _client(self):
        # Behind a host's proxy the socket address is the proxy, not the visitor.
        forwarded = self.headers.get("X-Forwarded-For", "")
        return forwarded.split(",")[0].strip() or self.client_address[0]

    def _login(self):
        client = self._client()
        if self.auth.too_many_tries(client):
            self._send_json(429, {"error": "Too many wrong passwords. Wait ten minutes and try again."})
            return
        attempt = str(self._read_json().get("password", ""))[:200]
        if not self.auth.required or self.auth.check(client, attempt):
            cookie = f"{SESSION_COOKIE}={self.auth.token}; Path=/; Max-Age={SESSION_SECONDS}; HttpOnly; SameSite=Strict"
            if self.headers.get("X-Forwarded-Proto", "").lower() == "https":
                cookie += "; Secure"
            self._send_json(200, {"ok": True}, cookie=cookie)
        else:
            self._send_json(401, {"error": "That password is not right."})

    def do_GET(self):
        if self.path == "/api/config":
            signed_in = self._signed_in()
            config = {"authRequired": self.auth.required, "signedIn": signed_in, "levels": list(LEVELS)}
            if signed_in:
                config.update(self.brain.describe())
            self._send_json(200, config)
            return
        if self.path.startswith("/api/"):
            self._send_json(404, {"error": "Not found"})
            return
        super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/login":
                self._login()
            elif not self._signed_in():
                self._send_json(401, {"error": "Enter the password to continue.", "signIn": True})
            elif self.path == "/api/turn":
                data = self._read_json()
                level = data.get("level")
                if level not in LEVELS:
                    raise BadRequest("level must be one of " + ", ".join(LEVELS))
                self._send_json(200, self.brain.follow_up(level, clean_history(data.get("history", []))))
            elif self.path == "/api/translate":
                data = self._read_json()
                text = str(data.get("text", "")).strip()[:MAX_TEXT]
                self._send_json(200, {"translation": self.brain.translate(text) if text else ""})
            else:
                self._send_json(404, {"error": "Not found"})
        except BadRequest as error:
            self._send_json(400, {"error": str(error)})
        except RateLimited as error:
            self._send_json(429, {"error": str(error)})
        except BrainError as error:
            self._send_json(502, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError):
            pass  # The browser cancelled the request (Stop button).


def main():
    env = load_env(ROOT / ".env")
    Handler.brain = make_brain(env)
    Handler.auth = Auth(env.get("APP_PASSWORD", "").strip())
    host = env.get("HOST", "").strip() or "127.0.0.1"
    port = int(env.get("PORT", "").strip() or "8000")
    info = Handler.brain.describe()

    if host not in LOCAL_HOSTS and not Handler.auth.required and not info["demo"]:
        raise SystemExit(
            f"Refusing to listen on {host} without a password: anyone who found the address "
            "could use your API key. Set APP_PASSWORD, or set HOST=127.0.0.1."
        )

    server = ThreadingHTTPServer((host, port), partial(Handler, directory=str(STATIC)))
    print(f"German Speaking Partner running at http://{'localhost' if host in LOCAL_HOSTS else host}:{port}")
    print(f"Conversation brain: {info['provider']} ({info['model']})")
    print("Password: " + ("required" if Handler.auth.required else "none (this machine only)"))
    if info["demo"]:
        print("Demo mode: canned replies. Copy .env.example to .env and add a key for real conversation.")
    sys.stdout.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
