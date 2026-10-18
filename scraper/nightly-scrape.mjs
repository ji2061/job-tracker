#!/usr/bin/env node
/**
 * Job scrape + INSTANT WhatsApp alerts for Jarri's Job Triage (KT1 3HZ · 16+ · bus-only).
 *
 * Runs on GitHub Actions (free) EVERY 30 MINUTES. Each run:
 *   1. Reads your WhatsApp replies (APPLIED / NO THANKS) and stops reminding
 *      you about those jobs.
 *   2. Searches Reed + Adzuna APIs (if keys set) + rotates 4 of the 12
 *      google-style DuckDuckGo dork searches (full 12-dork sweep every 6h,
 *      keyless, free).
 *   3. Any job not seen before -> INSTANT WhatsApp message with:
 *      JOB NAME (caps), pay, distance from KT1 3HZ, live bus-route link,
 *      what you'd do, cover-letter guidance, and the apply link.
 *   4. Jobs you haven't answered get one reminder per day (up to 7) until
 *      you reply APPLIED or NO THANKS.
 *   5. Rewrites jobs-data.json (site updates automatically) and
 *      jobs-state.json (memory of what you answered).
 *
 * Data sources - all free for jobseekers:
 *   1. Reed  API   -> secret REED_API_KEY   (get: reed.co.uk/jobseeker -> API)
 *   2. Adzuna API  -> secrets ADZUNA_APP_ID + ADZUNA_APP_KEY
 *                     (get: developer.adzuna.com -> free account)
 *   3. Web dorks   -> DuckDuckGo (lite endpoint), NO key needed, 12 searches
 *                     across Indeed, Totaljobs, CV-Library, Glassdoor, gov.uk
 *                     Find a Job, plus any local employer page it can find.
 *   (Google's own Custom Search API stopped accepting new users in 2026,
 *    and Indeed/LinkedIn block direct scraping - the dork layer via
 *    DuckDuckGo is the free, no-signup way to reach those listings.)
 *
 * Phone alerts (all optional, all free):
 *   - WhatsApp -> Green API free Developer plan (secrets WHATSAPP_GREEN_*
 *     + WHATSAPP_PHONE). $0/month, 3 chats max (we use 1: your own chat).
 *     Sending is unlimited; receiving your replies is unlimited too.
 *   - CallMeBot fallback (secrets WHATSAPP_PHONE + WHATSAPP_API_KEY) —
 *     sends alerts but CANNOT read replies (no reminders-stop feature).
 *   - Telegram -> secrets TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (bulletproof).
 *
 * With NO keys set, the script still runs: the dork layer works keyless,
 * and jobs-data.json is rewritten so the site keeps working.
 *
 * Radius: every result is filtered to a 5-mile bus radius of KT1 3HZ.
 * Zero npm dependencies. Node 18+.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "jobs-data.json");
const STATE_FILE = join(ROOT, "jobs-state.json");

const LOCATION = "Kingston upon Thames";
const MAX_PER_SOURCE = 15;
const KEEP_TOP = 12;

// 5-mile bus radius around KT1 3HZ (Kingston town centre)
const RADIUS_MILES = 5;
const RADIUS_KM = 8.05;

// --- WhatsApp instant alert tuning ---
const DORKS_PER_RUN = 4; // rotate dorks so every 30-min run stays polite to DDG
const MAX_NEW_ALERTS_PER_RUN = 5; // never flood: at most 5 fresh job messages per run
const MAX_REMINDERS_PER_RUN = 3;
const MAX_REMINDERS_PER_JOB = 7; // nag max 7 days then give up
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // one reminder per day
const ALERT_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000; // stop caring after 10 days

const REED_API_KEY = process.env.REED_API_KEY || "";
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || "";
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || "";
// Free phone alerts (optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// WhatsApp: WHATSAPP_PHONE = your number with country code, digits only,
// e.g. 447712345678. Green API path: WHATSAPP_GREEN_INSTANCE_ID +
// WHATSAPP_GREEN_TOKEN from the green-api.com console (free Developer plan).
// CallMeBot path: WHATSAPP_API_KEY = key the CallMeBot texts you.
const WHATSAPP_PHONE = (process.env.WHATSAPP_PHONE || "").replace(/\D/g, "");
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || "";
const WHATSAPP_GREEN_INSTANCE_ID = process.env.WHATSAPP_GREEN_INSTANCE_ID || "";
const WHATSAPP_GREEN_TOKEN = process.env.WHATSAPP_GREEN_TOKEN || "";

const GREEN_READY = !!(WHATSAPP_GREEN_INSTANCE_ID && WHATSAPP_GREEN_TOKEN && WHATSAPP_PHONE);
const CALLME_READY = !!(WHATSAPP_PHONE && WHATSAPP_API_KEY);

// ---------- helpers ----------

async function fetchWithTimeout(url, opts = {}, ms = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&pound;/g, "£")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Age gate: anything clearly 18+ never reaches the site.
function isEighteenPlus(text) {
  return /(\b18\+\b|\bover 18\b|\baged? 18\b|\bminimum age\b[^.]{0,20}\b18\b|\bno under 18s?\b|\bmust be 18\b)/i.test(
    text
  );
}

// Titles that are effectively 18+ or vehicle-dependent.
function isExcludedTitle(title) {
  return /\b(driver|forklift|scaffolder|labourer|security guard|warehouse operative|mcld|chef de partie)\b/i.test(
    title
  );
}

function scoreJob(title, summary, url = "") {
  const text = `${title} ${summary}`.toLowerCase();
  let s = 50;
  if (/christmas|festive|seasonal/.test(text)) s += 15;
  if (/\b16\b|school leaver|no experience/.test(text)) s += 10;
  if (/part.?time|weekend/.test(text)) s += 6;
  if (/saturday/.test(text)) s += 2;
  if (/temporary|fixed.?term/.test(text)) s += 2;
  if (/\b18\+\b/.test(text)) s -= 25;
  if (
    /(jobs available|openings in|updated daily|-jobs\.html|\/jobs\/[a-z-]+\/in-)/.test(
      `${title} ${url}`.toLowerCase()
    ) &&
    /(indeed|totaljobs|cv-library|glassdoor|jooble|ziprecruiter|reed\.co\.uk)/.test(url)
  )
    s -= 10;
  return s;
}

function dedupe(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = `${j.company}|${j.title}`.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------- distance + bus helpers ----------

// Approx straight-line miles from KT1 3HZ. Display only — the maps link
// gives the real journey. First match wins, so longer names come first.
const TOWN_MILES = [
  ["kingston upon thames", 0],
  ["kingston town centre", 0],
  ["kingston", 0.5],
  ["norbiton", 1],
  ["berrylands", 1.5],
  ["hampton wick", 1.5],
  ["surbiton", 1.5],
  ["tolworth", 2],
  ["long ditton", 2.5],
  ["kingston vale", 2.5],
  ["thames ditton", 3],
  ["new malden", 3],
  ["old malden", 3],
  ["hook", 3],
  ["hinchley wood", 3.5],
  ["teddington", 3.5],
  ["chessington", 4],
  ["weston green", 4],
  ["claygate", 4.5],
  ["esher", 4.5],
  ["worcester park", 4.5],
  ["malden rushett", 4.5],
  ["east molesey", 5],
  ["west molesey", 5],
  ["hampton", 5],
];

function areaFor(text) {
  const t = String(text || "").toLowerCase();
  for (const [town, miles] of TOWN_MILES) {
    // short town names (hook, esher) need word boundaries so "shook" or
    // "leatherhead" never match; longer names are safe with includes()
    const hit =
      town.length <= 5
        ? new RegExp(`\\b${town}\\b`, "i").test(t)
        : t.includes(town);
    if (hit) {
      return { town: town.replace(/\b\w/g, (c) => c.toUpperCase()), miles };
    }
  }
  return null;
}

export function distanceFor(job) {
  const hit = areaFor(`${job.location || ""} ${job.title || ""} ${job.company || ""}`);
  if (!hit) return "in your 5-mile bus area";
  if (hit.miles === 0) return "0 miles — Kingston town centre, you can walk it";
  return `~${hit.miles} mile${hit.miles === 1 ? "" : "s"} away — ${hit.town}`;
}

export function busLinkFor(job) {
  const hit = areaFor(`${job.location || ""} ${job.title || ""} ${job.company || ""}`);
  const dest = hit ? hit.town : "Kingston upon Thames";
  return (
    `https://www.google.com/maps/dir/?api=1` +
    `&origin=${encodeURIComponent("KT1 3HZ, Kingston upon Thames")}` +
    `&destination=${encodeURIComponent(dest + ", London")}` +
    `&mode=transit&travelmode=transit`
  );
}

// ---------- sources ----------

async function scrapeReed() {
  if (!REED_API_KEY) return [];
  const auth = Buffer.from(`${REED_API_KEY}:`).toString("base64");
  const keywords = ["christmas", "seasonal"];
  const all = [];
  for (const kw of keywords) {
    const url =
      `https://www.reed.co.uk/api/1.0/search?keywords=${encodeURIComponent(kw)}` +
      `&locationName=${encodeURIComponent(LOCATION)}&distanceFromLocation=${RADIUS_MILES}` +
      `&resultsToTake=${MAX_PER_SOURCE}`;
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (!res.ok) {
        console.error(`Reed ${kw}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const j of data.results || []) {
        const summary = stripHtml(j.jobDescription || "").slice(0, 600);
        const title = j.jobTitle || "Untitled role";
        if (isEighteenPlus(`${title} ${summary}`)) continue;
        if (isExcludedTitle(title)) continue;
        all.push({
          id: `reed-${j.jobId}`,
          title,
          company: j.employerName || "Reed listing",
          location: j.locationName || LOCATION,
          summary,
          url: j.jobUrl,
          pay:
            j.minimumSalary && j.maximumSalary
              ? `£${j.minimumSalary}–£${j.maximumSalary}`
              : "See listing",
          posted: j.date ? String(j.date).slice(0, 10) : undefined,
          source: "reed.co.uk",
        });
      }
    } catch (e) {
      console.error(`Reed ${kw} failed:`, e.message);
    }
  }
  return all;
}

async function scrapeAdzuna() {
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) return [];
  const url =
    `https://api.adzuna.com/v1/api/jobs/gb/search/1?app_id=${encodeURIComponent(ADZUNA_APP_ID)}` +
    `&app_key=${encodeURIComponent(ADZUNA_APP_KEY)}&results_per_page=${MAX_PER_SOURCE}` +
    `&what=${encodeURIComponent("christmas seasonal")}&where=${encodeURIComponent(LOCATION)}` +
    `&distance=${Math.round(RADIUS_KM)}` +
    `&max_days_old=21&sort_by=date`;
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      console.error(`Adzuna: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const all = [];
    for (const j of data.results || []) {
      const summary = stripHtml(j.description || "").slice(0, 600);
      const title = j.title || "Untitled role";
      if (isEighteenPlus(`${title} ${summary}`)) continue;
      if (isExcludedTitle(title)) continue;
      all.push({
        id: `adzuna-${j.id}`,
        title,
        company: (j.company && j.company.display_name) || "Adzuna listing",
        location: j.location && j.location.display_name ? j.location.display_name : LOCATION,
        summary,
        url: j.redirect_url,
        pay: j.salary_min && j.salary_max ? `£${Math.round(j.salary_min)}–£${Math.round(j.salary_max)}` : "See listing",
        posted: j.created ? String(j.created).slice(0, 10) : undefined,
        source: "adzuna.co.uk",
      });
    }
    return all;
  } catch (e) {
    console.error("Adzuna failed:", e.message);
    return [];
  }
}

// ---------- web dorks (DuckDuckGo lite, NO key needed) ----------

const DORKS = [
  "christmas temp jobs kingston upon thames",
  "weekend part time jobs kingston upon thames 16 year old",
  "site:uk.indeed.com christmas jobs kingston upon thames",
  "site:totaljobs.com christmas jobs kingston",
  "site:cv-library.co.uk seasonal jobs kingston upon thames",
  "site:findajob.dwp.gov.uk kingston upon thames",
  "site:glassdoor.co.uk christmas kingston upon thames",
  "retail christmas jobs surbiton OR tolworth",
  "shop assistant weekend jobs surbiton OR \"new malden\"",
  "christmas jobs esher OR \"thames ditton\" OR \"hampton wick\"",
  "seasonal vacancies \"worcester park\" OR chessington",
  "santa grotto christmas market jobs kingston upon thames",
];

const AREA_RE =
  /(kingston upon thames|kingston upon|\bkingston\b|surbiton|tolworth|new malden|old malden|norbiton|berrylands|chessington|worcester park|thames ditton|long ditton|hinchley wood|claygate|esher|weston green|east molesey|west molesey|hampton wick|teddington|\bhampton\b|malden rushett|richmond|twickenham|\bkt[1-9]\b)/i;
const NOT_AREA_RE = /(ontario|\bcanada\b|upon hull|\bhull\b|jamaica|\bmilitary kilington\b|\bdevon\b|\bdorset\b|\bsomerset\b|\bnorfolk\b|\bsuffolk\b|\bkent\b|\byorkshire\b)/i;
const JUNK_URL_RE =
  /(facebook\.com|instagram\.com|tiktok\.com|youtube\.com|twitter\.com|x\.com|reddit\.com|quora\.com|linkedin\.com|pinterest|tripadvisor|amazon\.co\.uk|\.pdf($|\?))/i;
const JOBISH_RE = /(job|jobs|vacanc|career|hiring|recruit|seasonal|christmas|temp|staff)/i;

// Every 30 minutes we run a rotating batch of 4 dorks (polite to DDG);
// every 6 hours we do the full 12-dork sweep.
function pickDorks() {
  const hour = new Date().getUTCHours();
  if (hour % 6 === 0) return DORKS.slice();
  const batches = Math.ceil(DORKS.length / DORKS_PER_RUN);
  const batch = Math.floor(Date.now() / (30 * 60 * 1000)) % batches;
  return DORKS.slice(batch * DORKS_PER_RUN, batch * DORKS_PER_RUN + DORKS_PER_RUN);
}

function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function parseDdgLite(html) {
  const results = [];
  const linkRe =
    /<a[^>]+href="([^"]*uddg=[^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g;
  const snippets = [];
  const snipRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = snipRe.exec(html))) snippets.push(stripHtml(m[1]));
  let i = 0;
  while ((m = linkRe.exec(html))) {
    let dest = "";
    try {
      const q = m[1].split("uddg=")[1];
      dest = decodeURIComponent((q || "").split("&")[0]);
    } catch {
      dest = "";
    }
    const title = stripHtml(m[2]);
    if (dest && title) results.push({ url: dest, title, snippet: snippets[i] || "" });
    i++;
  }
  return results;
}

async function scrapeWebDorks(dorks) {
  const out = [];
  for (const dork of dorks || DORKS) {
    try {
      const res = await fetchWithTimeout(
        `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(dork)}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
            "Accept-Language": "en-GB,en;q=0.9",
          },
        },
        20000
      );
      if (!res.ok) {
        console.error(`Dork "${dork.slice(0, 30)}...": HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      for (const r of parseDdgLite(html)) {
        const hay = `${r.title} ${r.url}`;
        if (!/^https?:\/\//i.test(r.url)) continue;
        if (JUNK_URL_RE.test(r.url)) continue;
        if (!AREA_RE.test(hay) || NOT_AREA_RE.test(hay)) continue;
        if (!JOBISH_RE.test(hay)) continue;
        if (isEighteenPlus(hay)) continue;
        const title = r.title.slice(0, 140);
        let domain = "web";
        try {
          domain = new URL(r.url).hostname.replace(/^www\./, "");
        } catch {
          /* keep fallback */
        }
        out.push({
          id: `web-${djb2Hash(r.url)}`,
          title,
          company: domain,
          location: "Kingston area (web find)",
          summary: (r.snippet || "Found via web search dork — open the link to see the actual listing.").slice(0, 600),
          url: r.url,
          pay: "See listing",
          source: "web dork",
        });
      }
    } catch (e) {
      console.error(`Dork "${dork.slice(0, 30)}..." failed:`, e.message);
    }
    await new Promise((r) => setTimeout(r, 1200)); // be polite to DDG
  }
  return out;
}

