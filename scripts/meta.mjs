// Сбор Meta Ads -> data/meta.json (Node 20+, без зависимостей, только чтение).
//
// Окружение:
//   META_TOKEN            системный токен с ads_read на три кабинета (секрет)
//   META_OWNER_USER_ID    Facebook user id, с которого Наталья работает в Ads Manager
//   META_APP_SECRET       необязательно: если в приложении включено «Require App Secret»
//
// Период: с 1 числа текущего месяца по сегодня (Europe/Kyiv).
// Если что-то упало, data/meta.json не трогаем и выходим с кодом 1.

import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";

const API = (process.env.META_API_BASE || "https://graph.facebook.com/v21.0").replace(/\/+$/, "");
const TOKEN = (process.env.META_TOKEN || "").trim();
const APP_SECRET = (process.env.META_APP_SECRET || "").trim();
const OWNER_ID = (process.env.META_OWNER_USER_ID || "").trim();
const OUT = "data/meta.json";
const CREATORS = "data/creators.json";
const OWNER = "Наталья";
const TZ = "Europe/Kyiv";
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = +process.env.META_BACKOFF_MS || 15000;

const ACCOUNTS = [
  { id: "1023392928968862", code: "DE", name: "Zenet GmbH", cur: "EUR" },
  { id: "1519586981924317", code: "BG", name: "Zenet BG", cur: "EUR" },
  { id: "551750444395948", code: "PL", name: "Zenet PL 2", cur: "PLN" },
];

