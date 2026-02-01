from __future__ import annotations

import os
from pathlib import Path
import sys
from flask import Flask, render_template, request, jsonify
from flask_cors import CORS

from sheets_repo import SheetsRepo

from dotenv import load_dotenv

load_dotenv()

SHEET_ID = os.environ.get("SPREADSHEET_ID") or os.environ.get("SHEET_ID") or "1EbxX-duNfkOw6EWHMYmrTurKLbL0gdOlhYY5eC2YEKQ"

app = Flask(__name__)
CORS(app)
repo = SheetsRepo(sheet_id=SHEET_ID)

@app.get("/health")
def health():
    return jsonify({"ok": True})


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