#!/usr/bin/env node
/**
 * Nightly job scrape for Jarri's Job Triage (KT1 3HZ · 16+ · bus-only).
 *
 * Runs on GitHub Actions (free) around 03:00 UTC every night and rewrites
 * jobs-data.json at the repo root. Your GitHub Pages site picks it up
 * automatically after the push.
 *
 * Data sources - 4 layers, all free for jobseekers:
 *   1. Reed  API   -> secret REED_API_KEY   (get: reed.co.uk/jobseeker -> API)
 *   2. Adzuna API  -> secrets ADZUNA_APP_ID + ADZUNA_APP_KEY
 *                     (get: developer.adzuna.com -> free account)
 *   3. Web dorks   -> DuckDuckGo (lite endpoint), NO key needed. Runs ~12
 *                     google-style searches each night across Indeed,
 *                     Totaljobs, CV-Library, Glassdoor, gov.uk Find a Job,
 *                     plus any local employer page it can find.
 *   (Google's own Custom Search API stopped accepting new users in 2026,
 *    and Indeed/LinkedIn block direct scraping - the dork layer via
 *    DuckDuckGo is the free, no-signup way to reach those listings.)
 *
 * Phone alerts (all optional, all free):
 *   - Telegram -> secrets TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *     (official API, bulletproof, free forever — the reliable one)
 *   - WhatsApp -> Path 1: Green API free Developer plan (secrets
 *     WHATSAPP_GREEN_INSTANCE_ID + WHATSAPP_GREEN_TOKEN + WHATSAPP_PHONE).
 *     Link your WhatsApp once by QR at green-api.com; $0/month, 3 chats max.
 *              Path 2: CallMeBot (secrets WHATSAPP_PHONE + WHATSAPP_API_KEY)
 *     — their bots fill up and rotate numbers; works again whenever you
 *     register on a number that has room.
 *
 * Each alert message includes per job: name, pay, what the role involves,
 * whether you need a cover letter (and where it goes), and the apply link.
 *
 * With NO keys set, the script still runs: the dork layer works keyless,
 * and jobs-data.json is rewritten so the site keeps working. Add the API
 * keys whenever you're ready - takes ~5 minutes total.
 *
 * Radius: every result is filtered to a 5-mile bus radius of KT1 3HZ
 * (Reed/Adzuna get a distance param; dork results get a town-name filter).
 *
 * Zero npm dependencies. Node 18+.
 */

import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "jobs-data.json");

const LOCATION = "Kingston upon Thames";
const MAX_PER_SOURCE = 15;
const KEEP_TOP = 12;

// 5-mile bus radius around KT1 3HZ (Kingston town centre)
const RADIUS_MILES = 5;
const RADIUS_KM = 8.05;

const REED_API_KEY = process.env.REED_API_KEY || "";
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || "";
const ADZUNA_APP_KEY = process.env.ADZUNA_APP_KEY || "";
// Free phone alerts (optional): TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets.
// The bot DMs Jarri every morning with the new matches — no laptop needed.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
// Free WhatsApp alerts (optional). WHATSAPP_PHONE = your number with country
// code, digits only, e.g. 447712345678 (used by both WhatsApp paths).
// Green API path: WHATSAPP_GREEN_INSTANCE_ID + WHATSAPP_GREEN_TOKEN from the
// green-api.com console (free Developer plan, link your WhatsApp by QR).
// CallMeBot path: WHATSAPP_API_KEY = key the CallMeBot texts you.
const WHATSAPP_PHONE = (process.env.WHATSAPP_PHONE || "").replace(/\D/g, "");
const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || "";
const WHATSAPP_GREEN_INSTANCE_ID = process.env.WHATSAPP_GREEN_INSTANCE_ID || "";
const WHATSAPP_GREEN_TOKEN = process.env.WHATSAPP_GREEN_TOKEN || "";

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
  // "jobs available / updated daily" pages are search hubs, not one job —
  // still useful, but individual listings should rank above them.
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

// Google-style searches. DuckDuckGo lite returns HTML we can read; Google's
// own search blocks bots hard, and their paid-for API closed to new signups
// in 2026 — this gets the same "site: indeed / totaljobs / gov.uk" power
// for free with zero signup.
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

// Towns/postcodes within the 5-mile bus radius of KT1 3HZ. A dork result
// must mention one of these (or a KT postcode) in its title or URL.
const AREA_RE =
  /(kingston upon thames|kingston upon|\bkingston\b|surbiton|tolworth|new malden|old malden|norbiton|berrylands|chessington|worcester park|thames ditton|long ditton|hinchley wood|claygate|esher|weston green|east molesey|west molesey|hampton wick|teddington|\bhampton\b|malden rushett|richmond|twickenham|\bkt[1-9]\b)/i;
