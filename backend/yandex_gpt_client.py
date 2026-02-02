import os
import json
import requests


YANDEX_URL = "https://llm.api.cloud.yandex.net/foundationModels/v1/completion"


def generate_recommendations(profile_text: str) -> list[dict]:
    api_key = os.environ["YC_API_KEY"]
    folder_id = os.environ["YC_FOLDER_ID"]

    payload = {
        "modelUri": f"gpt://{folder_id}/yandexgpt/latest",
        "completionOptions": {
            "stream": False,
            "temperature": 0.4,
            "maxTokens": 1200
        },
        "messages": [
            {
                "role": "system",
                "text": (
                    "Ты книжный рекомендательный ассистент. "
                    "Ты возвращаешь ТОЛЬКО валидный JSON."
                )
            },
            {
                "role": "user",
                "text": f"""
Вот профиль предпочтений пользователя:

{profile_text}

Верни СТРОГО JSON без текста вокруг.
Формат: массив из 5 объектов.

[
  {{
    "title": "...",
    "author": "...",
    "genre": "...",
    "why": "почему эта книга подойдёт"
  }}
]
"""
            }
        ]
    }

    r = requests.post(
        YANDEX_URL,
        headers={
            "Authorization": f"Api-Key {api_key}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=60
    )
    r.raise_for_status()

    text = (
        r.json()
        .get("result", {})
        .get("alternatives", [{}])[0]
        .get("message", {})
        .get("text", "")
        .strip()
    )

    try:
        data = json.loads(text)
        assert isinstance(data, list)
        assert len(data) == 5
        return data
    except Exception:
        raise ValueError(f"GPT returned invalid JSON:\n{text}")