// ---------- reply parsing (APPLIED / NO THANKS) ----------

export function parseReply(text = "") {
  const t = String(text).toLowerCase().trim();
  const numMatch = t.match(/#?\b(\d{1,3})\b/);
  const num = numMatch ? parseInt(numMatch[1], 10) : null;
  if (/\bappl/.test(t) || /\bdone\b/.test(t) || /\bsent\b/.test(t))
    return { verb: "applied", num };
  if (/\b(no|no thanks|nope|nah|pass|dont|don'?t|not interested|not for me|skip)\b/.test(t))
    return { verb: "no", num };
  return { verb: null, num };
}

// ---------- state (memory between runs) ----------

function loadState() {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (s && typeof s === "object" && s.jobs && typeof s.jobs === "object") return s;
  } catch {
    /* first ever run */
  }
  return null;
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function markReply(state, verb, num) {
  const list = Object.values(state.jobs).filter((e) => e.status === "sent");
  let entry = null;
  if (num != null) entry = list.find((e) => e.num === num) || null;
  if (!entry && num == null) {
    list.sort((a, b) => (a.lastSent || 0) - (b.lastSent || 0));
    entry = list[0] || null;
  }
  if (!entry) return null;
  entry.status = verb === "applied" ? "applied" : "no";
  entry.answeredAt = Date.now();
  return entry;
}

function pendingNew(state) {
  return Object.values(state.jobs)
    .filter((e) => e.status === "new" && !e.lastSent)
    .sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0));
}

function pendingReminders(state) {
  const now = Date.now();
  return Object.values(state.jobs)
    .filter(
      (e) =>
        e.status === "sent" &&
        now - (e.lastSent || 0) > REMIND_AFTER_MS &&
        now - (e.firstSeen || 0) < ALERT_MAX_AGE_MS &&
        (e.reminders || 0) < MAX_REMINDERS_PER_JOB &&
        now - (e.lastReminded || 0) > REMIND_AFTER_MS
    )
    .sort((a, b) => (a.lastReminded || 0) - (b.lastReminded || 0));
}

// ---------- WhatsApp senders ----------

// Green API gives every instance its own regional host (e.g.
// https://7107.api.greenapi.com). The console shows it, but to keep setup to
// 3 secrets we resolve the host ourselves: try the cluster host derived from
// the first 4 digits of the instance id, then the classic hosts.
let GREEN_BASE = null;
async function greenBaseUrl() {
  if (GREEN_BASE) return GREEN_BASE;
  const candidates = [];
  const m = WHATSAPP_GREEN_INSTANCE_ID.match(/^(\d{4})/);
  if (m) candidates.push(`https://${m[1]}.api.greenapi.com`);
  candidates.push("https://api.green-api.com");
  candidates.push("https://api.greenapi.com");
  for (const base of candidates) {
    try {
      const res = await fetchWithTimeout(`${base}/getSettings/${WHATSAPP_GREEN_TOKEN}`, {}, 15000);
      if (res.ok) {
        GREEN_BASE = base;
        console.log(`Green API host: ${base}`);
        return GREEN_BASE;
      }
    } catch {
      /* try next host */
    }
  }
  GREEN_BASE = "https://api.green-api.com"; // last resort — sends will likely fail
  return GREEN_BASE;
}
function selfChat() {
  return `${WHATSAPP_PHONE}@c.us`;
}

async function waSendGreen(text) {
  try {
    const base = await greenBaseUrl();
    const res = await fetchWithTimeout(
      `${base}/sendMessage/${WHATSAPP_GREEN_TOKEN}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId: selfChat(), message: text }),
      },
      20000
    );
    if (!res.ok) {
      console.warn(`WhatsApp (Green API) send failed: HTTP ${res.status}`);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    if (!data.idMessage) {
      // Green API returns 200 with an error body when e.g. WhatsApp is not
      // linked (QR expired) — treat that as "not sent" so we retry next run.
      console.warn(
        `WhatsApp (Green API) not accepted: ${JSON.stringify(data).slice(0, 200)}`
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`WhatsApp (Green API) skipped: ${e.message}`);
    return false;
  }
}

async function waSendCallMeBot(text) {
  const short = text.slice(0, 900); // CallMeBot has a short message limit
  try {
    const url =
      `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent("+" + WHATSAPP_PHONE)}` +
      `&text=${encodeURIComponent(short)}&apikey=${encodeURIComponent(WHATSAPP_API_KEY)}`;
    const res = await fetchWithTimeout(url, {}, 20000);
    if (!res.ok) {
      console.warn(`WhatsApp (CallMeBot) failed: HTTP ${res.status}`);
      return false;
    }
    console.log("WhatsApp alert sent via CallMeBot.");
    return true;
  } catch (e) {
    console.warn(`WhatsApp (CallMeBot) skipped: ${e.message}`);
    return false;
  }
}

// Read your replies from your own WhatsApp chat ("Message yourself").
// Drains Green API's notification queue so nothing is read twice.
async function readReplies(state) {
  if (!GREEN_READY) return;
  const base = await greenBaseUrl();
  let handled = 0;
  for (let i = 0; i < 30 && handled < 60; i++) {
    let n = null;
    try {
      const res = await fetchWithTimeout(
        `${base}/receiveNotification/${WHATSAPP_GREEN_TOKEN}?receiveTimeout=5`,
        {},
        25000
      );
      const raw = await res.text();
      if (!raw || !raw.trim()) break; // queue empty
      n = JSON.parse(raw);
    } catch (e) {
      console.warn("receiveNotification stopped:", e.message);
      break;
    }
    if (!n || n.receiptId == null) break;
    // Always delete from the queue so we never read the same one twice.
    try {
      await fetchWithTimeout(
        `${base}/deleteNotification/${WHATSAPP_GREEN_TOKEN}/${n.receiptId}`,
        { method: "DELETE" },
        15000
      );
    } catch {
      /* if delete fails we may re-read it next run — parseReply is harmless */
    }
    const body = n.body || {};
    const isSelf = body.senderData && body.senderData.chatId === selfChat();
    // Replies you type on your phone arrive as "outgoingMessageReceived".
    // Messages the robot itself sent via the API are "outgoingApiMessageReceived"
    // — ignore those so it never parses its own messages.
    if (!isSelf || body.typeWebhook !== "outgoingMessageReceived") continue;
    if (body.timestamp && Date.now() / 1000 - body.timestamp > 3 * 86400) continue; // stale
    const md = body.messageData || {};
    const text =
      (md.textMessageData && md.textMessageData.textMessage) ||
      (md.extendedTextMessageData && md.extendedTextMessageData.text) ||
      "";
    if (!text) continue;
    const { verb, num } = parseReply(text);
    if (!verb) continue;
    const marked = markReply(state, verb, num);
    handled++;
    if (marked) {
      console.log(
        `Reply "${text.trim().slice(0, 40)}" -> job #${marked.num} marked ${marked.status}`
      );
    } else {
      console.log(`Reply "${text.trim().slice(0, 40)}" -> no matching unanswered job`);
    }
  }
}