// Типы действий: берём первый найденный по порядку, без суммирования.
const ACT = {
  lpv: ["landing_page_view", "omni_landing_page_view"],
  atc: ["omni_add_to_cart", "add_to_cart", "offsite_conversion.fb_pixel_add_to_cart", "onsite_web_add_to_cart"],
  ic: ["omni_initiated_checkout", "initiate_checkout", "offsite_conversion.fb_pixel_initiate_checkout", "onsite_web_initiate_checkout"],
  pu: ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"],
  ld: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "onsite_web_lead"],
};
// Цели ODAX приводим к коротким кодам, которые понимает дашборд.
const OBJ = {
  OUTCOME_TRAFFIC: "LINK_CLICKS", OUTCOME_SALES: "SALES", OUTCOME_LEADS: "LEADS",
  OUTCOME_ENGAGEMENT: "ENGAGEMENT", OUTCOME_AWARENESS: "AWARENESS", OUTCOME_APP_PROMOTION: "APP_PROMOTION",
  CONVERSIONS: "SALES", PRODUCT_CATALOG_SALES: "SALES", LEAD_GENERATION: "LEADS",
  REACH: "AWARENESS", BRAND_AWARENESS: "AWARENESS", POST_ENGAGEMENT: "ENGAGEMENT",
};
// Валюты без копеек: бюджет в API приходит не в центах.
const NO_CENTS = new Set(["CLP", "COP", "CRC", "HUF", "IDR", "ISK", "JPY", "KRW", "PYG", "TWD", "VND"]);
// Ошибки, после которых имеет смысл подождать и повторить (лимиты, временные сбои).
const RETRY_CODES = new Set([1, 2, 4, 17, 32, 341, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round((+x || 0) * 100) / 100;
const redact = (s) => String(s).replace(/(access_token|appsecret_proof)=[^&\s"']+/g, "$1=***");
const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
const kyivDate = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const parseTime = (s) => Date.parse(String(s || "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));

const until = kyivDate(new Date());
const since = until.slice(0, 8) + "01";
const proof = APP_SECRET ? createHmac("sha256", APP_SECRET).update(TOKEN).digest("hex") : "";

/* ---------- HTTP ---------- */
class ApiError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

function apiUrl(path, params = {}) {
  const u = new URL(/^https?:/.test(path) ? path : API + "/" + path.replace(/^\/+/, ""));
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
  return u;
}

// Сколько ждать по заголовкам лимитов Meta (минуты до снятия ограничения), если они есть.
function waitHint(res) {
  if (!res) return null;
  let mins = 0;
  for (const h of ["x-business-use-case-usage", "x-ad-account-usage", "x-app-usage"]) {
    try {
      const j = JSON.parse(res.headers.get(h) || "null");
      const walk = (o) => {
        if (!o || typeof o !== "object") return;
        if (+o.estimated_time_to_regain_access > mins) mins = +o.estimated_time_to_regain_access;
        if (+o.reset_time_duration > mins * 60) mins = +o.reset_time_duration / 60;
        Object.values(o).forEach(walk);
      };
      walk(j);
    } catch { /* заголовок не JSON — игнорируем */ }
  }
  return mins > 0 ? mins * 60000 : null;
}

async function call(u) {
  u = new URL(u);
  u.searchParams.set("access_token", TOKEN);
  if (proof) u.searchParams.set("appsecret_proof", proof);
  const label = u.pathname.replace(/^\/v[\d.]+/, "") || "/";
  for (let attempt = 1; ; attempt++) {
    let res = null, body = null, netErr = null;
    try {
      res = await fetch(u, { signal: AbortSignal.timeout(120000) });
      body = await res.json().catch(() => null);
    } catch (e) {
      netErr = e;
    }
    if (res && res.ok && body && !body.error) return body;
    const e = body && body.error;
    const msg = e ? `#${e.code}${e.error_subcode ? "/" + e.error_subcode : ""} ${e.message}`
      : netErr ? String(netErr.message || netErr) : `HTTP ${res.status}`;
    const transient = !!netErr || !res || res.status >= 500 || res.status === 429 || !!(e && (e.is_transient || RETRY_CODES.has(e.code)));
    if (e && e.code === 190) throw new ApiError(`${label}: токен недействителен или отозван (${redact(msg)})`, 190);
    if (!transient || attempt >= MAX_ATTEMPTS) throw new ApiError(`${label}: ${redact(msg)}`, e && e.code);
    const throttled = (res && res.status === 429) || !!(e && ([4, 17, 32, 613].includes(e.code) || e.code >= 80000));
    const wait = Math.min((throttled && waitHint(res)) || BACKOFF_MS * 2 ** (attempt - 1), 5 * 60000);
    console.warn(`${label}: ${redact(msg)} — повтор через ${Math.round(wait / 1000)} с (${attempt}/${MAX_ATTEMPTS - 1})`);
    await sleep(wait);
  }
}

// Все страницы списка (paging.next).
async function all(path, params) {
  const out = [];
  let u = apiUrl(path, { limit: 500, ...params });
  for (let page = 1; u; page++) {
    if (page > 500) throw new Error(`${path}: слишком много страниц`);
    const body = await call(u);
    out.push(...(body.data || []));
    u = body.paging && body.paging.next ? new URL(body.paging.next) : null;
  }
  return out;
}

// Объекты по id пачками по 50; если какой-то id недоступен, добираем по одному.
async function byIds(ids, fields) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    try {
      Object.assign(out, await call(apiUrl("", { ids: part.join(","), fields })));
    } catch (e) {
      if (e.code !== 100) throw e;
      for (const id of part) {
        try { out[id] = await call(apiUrl(id, { fields })); } catch (e2) { if (e2.code !== 100) throw e2; }
      }
    }
  }
  return out;
}

/* ---------- метрики ---------- */
function pick(list, types) {
  for (const t of types) {
    const a = (list || []).find((x) => x.action_type === t);
    if (a) return +a.value || 0;
  }
  return 0;
}
function metrics(row, keys) {
  const m = {
    s: r2(row.spend), i: +row.impressions || 0, r: +row.reach || 0, cl: +row.inline_link_clicks || 0,
    lpv: pick(row.actions, ACT.lpv), atc: pick(row.actions, ACT.atc), ic: pick(row.actions, ACT.ic),
    pu: pick(row.actions, ACT.pu), pv: r2(pick(row.action_values, ACT.pu)), ld: pick(row.actions, ACT.ld),
  };
  const o = {};
  for (const k of keys) o[k] = m[k];
  return o;
}
// Убираем нулевые и пустые поля.
function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === 0 || o[k] === "" || o[k] == null || o[k] === false) delete o[k];
  return o;
}

const ALL = ["s", "i", "r", "cl", "lpv", "atc", "ic", "pu", "pv", "ld"];
const DAY = ["s", "i", "cl", "atc", "pu", "pv", "ld"];
const BASE = "spend,impressions,inline_link_clicks,actions,action_values";
const insights = (acc, level, fields, extra = {}) =>
  all(`act_${acc.id}/insights`, { level, fields, time_range: { since, until }, ...extra });

/* ---------- кто создал кампанию ---------- */
async function readJSON(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

async function findCreator(acc, camp) {
  const t = Math.floor(parseTime(camp.created_time) / 1000);
  if (!t) return null;
  const ev = await all(`act_${acc.id}/activities`, {
    fields: "event_type,event_time,actor_id,actor_name,object_id",
    since: String(t - 900), until: String(t + 900),
  });
  const hit = ev.find((e) => e.event_type === "create_campaign_group" && String(e.object_id) === String(camp.id));
  return hit ? { id: String(hit.actor_id), name: hit.actor_name || "" } : null;
}

/* ---------- сбор ---------- */
async function main() {
  if (!TOKEN) throw new Error("META_TOKEN не задан");
  const prev = (await readJSON(OUT)) || {};
  // Без META_OWNER_USER_ID «свои» кампании ищем по имени из прошлого среза.
  const ownerName0 = OWNER_ID ? "" : prev.me || "";
  const ownerKey = OWNER_ID ? "id:" + sha(OWNER_ID) : "name:" + sha(ownerName0);
  let cache = await readJSON(CREATORS);
  if (!cache || cache.owner !== ownerKey) cache = { v: 1, owner: ownerKey, c: {} };
  if (!OWNER_ID) console.log(`::warning::META_OWNER_USER_ID не задан: «свои» кампании определяются по имени «${ownerName0 || "?"}»`);

  const campaigns = [], ads = [], cdaily = [], daily = [];
  let ownerName = "", ownerIdSeen = "", creatorErrors = 0, activitiesDown = false;

  for (const acc of ACCOUNTS) {
    const cIns = await insights(acc, "campaign", "campaign_id,campaign_name,reach," + BASE);
    const cDay = await insights(acc, "campaign", "campaign_id," + BASE, { time_increment: 1 });
    const aDay = await insights(acc, "account", "reach," + BASE, { time_increment: 1 });
    const adIns = await insights(acc, "ad", "ad_id,ad_name,adset_name,campaign_id,reach," + BASE);

    const cids = [...new Set(cIns.map((r) => r.campaign_id))];
    const info = await byIds(cids, "name,objective,effective_status,created_time,daily_budget,lifetime_budget");
    const adSt = await byIds([...new Set(adIns.map((r) => r.ad_id))], "effective_status");
    const cents = NO_CENTS.has(acc.cur) ? 1 : 100;

    const accCamps = [];
    for (const row of cIns) {
      const ci = info[row.campaign_id] || {};
      const id = String(row.campaign_id);
      let cr = cache.c[id];
      const created = parseTime(ci.created_time);
      const fresh = created && Date.now() - created < 2 * 864e5; // журнал действий может запаздывать
      if (activitiesDown) {
        if (!cr) { creatorErrors++; const old = (prev.campaigns || []).find((c) => c.id === id); cr = old ? { by: old.by, me: old.me } : null; }
      } else if (ci.created_time && (!cr || (!cr.by && fresh))) {
        try {
          const who = await findCreator(acc, { id, created_time: ci.created_time });
          const me = !!who && (OWNER_ID ? who.id === OWNER_ID : !!ownerName0 && who.name === ownerName0);
          if (me) ownerIdSeen = who.id;
          cr = cache.c[id] = who ? { by: who.name, me, t: new Date().toISOString() } : { t: new Date().toISOString() };
        } catch (e) {
          if (e.code === 190) throw e;
          creatorErrors++;
          activitiesDown = true; // не долбим журнал дальше в этом запуске
          console.warn(`activities ${acc.code}/${id}: ${e.message}`);
          const old = (prev.campaigns || []).find((c) => c.id === id);
          cr = old ? { by: old.by, me: old.me } : null; // временно берём из прошлого среза, в кэш не пишем
        }
      }
      if (cr && cr.me && cr.by) ownerName = cr.by;
      accCamps.push(clean({
        a: acc.code, id, n: ci.name || row.campaign_name, st: ci.effective_status,
        o: OBJ[ci.objective] || ci.objective, c: (ci.created_time || "").slice(0, 10),
        by: cr && cr.by, me: !!(cr && cr.me),
        db: ci.daily_budget ? r2(ci.daily_budget / cents) : 0,
        lb: ci.lifetime_budget ? r2(ci.lifetime_budget / cents) : 0,
        ...metrics(row, ALL),
      }));
    }
    accCamps.sort((x, y) => (y.c || "").localeCompare(x.c || "") || (y.s || 0) - (x.s || 0));
    campaigns.push(...accCamps);

    for (const row of adIns) {
      ads.push(clean({
        cid: String(row.campaign_id), n: row.ad_name, as: row.adset_name,
        st: (adSt[row.ad_id] || {}).effective_status, ...metrics(row, ALL),
      }));
    }
    for (const row of cDay) cdaily.push(clean({ cid: String(row.campaign_id), d: row.date_start, ...metrics(row, DAY) }));
    for (const row of aDay) daily.push(clean({ a: acc.code, d: row.date_start, ...metrics(row, ALL) }));
    console.log(`${acc.code}: кампаний ${accCamps.length}, объявлений ${adIns.length}, строк по дням ${cDay.length}`);
  }

  if (creatorErrors) console.log(`::warning::Журнал действий недоступен для ${creatorErrors} кампаний — автор взят из прошлого среза`);
  if (!OWNER_ID && ownerIdSeen) console.log(`::notice::Id пользователя «${ownerName0}»: ${ownerIdSeen} — сохраните его в переменной META_OWNER_USER_ID`);

  const data = {
    v: 2, updatedAt: new Date().toISOString(), since, until,
    me: ownerName || ownerName0 || prev.me || "", owner: OWNER,
    accounts: ACCOUNTS, campaigns, ads, cdaily, daily,
  };
  await writeFile(OUT + ".tmp", JSON.stringify(data));
  await writeFile(CREATORS + ".tmp", JSON.stringify(cache));
  await rename(OUT + ".tmp", OUT);
  await rename(CREATORS + ".tmp", CREATORS);
  console.log(`meta.json: ${since} – ${until}, кампаний ${campaigns.length}, объявлений ${ads.length}`);
}

main().catch((e) => {
  console.log(`::error::Сбор Meta упал, data/meta.json не изменён: ${redact(e.message || e)}`);
  process.exit(1);
});
