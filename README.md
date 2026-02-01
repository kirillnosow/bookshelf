# Bookshelf (Flask + Google Sheets)

Это Python-версия приложения **Bookshelf**, которая хранит данные в **Google Sheets** и синхронизируется через Flask API.

## Требования
- Python 3.10+
- Service Account JSON файл **credetionals.json** (лежит рядом с `app.py`)
- Таблица Google Sheets (ID по умолчанию уже вшит)

## Настройка доступа
1. Откройте `credetionals.json` и найдите `client_email`.
2. В Google Sheets нажмите **Поделиться** и добавьте этот email с правами **Редактор**.

## Запуск
```bash
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# при необходимости можно задать порт:
# export PORT=8000
python app.py
```

Откройте: http://127.0.0.1:5000 (или другой порт)

## Переменные окружения (опционально)
- `BOOKSHELF_SHEET_ID` — ID таблицы
- `GOOGLE_APPLICATION_CREDENTIALS` — путь до service account json
- `PORT` — порт Flask
