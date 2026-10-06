#!/usr/bin/env python3
"""CSV выгрузки Google Ads (лист data) -> data/google.json для дашборда.

Использование: python3 scripts/google_csv_to_json.py <in.csv> <out.json>

Колонки CSV: date, customer_id, account, currency, campaign_id, campaign, status,
channel, daily_budget, cost, impressions, clicks, conversions, conv_value, updated_at.
Дробные числа могут быть с запятой (таблица в русской локали).
При любой ошибке выходной файл не трогаем и выходим с кодом 1.
"""
import csv
import io
import json
import os
import sys

REQUIRED = ["date", "customer_id", "account", "currency", "campaign_id", "campaign", "status",
            "channel", "daily_budget", "cost", "impressions", "clicks", "conversions", "conv_value",
            "updated_at"]


def fail(msg):
    print("google_csv_to_json: " + msg, file=sys.stderr)
    sys.exit(1)


def num(v):
    """'39,203345' / '1 234,5' / '1,234.5' / '' -> float."""
    s = str(v or "").strip().replace(" ", "").replace(" ", "").replace(" ", "")
    if not s:
        return 0.0
    if "," in s and "." in s:
        # десятичный разделитель тот, что стоит последним
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        return float(s)
    except ValueError:
        fail("не число: %r" % v)


def r2(x):
    x = round(x + 0.0, 2)
    return int(x) if x == int(x) else x


def main():
    if len(sys.argv) != 3:
        fail("использование: google_csv_to_json.py <in.csv> <out.json>")
    src, dst = sys.argv[1], sys.argv[2]
    with open(src, encoding="utf-8-sig", newline="") as f:
        text = f.read()
    if text.lstrip().startswith("<"):
        fail("вместо CSV пришёл HTML: таблица не опубликована или ссылка неверная")
    rows = list(csv.DictReader(io.StringIO(text)))
    head = [h.strip() for h in (rows[0].keys() if rows else [])]
    missing = [c for c in REQUIRED if c not in head]
    if missing:
        fail("в CSV нет колонок: " + ", ".join(missing))
    rows = [{k.strip(): (v or "").strip() for k, v in r.items() if k} for r in rows]
    rows = [r for r in rows if r["date"] and r["campaign_id"]]
    if not rows:
        fail("в CSV нет строк с данными")

    accounts, camps, cd, daily = {}, {}, {}, {}
    for r in rows:
        d, a, c = r["date"][:10], r["customer_id"], r["campaign_id"]
        m = {"s": num(r["cost"]), "i": num(r["impressions"]), "cl": num(r["clicks"]),
             "cv": num(r["conversions"]), "pv": num(r["conv_value"])}

        acc = accounts.setdefault(a, {"id": a, "name": r["account"], "cur": r["currency"] or "EUR",
                                      "updatedAt": ""})
        acc["updatedAt"] = max(acc["updatedAt"], r["updated_at"])

        cp = camps.setdefault(c, {"a": a, "id": c, "n": r["campaign"], "ch": "", "st": "", "b": 0,
                                  "s": 0, "i": 0, "cl": 0, "cv": 0, "pv": 0, "_d": ""})
        if d >= cp["_d"]:  # название, статус, канал и бюджет берём из последнего дня
            cp.update({"_d": d, "n": r["campaign"], "ch": r["channel"], "st": r["status"],
                       "b": num(r["daily_budget"])})
        for k, v in m.items():
            cp[k] += v

        day = cd.setdefault((c, d), {"c": c, "d": d, "s": 0, "i": 0, "cl": 0, "cv": 0, "pv": 0})
        ad = daily.setdefault((a, d), {"a": a, "d": d, "s": 0, "i": 0, "cl": 0, "cv": 0, "pv": 0})
        for k, v in m.items():
            day[k] += v
            ad[k] += v

    def clean(o):
        out = {}
        for k, v in o.items():
            if k.startswith("_"):
                continue
            if k in ("i", "cl"):
                v = int(round(v))
            elif isinstance(v, float):
                v = r2(v)
            out[k] = v
        return out

    dates = sorted({r["date"][:10] for r in rows})
    data = {
        "since": dates[0],
        "until": dates[-1],
        "updatedAt": max(a["updatedAt"] for a in accounts.values()),
        "accounts": list(accounts.values()),
        "camps": sorted((clean(c) for c in camps.values()), key=lambda c: -c["s"]),
        "cd": sorted((clean(x) for x in cd.values()), key=lambda x: (x["c"], x["d"])),
        "daily": sorted((clean(x) for x in daily.values()), key=lambda x: (x["a"], x["d"])),
    }

    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    tmp = dst + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, dst)
    print("google.json: %d кампаний, %d строк, %s – %s, выгрузка %s"
          % (len(data["camps"]), len(rows), data["since"], data["until"], data["updatedAt"]))


if __name__ == "__main__":
    main()
