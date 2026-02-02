from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple, Optional
import hashlib

import gspread
from google.oauth2.service_account import Credentials

import os
import sys

import json
from datetime import datetime, timezone

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

def get_credentials(scopes=None):
    scopes = scopes or SCOPES

    creds_json = os.getenv("GOOGLE_CREDENTIALS_JSON")
    if creds_json:
        info = json.loads(creds_json)
        creds = Credentials.from_service_account_info(info)
        return creds.with_scopes(scopes)

    creds_path = os.getenv("CREDENTIALS_PATH", "credentials.json")
    creds = Credentials.from_service_account_file(creds_path)
    return creds.with_scopes(scopes)

BOOKS_SHEET_NAME = "Все книги"
PROGRESS_SHEET_NAME = "Прогресс"
AI_RECS_SHEET = "AI рекомендации"

# Expected headers from user examples (A..S = 19)
BOOKS_HEADERS = [
    "Название",
    "Автор",
    "Статус",
    "Жанр",
    "Количество страниц",
    "Рейтинг",
    "Закончено",
    "Год",
    "Image",
    "Полезность",
    "Увлекательность",
    "Понятность",
    "Стиль и язык",
    "Эмоции",
    "Актуальность",
    "Глубина",
    "Практичность",
    "Оригинальность",
    "Рекомендация",
]

PROGRESS_HEADERS = [
    "Книга",
    "Страница старта",
    "Страница завершения",
    "Дата и время начала чтения",
    "Дата и время окончания чтения",
]

AI_RECS_HEADERS = [
    "created_at",
    "result_json",
]

def _norm(v: Any) -> str:
    return ("" if v is None else str(v)).strip()


def _to_int(v: Any) -> Optional[int]:
    s = _norm(v)
    if s == "":
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _to_float(v: Any) -> Optional[float]:
    s = _norm(v)
    if s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _book_id(title: str, author: str) -> str:
    raw = f"{_norm(title).lower()}|{_norm(author).lower()}".encode("utf-8")
    return hashlib.sha1(raw).hexdigest()


def _map_status(s: Any) -> str:
    x = _norm(s).lower()
    if x in {"planned", "reading", "completed"}:
        return x

    # Russian variants
    if x in {"план", "в планах", "запланировано", "планирую"}:
        return "planned"
    if x in {"читаю", "в процессе", "чтение"}:
        return "reading"
    if x in {"прочитано", "завершено", "закончено", "окончил", "готово"}:
        return "completed"

    # empty/unknown -> planned
    return "planned"

def _status_to_sheet_value(s: Any) -> str:
    """Convert any incoming status representation to *Russian* sheet value.

    Sheet must keep only 3 values:
    - прочитано
    - читаю
    - хочу прочитать
    """
    st = _map_status(s)
    if st == "completed":
        return "прочитано"
    if st == "reading":
        return "читаю"
    return "хочу прочитать"


