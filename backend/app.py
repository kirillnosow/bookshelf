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

import time
from datetime import datetime, date
from zoneinfo import ZoneInfo

import traceback

from ai_profile import build_profile_text
from yandex_gpt_client import generate_book_recommendations

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

SYNC_CACHE = {"ts": 0.0, "data": None}
SYNC_TTL = int(os.getenv("SYNC_TTL", "10"))  # 10 секунд по умолчанию

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

TZ = ZoneInfo(os.getenv("APP_TZ", "Europe/Moscow"))

def _parse_dt(s: str):
    if not s:
        return None
    t = str(s).strip()
    if not t:
        return None

    # 1) "YYYY-MM-DD HH:mm"
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            pass

    # 2) "DD.MM.YYYY HH:mm" / "DD.MM.YYYY"
    for fmt in ("%d.%m.%Y %H:%M", "%d.%m.%Y"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            pass

    # 3) ISO (или "YYYY-MM-DDTHH:mm:ss", или "YYYY-MM-DD HH:mm:ss")
    try:
        iso = t.replace(" ", "T")
        return datetime.fromisoformat(iso)
    except Exception:
        return None

def compute_streak(progress_rows):
    days = set()
    for p in (progress_rows or []):
        dt = _parse_dt(p.get("endAt")) or _parse_dt(p.get("startAt"))
        if not dt:
            continue
        days.add(dt.date())

    today = datetime.now(TZ).date()

    if not days:
        return {
            "streak": 0,
            "icon": "candle",   # candle|fire
            "today_has_reading": False,
            "last_day": None,
            "today": today.isoformat(),
        }

    last_day = max(days)
    gap = (today - last_day).days

    # 3) пропущен день (последняя запись позавчера или раньше) -> сгорел
    if gap >= 2:
        return {
            "streak": 0,
            "icon": "candle",
            "today_has_reading": False,
            "last_day": last_day.isoformat(),
            "today": today.isoformat(),
        }

    # посчитаем длину "цепочки" на момент last_day
    cur = last_day
    streak = 0
    while cur in days:
        streak += 1
        cur = date.fromordinal(cur.toordinal() - 1)

    # 1) сегодня есть чтение -> огонёк
    if gap == 0:
        return {
            "streak": streak,
            "icon": "fire",
            "today_has_reading": True,
            "last_day": last_day.isoformat(),
            "today": today.isoformat(),
        }

    # 2) сегодня нет чтения, но вчера было:
    # показываем свечку и N только если стрик > 1, иначе (по твоему условию) -> 0
    if gap == 1:
        return {
            "streak": streak if streak > 1 else 0,
            "icon": "candle",
            "today_has_reading": False,
            "last_day": last_day.isoformat(),
            "today": today.isoformat(),
        }

def _xp_for_pages(pages: int) -> int:
    # если pages не заполнено — даём "среднюю" награду
    if not pages or pages <= 0:
        return 180
    if pages <= 300:
        return 100
    if pages <= 500:
        return 180
    if pages <= 800:
        return 300
    return 450


def compute_xp(books_rows, progress_rows):
    """
    XP = XP за прочитанные книги (по объёму) + XP за дни чтения (10 XP за день)
    - книга прочитана, если status == 'completed'
    - день чтения: есть хотя бы одна запись прогресса в этот день (берём endAt, если пусто — startAt)
    """
    # 1) XP за книги
    xp_books = 0
    for b in (books_rows or []):
        if (b.get("status") or "").strip().lower() == "completed":
            pages = int(b.get("pages") or 0)
            xp_books += _xp_for_pages(pages)

    # 2) XP за дни
    days = set()
    for p in (progress_rows or []):
        dt = _parse_dt(p.get("endAt")) or _parse_dt(p.get("startAt"))
        if not dt:
            continue
        days.add(dt.date())

    xp_days = 10 * len(days)
    xp_total = xp_books + xp_days

    return {
        "xp_total": xp_total,
        "xp_books": xp_books,
        "xp_days": xp_days,
        "days_count": len(days),
        "today": datetime.now(TZ).date().isoformat(),
    }

def _longest_streak(days_set: set[date]) -> int:
    if not days_set:
        return 0
    days = sorted(days_set)
    best = 1
    cur = 1
    for i in range(1, len(days)):
        if (days[i] - days[i - 1]).days == 1:
            cur += 1
            best = max(best, cur)
        else:
            cur = 1
    return best

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
    now = time.time()
    if SYNC_CACHE["data"] is not None and (now - SYNC_CACHE["ts"]) < SYNC_TTL:
        return jsonify(SYNC_CACHE["data"])

    books, progress = repo.read_all()
    data = {"books": books, "progress": progress}

    SYNC_CACHE["ts"] = now
    SYNC_CACHE["data"] = data
    return jsonify(data)

@app.get("/api/xp")
def api_xp():
    books, progress = repo.read_all()
    return jsonify(compute_xp(books, progress))

@app.post("/api/books/upsert")
def api_books_upsert():
    book = request.get_json(force=True) or {}
    repo.upsert_book(book)
    books, progress = repo.read_all()
    ai = repo.read_ai_recs_last()
    return jsonify({"books": books, "progress": progress, "ai": ai})


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

@app.post("/api/recs/ai")
def api_recs_ai():
    # 1. Читаем все книги пользователя
    books, _ = repo.read_all()

    # 2. Собираем "уже есть у пользователя" (прочитано / добавлено)
    owned = {
        f"{b['title'].strip().lower()}|{b['author'].strip().lower()}"
        for b in books
        if b.get("title") and b.get("author")
    }

    # 3. Собираем "уже рекомендовалось раньше"
    already_recommended = repo.get_already_recommended_set(limit=500)

    # 4. Итоговый blacklist (🚨 ЭТО И ЕСТЬ ПУНКТ 2.1)
    excluded = owned | already_recommended

    # 5. Строим профиль с учётом запрещённых книг
    profile = build_profile_text(books, excluded)

    # 6. Получаем рекомендации от GPT
    recs = generate_book_recommendations(profile_text=profile)

    # 7. Железный пост-фильтр (на всякий случай)
    recs = [
        r for r in recs
        if f"{r['title'].lower()}|{r['author'].lower()}" not in excluded
    ]

    # 8. Сохраняем результат в Google Sheet
    repo.append_ai_recs(recs)

    return jsonify({"recs": recs})

@app.get("/api/recs/ai")
def api_recs_ai_get():
    last = repo.read_ai_recs_last()
    return jsonify(last or {"created_at": None, "recs": []})

@app.errorhandler(Exception)
def handle_exception(e):
    print("EXCEPTION:", repr(e))
    traceback.print_exc()
    return jsonify({"error": str(e)}), 500

@app.get("/api/streak")
def api_streak():
    _, progress = repo.read_all()
    return jsonify(compute_streak(progress))

if __name__ == "__main__":
    import os

    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"

    app.run(host="0.0.0.0", port=port, debug=debug)