// ---------- message formats ----------

function payLine(job) {
  return job.pay && job.pay !== "See listing" ? job.pay : "check the listing";
}

export function buildJobAlert(job, num) {
  const what = (job.summary || "").replace(/\s+/g, " ").trim();
  const about = what
    ? what.slice(0, 220) + (what.length > 220 ? "…" : "")
    : "Open the listing to see the full description.";
  return [
    `🚨 NEW JOB #${num} 🚨`,
    ``,
    `🔨 JOB: ${String(job.title).toUpperCase()}`,
    `🏪 WHERE: ${job.company || "see listing"}`,
    `💰 PAY: ${payLine(job)}`,
    `📍 DISTANCE: ${distanceFor(job)}`,
    `🚌 BUS FROM YOURS (tap = live route):`,
    busLinkFor(job),
    ``,
    `📋 WHAT YOU'D DO: ${about}`,
    ``,
    `✍️ ${coverLetterFor(job)}`,
    ``,
    `▶️ APPLY NOW:`,
    job.url,
    ``,
    `▬▬▬▬▬▬▬▬▬▬▬▬▬`,
    `Done it? Reply: APPLIED ${num}`,
    `Not for you? Reply: NO THANKS ${num}`,
  ].join("\n");
}

export function buildReminder(job, num) {
  return [
    `⏰ STILL OPEN — JOB #${num}`,
    `🔨 ${String(job.title).toUpperCase()}`,
    `🏪 ${job.company || "see listing"} · 💰 ${payLine(job)}`,
    `▶️ APPLY: ${job.url}`,
    `Stop reminders: reply APPLIED ${num} or NO THANKS ${num}`,
  ].join("\n");
}

