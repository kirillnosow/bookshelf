# backend/ai_profile.py
from __future__ import annotations

from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Tuple


def _norm_text(x: Any) -> str:
    if x is None:
        return ""
    return str(x).strip()


def _norm_key(title: Any, author: Any) -> str:
    t = _norm_text(title).lower()
    a = _norm_text(author).lower()
    if not t or not a:
        return ""
    return f"{t}|{a}"


def _to_float(x: Any) -> Optional[float]:
    """
    Best-effort conversion to float.
    Accepts int/float/str ("8", "8.5", "8,5").
    Returns None if cannot parse.
    """
    if x is None:
        return None
    if isinstance(x, (int, float)):
        return float(x)
    if isinstance(x, str):
        s = x.strip().replace(",", ".")
        if not s:
            return None
        try:
            return float(s)
        except Exception:
            return None
    return None


def _criteria_items(criteria: Any) -> List[Tuple[str, float]]:
    """
    Returns list of (criterion_name, numeric_value) for valid numeric values.
    """
    if not isinstance(criteria, dict):
        return []
    out: List[Tuple[str, float]] = []
    for k, v in criteria.items():
        name = _norm_text(k)
        val = _to_float(v)
        if not name or val is None:
            continue
        out.append((name, val))
    return out


def _safe_genre(x: Any) -> str:
    # жанр может быть пустой, None, список и т.п.
    if x is None:
        return ""
    if isinstance(x, str):
        return x.strip()
    if isinstance(x, (list, tuple)):
        return ", ".join([str(i).strip() for i in x if str(i).strip()])
    return str(x).strip()


def build_profile_text(books: List[Dict[str, Any]], excluded_set: set[str]) -> str:
    """
    Produces a compact but informative profile for LLM prompt.
    books: list of dicts from your sheet repo (title, author, genre, rating, criteria...)
    excluded_set: set of normalized keys "title|author" (lowercase) that must NOT be recommended
    """
    # 1) нормализуем книги
    norm_books: List[Dict[str, Any]] = []
    for b in books or []:
        title = _norm_text(b.get("title"))
        author = _norm_text(b.get("author"))
        rating = _to_float(b.get("rating"))
        genre = _safe_genre(b.get("genre"))
        criteria = _criteria_items(b.get("criteria"))

        norm_books.append(
            {
                "title": title,
                "author": author,
                "key": _norm_key(title, author),
                "rating": rating,
                "genre": genre,
                "criteria": criteria,  # list[(name, value)]
            }
        )

    rated = [b for b in norm_books if b["rating"] is not None]

    # 2) топы: любимые/нелюбимые
    liked = sorted([b for b in rated if b["rating"] >= 8.0], key=lambda x: x["rating"], reverse=True)[:7]
    disliked = sorted([b for b in rated if b["rating"] <= 4.0], key=lambda x: x["rating"])[:5]

    # 3) агрегируем критерии: что обычно нравится/раздражает
    crit_like = Counter()
    crit_dislike = Counter()
    for b in rated:
        for k, v in b["criteria"]:
            if v >= 8.0:
                crit_like[k] += 1
            if v <= 4.0:
                crit_dislike[k] += 1

    # 4) агрегируем жанры (как доп. сигнал)
    like_genres = Counter()
    dislike_genres = Counter()
    for b in liked:
        if b["genre"]:
            like_genres[b["genre"]] += 1
    for b in disliked:
        if b["genre"]:
            dislike_genres[b["genre"]] += 1

    def fmt_book(b: Dict[str, Any]) -> str:
        # берём 2 самых сильных критерия (по значению)
        top_crit = sorted(b["criteria"], key=lambda x: x[1], reverse=True)[:2]
        top_str = ", ".join([f"{k}:{int(v) if v.is_integer() else v:g}" for k, v in top_crit]) if top_crit else "—"

        g = b["genre"] or "—"
        r = b["rating"]
        r_str = f"{r:g}" if r is not None else "—"
        return f"- {b['title']} — {b['author']} (жанр: {g}, рейтинг: {r_str}, сильные стороны: {top_str})"

    # 5) формируем профиль (компактно, но с якорями)
    lines: List[str] = []

    # Идея: сначала якоря (люблю/не люблю), потом сигналы (критерии/жанры), потом запреты.
    lines.append("ЛЮБЛЮ (высокие оценки, примеры):")
    lines.extend([fmt_book(b) for b in liked] or ["- нет данных"])

    lines.append("")
    lines.append("НЕ ЛЮБЛЮ (низкие оценки, примеры):")
    lines.extend([fmt_book(b) for b in disliked] or ["- нет данных"])

    lines.append("")
    lines.append("СИГНАЛЫ ПО КРИТЕРИЯМ:")
    lines.append("Что обычно важно (часто 8–10): " + (", ".join([k for k, _ in crit_like.most_common(8)]) or "нет данных"))
    lines.append("Что обычно раздражает (часто 0–4): " + (", ".join([k for k, _ in crit_dislike.most_common(8)]) or "нет данных"))

    lines.append("")
    lines.append("СИГНАЛЫ ПО ЖАНРАМ:")
    lines.append("Чаще нравится: " + (", ".join([g for g, _ in like_genres.most_common(5)]) or "нет данных"))
    lines.append("Чаще не нравится: " + (", ".join([g for g, _ in dislike_genres.most_common(5)]) or "нет данных"))

    # 6) запреты (важно: не раздувать промпт)
    lines.append("")
    lines.append("ЗАПРЕЩЕНО РЕКОМЕНДОВАТЬ (уже есть или уже рекомендовалось):")
    # excluded_set уже приходит нормализованный (title|author, lowercase), но на всякий:
    sample = sorted([x for x in excluded_set if x and "|" in x])[:120]
    if sample:
        # чтобы модель не путалась, печатаем в более читаемом виде
        for key in sample:
            t, a = key.split("|", 1)
            lines.append(f"- {t} — {a}")
    else:
        lines.append("- нет")

    return "\n".join(lines).strip()


# Алиас для обратной совместимости, если где-то импортировали build_profile
def build_profile(books: List[Dict[str, Any]], excluded_set: set[str]) -> str:
    return build_profile_text(books, excluded_set)