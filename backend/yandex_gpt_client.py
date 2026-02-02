# backend/yandex_gpt_client.py
from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional, Tuple

import requests

YANDEX_COMPLETION_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"


class YandexGPTError(RuntimeError):
    pass


def _env(name: str) -> str:
    v = os.getenv(name, "").strip()
    if not v:
        raise YandexGPTError(f"Missing env var: {name}")
    return v


def _post_completion(
    *,
    api_key: str,
    folder_id: str,
    messages: List[Dict[str, str]],
    temperature: float = 0.4,
    max_tokens: int = 600,
    timeout: int = 60,
) -> str:
    """
    Returns assistant text (string) from YandexGPT.
    """
    payload = {
        "modelUri": f"gpt://{folder_id}/yandexgpt/latest",
        "completionOptions": {
            "stream": False,
            "temperature": temperature,
            "maxTokens": max_tokens,
        },
        "messages": messages,
    }

    r = requests.post(
        YANDEX_COMPLETION_URL,
        headers={
            "Authorization": f"Api-Key {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=timeout,
    )

    # На ошибках поднимем максимально информативное исключение
    if r.status_code >= 400:
        raise YandexGPTError(f"YandexGPT HTTP {r.status_code}: {r.text}")

    data = r.json()
    text = (
        data.get("result", {})
        .get("alternatives", [{}])[0]
        .get("message", {})
        .get("text", "")
    )
    if not isinstance(text, str) or not text.strip():
        raise YandexGPTError("Empty response text from YandexGPT")
    return text.strip()


def _strip_code_fences(text: str) -> str:
    """
    Removes surrounding ```...``` or ```json...``` fences if present.
    """
    t = text.strip()
    if t.startswith("```"):
        # remove opening fence line: ``` or ```json etc.
        t = re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", t)
        # remove last closing fence
        t = re.sub(r"\s*```$", "", t).strip()
    return t.strip()


def _extract_first_json_array(text: str) -> str:
    """
    Extracts substring from first '[' to matching last ']' (best-effort).
    Good enough for model outputs where we expect one array.
    """
    t = _strip_code_fences(text)

    start = t.find("[")
    end = t.rfind("]")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON array brackets found in model output")

    return t[start : end + 1].strip()


def _parse_recs_json(text: str) -> List[Dict[str, Any]]:
    """
    Parses model output into list of dicts.
    Accepts raw JSON or JSON inside fences or with extra text.
    """
    candidate = _extract_first_json_array(text)
    data = json.loads(candidate)

    if not isinstance(data, list):
        raise ValueError("Expected JSON array")

    return data


def _normalize_recs(items: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    """
    Ensures output schema and exactly 5 items.
    """
    if len(items) < 5:
        raise ValueError(f"Expected 5 items, got {len(items)}")

    out: List[Dict[str, str]] = []
    for it in items[:5]:
        if not isinstance(it, dict):
            raise ValueError("Each item must be an object")
        out.append(
            {
                "title": str(it.get("title", "")).strip(),
                "author": str(it.get("author", "")).strip(),
                "genre": str(it.get("genre", "")).strip(),
                "why": str(it.get("why", "")).strip(),
            }
        )

    # базовая валидация полей
    for i, rec in enumerate(out, start=1):
        if not rec["title"] or not rec["author"] or not rec["why"]:
            raise ValueError(f"Item #{i} has empty required fields")

    return out


def _repair_to_json_array(
    *,
    api_key: str,
    folder_id: str,
    raw_text: str,
) -> List[Dict[str, str]]:
    """
    Second-pass: ask the model to convert its own output to strict JSON array.
    """
    system = (
        "Ты превращаешь текст в СТРОГО валидный JSON. "
        "Никакого markdown, никаких ``` и никаких пояснений. "
        "Только JSON."
    )
    user = f"""
Преобразуй следующий текст в СТРОГО валидный JSON.

Требуемый формат:
[
  {{"title":"...","author":"...","genre":"...","why":"..."}},
  ... (всего 5 объектов)
]

Текст:
{raw_text}
""".strip()

    fixed_text = _post_completion(
        api_key=api_key,
        folder_id=folder_id,
        messages=[
            {"role": "system", "text": system},
            {"role": "user", "text": user},
        ],
        temperature=0.0,
        max_tokens=1400,
        timeout=60,
    )
    items = _parse_recs_json(fixed_text)
    return _normalize_recs(items)


def generate_book_recommendations(
    *,
    profile_text: str,
    temperature: float = 0.4,
    max_tokens: int = 1200,
    use_repair: bool = True,
) -> List[Dict[str, str]]:
    """
    Main entrypoint.

    Returns:
      [
        {"title": "...", "author": "...", "genre": "...", "why": "..."},
        ... x5
      ]
    """
    api_key = _env("YC_API_KEY")
    folder_id = _env("YC_FOLDER_ID")

    system = (
        "Ты книжный рекомендательный ассистент. "
        "Задача: предложить ровно 5 книг, которые понравятся пользователю, "
        "учитывая его вкусы. "
        "Отвечай СТРОГО валидным JSON без markdown и без ```."
    )

    user = f"""
        Ты — книжный рекомендательный движок. Цель — максимальная релевантность вкусу пользователя.

        Профиль пользователя:
        {profile_text}

        Алгоритм (внутренне, не показывай):
        1) Подбери 15 кандидатов.
        2) Исключи всё, что запрещено в профиле.
        3) Отранжируй по релевантности вкусу.
        4) Верни 5 лучших.

        Жёсткие правила:
        - Ровно 5 книг.
        - Не предлагай книги из списка "Запрещено рекомендовать".
        - Не повторяй автора (максимум 1 книга на автора).
        - Не предлагай очевидную школьную классику, если она не похожа на любимые книги пользователя.
        - Минимум 3 из 5 книг должны быть неочевидными.

        Формат ответа:
        СТРОГО валидный JSON без markdown и без ```.

        [
        {{"title":"...","author":"...","genre":"...","why":"..."}},
        ... (5 объектов)
        ]
        """.strip()

    raw = _post_completion(
        api_key=api_key,
        folder_id=folder_id,
        messages=[
            {"role": "system", "text": system},
            {"role": "user", "text": user},
        ],
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=60,
    )

    try:
        items = _parse_recs_json(raw)
        return _normalize_recs(items)
    except Exception as e:
        if not use_repair:
            raise YandexGPTError(f"GPT returned invalid JSON: {e}\nRaw:\n{raw}")

        # repair pass
        try:
            return _repair_to_json_array(api_key=api_key, folder_id=folder_id, raw_text=raw)
        except Exception as e2:
            raise YandexGPTError(
                f"GPT returned invalid JSON (and repair failed): {e2}\nRaw:\n{raw}"
            ) from e2