function buildWelcome() {
  return [
    `🤖 JOB ROBOT CONNECTED ✅`,
    ``,
    `Every 30 minutes I search christmas + weekend + part-time jobs within 5 bus miles of yours (Reed + Adzuna + 12 google-style searches).`,
    ``,
    `When I find one you get it here INSTANTLY: JOB NAME, PAY, DISTANCE, WHICH BUS, WHAT YOU'D DO + the APPLY LINK.`,
    ``,
    `Reply APPLIED or NO THANKS to any job I send and I stop nagging you about it.`,
    ``,
    `First real job alert should land within a few hours 🎄`,
  ].join("\n");
}

// ---------- Telegram morning digest (unchanged) ----------

const DETAILED_JOBS_IN_ALERT = 7;

function coverLetterFor(job) {
  const src = `${job.url || ""} ${job.source || ""} ${job.company || ""}`.toLowerCase();
  if (
    /(sainsburys|boots\.jobs|\bboots\b|marksandspencer|marks & spencer|royalmail|argos|tesco|currys|superdrug|\basda\b|\baldi\b|\blidl\b|waitrose|\biceland\b)/.test(
      src
    )
  )
    return "Cover letter: big chain — online form only (no email exists). Your site card has a ready-made letter to paste in.";
  if (
    /(indeed|totaljobs|cv-library|glassdoor|reed|adzuna|jooble|simplyhired|ziprecruiter|locatd|findajob|jobsite)/.test(
      src
    )
  )
    return "Cover letter: boards like this take an online form — copy the letter from your site card when asked.";
  return "Cover letter: check the listing — online form = paste the letter from your site card; small shop = walk in with a printed one.";
}

