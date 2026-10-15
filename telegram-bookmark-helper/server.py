#!/usr/bin/env python3
"""Telegram Bookmark helper: downloads video/audio with yt-dlp and uploads it to your Telegram topic.

Listens on 127.0.0.1 only and requires a secret. Usage: python server.py [--port 8765]
"""
import argparse, hmac, importlib.util, json, os, re, secrets, shutil, subprocess, sys, tempfile, threading, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

TOKEN_RE = re.compile(r"^\d{5,15}:[A-Za-z0-9_-]{30,60}$")
CHAT_RE = re.compile(r"^(-?\d{5,20}|@[A-Za-z0-9_]{5,32})$")
CFG = {}
SLOTS = threading.BoundedSemaphore(2)          # at most 2 downloads at once


def redact(text, token):
    return str(text).replace(token, "***")


def tg_json(token, method, fields):
    req = urllib.request.Request(f"{CFG['api']}/bot{token}/{method}", data=json.dumps(fields).encode(),
                                 headers={"Content-Type": "application/json"})
    return _open(req, token)


def tg_upload(token, method, fields, file_field, path, workdir):
    boundary = secrets.token_hex(16)
    body_path = Path(workdir) / "upload.bin"
    with open(body_path, "wb") as out:
        for k, v in fields.items():
            if v is not None:
                out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
        name = path.name.replace('"', "")
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{name}"\r\n'
                  f"Content-Type: application/octet-stream\r\n\r\n".encode())
        with open(path, "rb") as f:
            shutil.copyfileobj(f, out)
        out.write(f"\r\n--{boundary}--\r\n".encode())
    with open(body_path, "rb") as body:
        req = urllib.request.Request(f"{CFG['api']}/bot{token}/{method}", data=body, headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(body_path.stat().st_size)})
        return _open(req, token)


def _open(req, token):
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            desc = json.load(e).get("description", "")
        except Exception:
            desc = ""
        raise RuntimeError(redact(desc or f"Telegram error {e.code}", token))
    except Exception as e:
        raise RuntimeError(redact(e, token))


def download(url, kind, tmp):
    cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-progress", "--no-warnings", "--restrict-filenames",
           "--max-filesize", f"{CFG['max_mb']}M", "-o", os.path.join(tmp, "%(title).80B-%(id)s.%(ext)s")]
    if kind == "audio":
        cmd += ["-x", "--audio-format", "mp3", "--audio-quality", "0"]
    else:
        cmd += ["-f", "bv*[height<=720]+ba/b[height<=720]/b", "--merge-output-format", "mp4"]
    cmd += ["--", url]                                   # "--" stops the URL being read as an option
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if r.returncode != 0:
        raise RuntimeError((r.stderr.strip().splitlines() or ["yt-dlp failed"])[-1][:250])
    files = [f for f in Path(tmp).iterdir() if f.is_file() and f.suffix not in (".part", ".ytdl", ".bin")]
    if not files:
        raise RuntimeError("Nothing was downloaded (the file may be over the size limit).")
    return max(files, key=lambda f: f.stat().st_size)


def run_job(job):
    token, chat, thread = job["token"], job["chat_id"], job["thread_id"]
    base = {"chat_id": chat, "message_thread_id": thread}
    with SLOTS:
        tmp = tempfile.mkdtemp(prefix="tgbookmark-")
        try:
            path = download(job["url"], job["kind"], tmp)
            mb = path.stat().st_size / 1048576
            if mb > CFG["max_mb"]:
                raise RuntimeError(f"File is {mb:.0f} MB; the limit is {CFG['max_mb']} MB (see README for big files).")
            audio = job["kind"] == "audio"
            fields = {**base, "caption": job["caption"]}
            if not audio:
                fields["supports_streaming"] = "true"
            try:
                tg_upload(token, "sendAudio" if audio else "sendVideo", fields, "audio" if audio else "video", path, tmp)
            except RuntimeError:
                tg_upload(token, "sendDocument", {k: v for k, v in fields.items() if k != "supports_streaming"}, "document", path, tmp)
        except Exception as e:
            try:
                tg_json(token, "sendMessage", {**{k: v for k, v in base.items() if v is not None},
                                               "text": f"❌ Download failed: {redact(e, token)[:300]}\n{job['url']}"})
            except Exception:
                pass
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "TGBookmark"

    def log_message(self, *a):
        pass

    def reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        if host not in ("127.0.0.1", "localhost", "[::1]"):            # blocks DNS-rebinding
            return False
        origin = self.headers.get("Origin")
        if origin and not origin.startswith(("chrome-extension://", "moz-extension://")):   # blocks web pages
            return False
        given = self.headers.get("X-Helper-Secret", "").encode()
        return hmac.compare_digest(given, CFG["secret"].encode())

    def do_GET(self):
        if not self.allowed():
            return self.reply(401, {"ok": False})
        if self.path == "/health":
            return self.reply(200, {"ok": True, "yt_dlp": importlib.util.find_spec("yt_dlp") is not None,
                                    "ffmpeg": shutil.which("ffmpeg") is not None})
        self.reply(404, {"ok": False})

    def do_POST(self):
        if not self.allowed():
            return self.reply(401, {"ok": False})
        if self.path != "/download":
            return self.reply(404, {"ok": False})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            if not 0 < n <= 8192:
                raise ValueError
            d = json.loads(self.rfile.read(n))
            u = urlparse(str(d.get("url", "")))
            thread = d.get("thread_id")
            ok = (u.scheme in ("http", "https") and u.netloc and d.get("kind") in ("video", "audio")
                  and TOKEN_RE.match(str(d.get("token", ""))) and CHAT_RE.match(str(d.get("chat_id", "")))
                  and (thread is None or (isinstance(thread, int) and thread > 0)))
            if not ok:
                raise ValueError
        except Exception:
            return self.reply(400, {"ok": False, "error": "bad request"})
        job = {"url": d["url"], "kind": d["kind"], "token": d["token"], "chat_id": str(d["chat_id"]),
               "thread_id": thread, "caption": str(d.get("caption", ""))[:1000]}
        threading.Thread(target=run_job, args=(job,), daemon=True).start()
        self.reply(202, {"ok": True})


def load_secret(arg):
    if arg or os.environ.get("HELPER_SECRET"):
        return arg or os.environ["HELPER_SECRET"]
    f = Path.home() / ".telegram-bookmark-secret"
    if not f.exists():
        f.write_text(secrets.token_urlsafe(24))
        try:
            f.chmod(0o600)
        except OSError:
            pass
    return f.read_text().strip()


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--secret")
    ap.add_argument("--api-base", default="https://api.telegram.org", help="use a local Bot API server for files over 50 MB")
    ap.add_argument("--max-mb", type=int, default=50)
    a = ap.parse_args()
    CFG.update(secret=load_secret(a.secret), api=a.api_base.rstrip("/"), max_mb=a.max_mb)
    if importlib.util.find_spec("yt_dlp") is None:
        print("! yt-dlp is not installed. Run: python -m pip install -U yt-dlp")
    if not shutil.which("ffmpeg"):
        print("! ffmpeg not found. MP3 and merged video need it.")
    print(f"Telegram Bookmark helper on http://127.0.0.1:{a.port}\nSecret (paste into the extension): {CFG['secret']}")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
