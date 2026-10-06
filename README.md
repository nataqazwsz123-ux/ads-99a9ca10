# Дашборд рекламы ZENET

`index.html` читает `data/meta.json` и `data/google.json`. Workflow `.github/workflows/update.yml`
каждый час (в :25 по UTC) обновляет оба файла и коммитит их, если что-то изменилось.

| Где | Что |
| --- | --- |
| Secret `META_TOKEN` | системный токен Meta с `ads_read` на кабинеты DE, BG, PL |
| Secret `GOOGLE_SHEET_CSV_URL` | ссылка на лист `data`, опубликованный как CSV |
| Variable `META_OWNER_USER_ID` | Facebook user id, по которому отмечаются «кампании Натальи» |
| Secret `META_APP_SECRET` | необязательно, если в приложении Meta включено «Require App Secret» |

- `scripts/meta.mjs` собирает Meta Ads (только чтение) с 1 числа месяца по сегодня (Киев).
  Если сбор упал, `data/meta.json` остаётся прежним, а запуск помечается красным.
- `scripts/google_csv_to_json.py <in.csv> <out.json>` превращает выгрузку Google Ads в `data/google.json`.
- `data/creators.json` — кэш «кто создал кампанию», чтобы не опрашивать журнал действий каждый час.
  Если `META_OWNER_USER_ID` не задан, «свои» кампании определяются по имени из прошлого среза.

Ручной запуск: Actions → «Обновление данных» → Run workflow.