class SheetsRepo:
    def __init__(self, sheet_id: str):
        self.sheet_id = sheet_id
        self.creds = get_credentials(SCOPES)
        self.gc = gspread.authorize(self.creds)

    def _client(self) -> gspread.Client:
        return self.gc

    def _open(self):
        sh = self.gc.open_by_key(self.sheet_id)
        ws_books = sh.worksheet(BOOKS_SHEET_NAME)
        ws_progress = sh.worksheet(PROGRESS_SHEET_NAME)
        ws_ai = sh.worksheet(AI_RECS_SHEET)
        return ws_books, ws_progress, ws_ai

    def _ensure_headers(self, ws: gspread.Worksheet, expected: List[str]):
        # Ensure sheet has enough columns
        if ws.col_count < len(expected):
            ws.resize(cols=len(expected))

        current = ws.row_values(1)
        current_norm = [_norm(x) for x in current]
        if current_norm != expected:
            ws.update("A1", [expected])

    @staticmethod
    def _header_index(ws: gspread.Worksheet) -> Dict[str, int]:
        headers = ws.row_values(1)
        idx = {}
        for i, h in enumerate(headers):
            h = _norm(h)
            if h:
                idx[h] = i
        return idx

    def read_all(self) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        ws_books, ws_progress, _ = self._open()
        self._ensure_headers(ws_books, BOOKS_HEADERS)
        self._ensure_headers(ws_progress, PROGRESS_HEADERS)

        books_rows = ws_books.get_all_records()
        progress_rows = ws_progress.get_all_records()

        progress: List[Dict[str, Any]] = []
        for r in progress_rows:
            progress.append({
                "book": _norm(r.get("Книга")),
                "startPage": _to_int(r.get("Страница старта")) or 0,
                "endPage": _to_int(r.get("Страница завершения")) or 0,
                "startAt": _norm(r.get("Дата и время начала чтения")),
                "endAt": _norm(r.get("Дата и время окончания чтения")),
            })

        # aggregate progress by title
        prog_by_title: Dict[str, Dict[str, Any]] = {}
        for p in progress:
            t = _norm(p.get("book"))
            if not t:
                continue
            agg = prog_by_title.setdefault(t, {"currentPage": 0, "startAt": None})
            agg["currentPage"] = max(agg["currentPage"], int(p.get("endPage") or 0))
            sa = _norm(p.get("startAt"))
            if sa:
                if agg["startAt"] is None or sa < agg["startAt"]:
                    agg["startAt"] = sa

        books: List[Dict[str, Any]] = []
        for r in books_rows:
            title = _norm(r.get("Название"))
            author = _norm(r.get("Автор"))
            status = _map_status(r.get("Статус"))
            genre = _norm(r.get("Жанр"))
            pages = _to_int(r.get("Количество страниц")) or 0
            rating = _to_float(r.get("Рейтинг"))
            finished = _norm(r.get("Закончено"))
            year = _to_int(r.get("Год"))
            image = _norm(r.get("Image"))
            comment = _norm(r.get("Комментарии"))  # not in expected, but keep if exists
            recommendation = _norm(r.get("Рекомендация"))

            criteria = {
                "usefulness": _to_int(r.get("Полезность")),
                "engagement": _to_int(r.get("Увлекательность")),
                "clarity": _to_int(r.get("Понятность")),
                "style": _to_int(r.get("Стиль и язык")),
                "emotions": _to_int(r.get("Эмоции")),
                "relevance": _to_int(r.get("Актуальность")),
                "depth": _to_int(r.get("Глубина")),
                "practicality": _to_int(r.get("Практичность")),
                "originality": _to_int(r.get("Оригинальность")),
            }

            prog = prog_by_title.get(title, {"currentPage": 0, "startAt": None})

            books.append({
                "id": _book_id(title, author),
                "title": title,
                "author": author,
                "status": status,
                "genre": genre,
                "pages": pages,
                "currentPage": prog["currentPage"],
                "startAt": prog["startAt"],
                "rating": rating,
                "finished": finished,
                "year": year,
                "image": image,
                "comment": comment,
                "criteria": criteria,
                "recommendation": recommendation,
            })

        return books, progress

    def _find_row_index(self, ws: gspread.Worksheet, title: str, author: str) -> Optional[int]:
        # Find by title+author in existing values
        all_values = ws.get_all_values()
        rows = all_values[1:]
        key = f"{_norm(title).lower()}||{_norm(author).lower()}"
        for i, row in enumerate(rows, start=2):
            t = _norm(row[0] if len(row) > 0 else "")
            a = _norm(row[1] if len(row) > 1 else "")
            if f"{t.lower()}||{a.lower()}" == key:
                return i
        return None

    def upsert_book(self, book: Dict[str, Any]) -> None:
        ws_books, _, _ = self._open()
        self._ensure_headers(ws_books, BOOKS_HEADERS)

        title = _norm(book.get("title"))
        author = _norm(book.get("author"))
        incoming_status = book.get("status", None)
        status_cell: Optional[str] = None
        if incoming_status is not None and str(incoming_status).strip() != "":
            status_cell = _status_to_sheet_value(incoming_status)
        genre = _norm(book.get("genre"))
        pages = book.get("pages")
        pages = int(pages) if pages not in (None, "") else ""
        rating = book.get("rating")
        rating = float(rating) if rating not in (None, "") else ""
        finished = _norm(book.get("finished"))
        year = book.get("year")
        year = int(year) if year not in (None, "") else ""
        image = _norm(book.get("image"))
        recommendation = _norm(book.get("recommendation"))
        c = book.get("criteria") or {}

        if status_cell is None:
            status_cell = "хочу прочитать"

        row = [
            title,
            author,
            status_cell,
            genre,
            pages,
            rating,
            finished,
            year,
            image,
            c.get("usefulness") or "",
            c.get("engagement") or "",
            c.get("clarity") or "",
            c.get("style") or "",
            c.get("emotions") or "",
            c.get("relevance") or "",
            c.get("depth") or "",
            c.get("practicality") or "",
            c.get("originality") or "",
            recommendation,
        ]

        row_index = self._find_row_index(ws_books, title, author)
        if row_index is None:
            ws_books.append_row(row, value_input_option="USER_ENTERED")
        else:
            # update exact range length
            ws_books.update(f"A{row_index}:S{row_index}", [row], value_input_option="USER_ENTERED")
        
        if status_cell is None:
            if row_index is not None:
                existing = ws_books.row_values(row_index)  # 1-indexed
                # Status is column C (index 2)
                existing_status = existing[2] if len(existing) > 2 else ""
                status_cell = _status_to_sheet_value(existing_status)
            else:
                status_cell = "хочу прочитать"

    def delete_book(self, title: str, author: str) -> None:
        ws_books, _, _ = self._open()
        self._ensure_headers(ws_books, BOOKS_HEADERS)
        row_index = self._find_row_index(ws_books, title, author)
        if row_index is not None:
            ws_books.delete_rows(row_index)

    def append_progress(self, item: Dict[str, Any]) -> None:
        _, ws_progress, _ = self._open()
        self._ensure_headers(ws_progress, PROGRESS_HEADERS)

        row = [
            _norm(item.get("book")),
            int(item.get("startPage", 0) or 0),
            int(item.get("endPage", 0) or 0),
            _norm(item.get("startAt")),
            _norm(item.get("endAt")),
        ]
        ws_progress.append_row(row, value_input_option="USER_ENTERED")

    def append_ai_recs(self, recs: List[Dict[str, Any]]):
        _, _, ws_ai = self._open()
        self._ensure_headers(ws_ai, AI_RECS_HEADERS)

        created_at = datetime.now(timezone.utc).isoformat()
        row = [created_at, json.dumps(recs, ensure_ascii=False)]
        ws_ai.append_row(row, value_input_option="USER_ENTERED")


    def read_ai_recs_last(self):
        _, _, ws_ai = self._open()

        values = ws_ai.get_all_values()
        if len(values) < 2:
            return None

        last = values[-1]
        created_at = last[0] if len(last) > 0 else None
        recs_json = last[1] if len(last) > 1 else "[]"

        try:
            recs = json.loads(recs_json) if recs_json else []
        except Exception:
            recs = []

        return {"created_at": created_at, "recs": recs}