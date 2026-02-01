from __future__ import annotations

import os
import base64
from functools import wraps

from pathlib import Path
import sys
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS 

from sheets_repo import SheetsRepo

from dotenv import load_dotenv

load_dotenv()

SHEET_ID = os.environ.get("SPREADSHEET_ID") or os.environ.get("SHEET_ID") or "1EbxX-duNfkOw6EWHMYmrTurKLbL0gdOlhYY5eC2YEKQ"

app = Flask(__name__)
CORS(
    app,
    resources={r"/api/*": {"origins": [
        "https://bookshelfly.netlify.app",
        "http://localhost:8000"
    ]}}
)
repo = SheetsRepo(sheet_id=SHEET_ID)

APP_LOGIN = os.getenv("AUTH_LOGIN", "")
APP_PASSWORD = os.getenv("AUTH_PASSWORD", "")

print("APP_LOGIN =", repr(APP_LOGIN))
print("APP_PASSWORD =", repr(APP_PASSWORD))

def _unauthorized():
    # Browser/clients can show a login prompt, but we'll also use it for our frontend modal
    return (
        jsonify({"error": "unauthorized"}),
        401,
        {"WWW-Authenticate": 'Basic realm="Bookshelf"'},
    )

def require_basic_auth(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        # allow CORS preflight
        if request.method == "OPTIONS":
            return ("", 204)

        # if not set — fail closed in prod, but you can choose to allow locally
        if not APP_LOGIN or not APP_PASSWORD:
            return _unauthorized()

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return _unauthorized()

        try:
            b64 = auth.split(" ", 1)[1].strip()
            raw = base64.b64decode(b64).decode("utf-8")
            login, password = raw.split(":", 1)
        except Exception:
            return _unauthorized()

        if login != APP_LOGIN or password != APP_PASSWORD:
            return _unauthorized()

        return fn(*args, **kwargs)

    return wrapper

@app.get("/health")
def health():
    return jsonify({"ok": True})

@app.get("/api/auth/check")
def auth_check():
    # если дошли сюда — значит Basic Auth прошёл
    return jsonify({"ok": True})

@app.before_request
def protect_api():
    if request.path.startswith("/api/"):
        # re-use the same logic via a tiny inline check
        if request.method == "OPTIONS":
            return ("", 204)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return _unauthorized()

        try:
            b64 = auth.split(" ", 1)[1].strip()
            raw = base64.b64decode(b64).decode("utf-8")
            login, password = raw.split(":", 1)
        except Exception:
            return _unauthorized()

        if login != APP_LOGIN or password != APP_PASSWORD:
            return _unauthorized()

@app.get("/api/sync")
def api_sync():
    books, progress = repo.read_all()
    return jsonify({"books": books, "progress": progress})


@app.post("/api/books/upsert")
def api_books_upsert():
    book = request.get_json(force=True) or {}
    repo.upsert_book(book)
    books, progress = repo.read_all()
    return jsonify({"books": books, "progress": progress})


@app.post("/api/books/delete")
def api_books_delete():
    payload = request.get_json(force=True) or {}
    title = payload.get("title", "")
    author = payload.get("author", "")
    repo.delete_book(title=title, author=author)
    books, progress = repo.read_all()
    return jsonify({"books": books, "progress": progress})


@app.post("/api/progress/append")
def api_progress_append():
    item = request.get_json(force=True) or {}
    repo.append_progress(item)
    books, progress = repo.read_all()
    return jsonify({"books": books, "progress": progress})

import traceback

@app.errorhandler(Exception)
def handle_exception(e):
    print("EXCEPTION:", repr(e))
    traceback.print_exc()
    return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    import os

    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"

    app.run(host="0.0.0.0", port=port, debug=debug)