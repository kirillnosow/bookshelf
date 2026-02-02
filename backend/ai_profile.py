from collections import Counter


def build_profile(books: list[dict]) -> str:
    rated = [b for b in books if b.get("rating")]

    liked = [b for b in rated if b["rating"] >= 8]
    disliked = [b for b in rated if b["rating"] <= 4]

    like_genres = Counter(b["genre"] for b in liked if b.get("genre"))
    dislike_genres = Counter(b["genre"] for b in disliked if b.get("genre"))

    lines = [
        f"Любимые жанры: {', '.join(like_genres.keys()) or 'нет'}",
        f"Нелюбимые жанры: {', '.join(dislike_genres.keys()) or 'нет'}",
        "",
        "Уже прочитанные книги (НЕ предлагать):"
    ]

    for b in rated[:50]:
        lines.append(f"- {b['title']} — {b.get('author','')}")

    return "\n".join(lines)