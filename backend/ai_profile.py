from collections import Counter

def build_profile_text(books, excluded_set: set[str]) -> str:
    rated = [b for b in books if b.get("rating") is not None]

    liked = sorted(
        [b for b in rated if (b["rating"] or 0) >= 8],
        key=lambda x: x["rating"],
        reverse=True
    )[:7]

    disliked = sorted(
        [b for b in rated if (b["rating"] or 0) <= 4],
        key=lambda x: x["rating"]
    )[:5]

    crit_like = Counter()
    crit_dislike = Counter()

    for b in rated:
        for k, v in (b.get("criteria") or {}).items():
            if v is None:
                continue
            if v >= 8:
                crit_like[k] += 1
            if v <= 4:
                crit_dislike[k] += 1

    def fmt(b):
        c = b.get("criteria") or {}
        top = sorted(c.items(), key=lambda x: x[1], reverse=True)[:2]
        tops = ", ".join([f"{k}:{v}" for k, v in top]) if top else "—"
        return f"- {b['title']} — {b['author']} (жанр: {b.get('genre')}, рейтинг: {b['rating']}, сильные стороны: {tops})"

    lines = []
    lines.append("Люблю (высокие оценки):")
    lines.extend([fmt(b) for b in liked] or ["- нет данных"])

    lines.append("\nНе люблю (низкие оценки):")
    lines.extend([fmt(b) for b in disliked] or ["- нет данных"])

    lines.append("\nЧто обычно важно:")
    lines.append(", ".join(crit_like.keys()) or "нет данных")

    lines.append("\nЧто обычно раздражает:")
    lines.append(", ".join(crit_dislike.keys()) or "нет данных")

    lines.append("\nЗапрещено рекомендовать (уже есть или уже рекомендовалось):")
    for x in list(excluded_set)[:100]:
        lines.append(f"- {x}")

    return "\n".join(lines)