// "Kingston" exists in Canada/Jamaica and Kingston upon Hull — exclude them.
const NOT_AREA_RE = /(ontario|\bcanada\b|upon hull|\bhull\b|jamaica|\bmilitary kilington\b)/i;
// Social/portal noise that is never a job listing.
const JUNK_URL_RE =
  /(facebook\.com|instagram\.com|tiktok\.com|youtube\.com|twitter\.com|x\.com|reddit\.com|quora\.com|linkedin\.com|pinterest|tripadvisor|amazon\.co\.uk|\.pdf($|\?))/i;
// Must look job-ish somewhere in title or URL.
const JOBISH_RE = /(job|jobs|vacanc|career|hiring|recruit|seasonal|christmas|temp|staff)/i;

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
    // uddg= is a whole URL-encoded destination: /l/?uddg=https%3A%2F%2F...&rut=...
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

async function scrapeWebDorks() {
  const out = [];
  for (const dork of DORKS) {
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

// ---------- morning phone digests (free, optional) ----------

// Cap detailed blocks so the Telegram message stays under its 4096-char limit.
const DETAILED_JOBS_IN_ALERT = 7;

function coverLetterFor(job) {
  const src = `${job.url || ""} ${job.source || ""}`.toLowerCase();
  if (
    /(sainsburys|boots\.jobs|marksandspencer|royalmail|argos|tesco|currys|superdrug|asda|aldi|lidl|waitrose|iceland)/.test(
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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return; // not configured — skip quietly
  const text = buildDigest(newJobs, totalCount).slice(0, 3900);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      }
    );
    if (!res.ok) console.warn(`Telegram notify failed: HTTP ${res.status}`);
    else console.log("Telegram morning digest sent.");
  } catch (e) {
    console.warn(`Telegram notify skipped: ${e.message}`); // never break the scrape
  }
}

async function notifyWhatsApp(newJobs, totalCount) {
  if (!WHATSAPP_PHONE) return; // not configured — skip quietly
  const text = buildDigest(newJobs, totalCount);

  // Path 1: Green API — free Developer plan, your WhatsApp linked by QR once.
  if (WHATSAPP_GREEN_INSTANCE_ID && WHATSAPP_GREEN_TOKEN) {
    const url = `https://api.green-api.com/waInstance${WHATSAPP_GREEN_INSTANCE_ID}/sendMessage/${WHATSAPP_GREEN_TOKEN}`;
    try {
      const res = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: `${WHATSAPP_PHONE}@c.us`,
            message: text,
          }),
        },
        20000
      );
      if (!res.ok) {
        console.warn(`WhatsApp (Green API) failed: HTTP ${res.status}`);
      } else {
        console.log("WhatsApp morning digest sent via Green API.");
        return;
      }
    } catch (e) {
      console.warn(`WhatsApp (Green API) skipped: ${e.message}`);
    }
  }

  // Path 2: CallMeBot fallback (short messages only — bot numbers rotate
  // when full; works again whenever your registration went through).
  if (!WHATSAPP_API_KEY) return;
  const short = text.slice(0, 900); // CallMeBot has a short message limit
  try {
    const url =
      `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent("+" + WHATSAPP_PHONE)}` +
      `&text=${encodeURIComponent(short)}&apikey=${encodeURIComponent(WHATSAPP_API_KEY)}`;
    const res = await fetchWithTimeout(url, {}, 20000);
    if (!res.ok) console.warn(`WhatsApp (CallMeBot) failed: HTTP ${res.status}`);
    else console.log("WhatsApp morning digest sent via CallMeBot.");
  } catch (e) {
    console.warn(`WhatsApp (CallMeBot) skipped: ${e.message}`); // never break the scrape
  }
}

// ---------- main ----------

async function main() {
  const results = await Promise.all([scrapeReed(), scrapeAdzuna(), scrapeWebDorks()]);
  let jobs = dedupe(results.flat());

  for (const j of jobs) j.score = scoreJob(j.title, j.summary || "", j.url || "");
  jobs.sort((a, b) => b.score - a.score);
  jobs = jobs.slice(0, KEEP_TOP).map(({ score, ...rest }) => rest);

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
    jobs,
  };

  // Preserve previous results if tonight found nothing new
  let previousIds = new Set();
  try {
    const prev = JSON.parse(readFileSync(OUT_FILE, "utf8"));
    if (Array.isArray(prev.jobs) && prev.jobs.length) {
      if (jobs.length === 0) {
        out.jobs = prev.jobs;
        out.note = "Tonight's scrape found nothing new - showing previous results.";
      }
      previousIds = new Set(prev.jobs.map((j) => j.id));
    }
  } catch {
    /* first run */
  }

  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");
  console.log(`jobs-data.json written: ${jobs.length} job(s), updated ${nowLondon}`);
  if (missingKeys.length) {
    console.log(`TIP: add ${missingKeys.join(", ")} as repo secrets for real listings.`);
  }

  // Morning digest to the phone (only when the matching secrets are set)
  const fresh = out.jobs.filter((j) => !previousIds.has(j.id));
  await notifyTelegram(fresh, out.jobs.length);
  await notifyWhatsApp(fresh, out.jobs.length);
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