function buildDigest(newJobs, totalCount) {
  const header =
    newJobs.length > 0
      ? `🌅 Morning Jarri — ${newJobs.length} new job match${newJobs.length === 1 ? "" : "es"} (${totalCount} total on your site)`
      : `🌅 Morning Jarri — no new matches today (${totalCount} still live on your site)`;
  const lines = newJobs.slice(0, DETAILED_JOBS_IN_ALERT).map((j, i) => {
    const pay = j.pay && j.pay !== "See listing" ? ` · ${j.pay}` : "";
    const what = (j.summary || "").replace(/\s+/g, " ").trim();
    const about = what
      ? `What it involves: ${what.slice(0, 180)}${what.length > 180 ? "…" : ""}`
      : "";
    return [
      `${i + 1}. ${j.title} — ${j.company}${pay}`,
      about,
      coverLetterFor(j),
      `Apply: ${j.url}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  const tail =
    "\n\nOpen your site for the full cards (blue = auto-found — check age + bus yourself). Never pay to apply.";
  return [header, ...lines, tail].join("\n\n");
}

async function notifyTelegram(newJobs, totalCount) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = buildDigest(newJobs, totalCount).slice(0, 3900);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) console.warn(`Telegram notify failed: HTTP ${res.status}`);
    else console.log("Telegram morning digest sent.");
  } catch (e) {
    console.warn(`Telegram notify skipped: ${e.message}`);
  }
}

// ---------- main ----------

async function main() {
  const now = Date.now();

  // 1) Load the memory file (every job + your APPLIED / NO THANKS answers)
  let state = loadState();
  if (!state) {
    state = { version: 1, counter: 0, welcomeSent: false, jobs: {} };
    // Very first run: don't blast the pre-seeded cards as "new jobs".
    try {
      const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
      for (const j of prev.jobs || []) {
        state.jobs[j.id] = { status: "seen", firstSeen: now, job: j };
      }
    } catch {
      /* no previous data — fine */
    }
  }

  // 2) WhatsApp: read your APPLIED / NO THANKS replies first
  await readReplies(state);

  // 3) Scrape (rotated dork batch; full sweep every 6 hours)
  const results = await Promise.all([scrapeReed(), scrapeAdzuna(), scrapeWebDorks(pickDorks())]);
  let jobs = dedupe(results.flat());
  for (const j of jobs) j.score = scoreJob(j.title, j.summary || "", j.url || "");
  jobs.sort((a, b) => b.score - a.score);

  // 4) Merge into memory BEFORE capping — every good find becomes an alert
  const freshJobs = [];
  for (const j of jobs.slice(0, 30)) {
    if (!state.jobs[j.id]) {
      state.jobs[j.id] = { status: "new", firstSeen: now, job: j };
      freshJobs.push(j);
    } else {
      state.jobs[j.id].job = j; // refresh snapshot (pay/url can change)
    }
  }

  // 5) jobs-data.json for the site (top 12; keep previous if nothing found)
  const top = jobs.slice(0, KEEP_TOP).map(({ score, ...rest }) => rest);
  const nowLondon = new Date().toLocaleDateString("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const missingKeys = [];
  if (!REED_API_KEY) missingKeys.push("REED_API_KEY");
  if (!ADZUNA_APP_ID || !ADZUNA_APP_KEY) missingKeys.push("ADZUNA_APP_ID + ADZUNA_APP_KEY");
  const out = {
    updatedAt: nowLondon,
    location: "KT1 3HZ · bus-only · 16+",
    note: missingKeys.length
      ? `No keys set (${missingKeys.join(", ")}) - add them as GitHub repo secrets for live results.`
      : "Auto-scraped leads. Check age (16 vs 18+), pay and bus travel on the real listing before applying.",
    jobs: top,
  };
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    if (Array.isArray(prev.jobs) && prev.jobs.length && top.length === 0) {
      out.jobs = prev.jobs;
      out.note = "Tonight's scrape found nothing new - showing previous results.";
    }
  } catch {
    /* first run */
  }
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`jobs-data.json written: ${out.jobs.length} job(s), updated ${nowLondon}`);

  // 6) WhatsApp instant alerts + daily reminders (or CallMeBot fallback)
  if (GREEN_READY) {
    if (!state.welcomeSent) {
      // Send the connection welcome exactly once — the moment WhatsApp is
      // linked, even if the robot has been running for days before that.
      if (await waSendGreen(buildWelcome())) state.welcomeSent = true;
      else console.warn("Welcome message failed — check the Green API secrets / QR link.");
    }
    let sent = 0;
    for (const e of pendingNew(state)) {
      if (sent >= MAX_NEW_ALERTS_PER_RUN) break;
      state.counter = (state.counter || 0) + 1;
      e.num = state.counter;
      const ok = await waSendGreen(buildJobAlert(e.job, e.num));
      if (!ok) break; // sending is broken — retry next run instead of hammering
      e.status = "sent";
      e.lastSent = Date.now();
      sent++;
    }
    let reminded = 0;
    for (const e of pendingReminders(state)) {
      if (reminded >= MAX_REMINDERS_PER_RUN) break;
      const ok = await waSendGreen(buildReminder(e.job, e.num));
      if (!ok) break;
      e.reminders = (e.reminders || 0) + 1;
      e.lastReminded = Date.now();
      reminded++;
    }
    if (sent || reminded) console.log(`WhatsApp: ${sent} new alert(s), ${reminded} reminder(s) sent.`);
  } else if (CALLME_READY && freshJobs.length) {
    // CallMeBot can send but CANNOT read replies — one compact combined
    // message, no reminder loop.
    const text = freshJobs
      .slice(0, 3)
      .map(
        (j, i) =>
          `NEW JOB #${i + 1}: ${String(j.title).toUpperCase()} (${distanceFor(j)})\nAPPLY: ${j.url}`
      )
      .join("\n\n");
    await waSendCallMeBot(text);
    for (const e of pendingNew(state).slice(0, 3)) {
      e.status = "sent";
      e.lastSent = Date.now();
    }
  }

  // 7) Save memory
  saveState(state);

  // 8) Telegram morning digest (unchanged behaviour, optional)
  await notifyTelegram(freshJobs, out.jobs.length);
}

// Only auto-run when executed directly (node nightly-scrape.mjs) — not when
// imported by tests.
const invoked = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]));
if (invoked) {
  main().catch((e) => {
    console.error("Scrape failed:", e);
    process.exit(1);
  });
}

export { buildDigest, coverLetterFor };


