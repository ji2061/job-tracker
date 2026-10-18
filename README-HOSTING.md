# Jarri's Job Triage — free hosting + overnight auto-update

> **THIS IS THE GITHUB PAGES VERSION.** Your repo MUST be named exactly `job-tracker` (step 5 of the guide). Use this zip for GitHub. The other zip (job-tracker-deploy-kit.zip) is for Netlify.

This folder is your whole website, already built. No installs, no coding.

## What's inside

| File/folder | What it is |
|---|---|
| `index.html` + `_next/` + other files | Your job triage site (the one from the chat, with the 10 hand-checked Kingston jobs) |
| `jobs-data.json` | Where the robot writes fresh overnight job leads (empty for now) |
| `scraper/nightly-scrape.mjs` | The little robot program that pulls new jobs at night |
| `.github/workflows/nightly-scrape.yml` | Tells GitHub to run the robot every night (~3am UK) for free |

---

## Option A — live website in 2 minutes (no account juggling beyond one signup)

1. Unzip this folder somewhere you can find it.
2. Go to **app.netlify.com/drop** and sign up free.
3. Drag the **whole unzipped folder** onto the page.
4. Wait ~30 seconds → you get a free live URL like `something.netlify.app`.
5. Open it on your phone. Done — that's your live website.

Later: when new jobs are found in the chat, re-drag the folder to update.

## Option B — full auto: new jobs appear WHILE YOU SLEEP (~20 min one-off)

This uses GitHub Actions — free for this size of project, forever.

1. Make a free account at github.com, then click **+ → New repository**,
   name it anything (e.g. `job-tracker`), keep it **Public**, Create.
2. On the repo page click **uploading an existing file**, then drag in EVERYTHING
   from this folder — make sure the hidden `.github` folder comes too
   (on Windows enable "Hidden items" in File Explorer to see it).
3. Click **Commit changes**.
4. Turn on the website: **Settings → Pages →** under "Build and deployment",
   Source = **Deploy from a branch**, Branch = **main**, Folder = **/(root)** → Save.
   After ~2 minutes your site is live at `yourname.github.io/job-tracker/`.
5. Get two free job-board keys (this is what feeds the nightly robot):
   - **Reed**: create a free account at reed.co.uk/jobseeker, then request a
     free API key (they email it).
   - **Adzuna**: free account at developer.adzuna.com → your app id + key.
6. Add them as secrets: repo **Settings → Secrets and variables → Actions →
   New repository secret**, three times:
   - `REED_API_KEY` = your Reed key
   - `ADZUNA_APP_ID` = your Adzuna app id
   - `ADZUNA_APP_KEY` = your Adzuna app key
7. Go to the **Actions** tab → enable workflows if asked → click
   **Nightly job scrape → Run workflow** once to test. Green tick = working.
8. Every night around 3am the robot searches 4 ways:
   - **Reed API** + **Adzuna API** (official job boards, your keys) — both
     locked to a **5-mile bus radius of KT1 3HZ**;
   - **Web dorks** (no key needed!) — ~12 google-style searches across Indeed,
     Totaljobs, CV-Library, Glassdoor, gov.uk Find a Job, Jooble and any local
     employer pages, filtered to Kingston-area towns only (no Hull, no Canada).
   It filters out anything that says 18+, and the new cards appear on your
   site with a blue "auto-scraped — verify first" badge.

### Optional: morning alerts on your phone (2 minutes, free, no laptop needed)

The robot can DM you on Telegram every morning with the new matches:

1. In Telegram, message **@BotFather** → send `/newbot` → follow the prompts →
   copy the **bot token** it gives you.
2. Open a chat with your new bot and send it any message (e.g. "hi") — this
   unlocks your chat. Then visit `api.telegram.org/bot<TOKEN>/getUpdates` in a
   browser and copy the `"chat":{"id":...}` number from the reply.
3. Add two more repo secrets, same as step 6:
   - `TELEGRAM_BOT_TOKEN` = the token from BotFather
   - `TELEGRAM_CHAT_ID` = your chat id
4. Re-run the workflow once to test — your phone should buzz with a morning
   digest listing each new job and its link.

No Telegram? Skip this — the site still updates itself either way.

### Optional: WhatsApp alerts (also free — pick ONE way)

**Way 1 — Green API (free forever, ~5 min, works today)**

1. Free account at **green-api.com** → console → **Create instance** → pick
   the free **Developer** plan ($0/month).
2. It shows a QR code: on your phone open **WhatsApp → Settings → Linked
   devices → Link a device** and scan it (same as WhatsApp Web).
3. Copy the **idInstance** and **API token** from the console.
4. Add three repo secrets, same place as step 6:
   - `WHATSAPP_GREEN_INSTANCE_ID` = your idInstance
   - `WHATSAPP_GREEN_TOKEN` = your API token
   - `WHATSAPP_PHONE` = your own number, digits only, e.g. `447712345678`
5. Re-run the workflow once to test — the digest arrives in your **"Message
   yourself"** WhatsApp chat (open that chat once and turn its notifications
   on so it buzzes).

Honest notes: the free plan allows 3 chats (you only need 1) and 1 instance.
Linking works like WhatsApp Web — if the session ever logs out, just re-scan
the QR once. It's an unofficial service sending from your number, so keep it
to this one small daily message (the script already does).

**Way 2 — CallMeBot (currently FULL)**

The "this bot is full" reply is normal: their free WhatsApp bots fill up and
they launch new ones over time. Check
**callmebot.com/blog/free-api-whatsapp-messages** every few days for the new
number, then: save it as a contact → send it
`I allow callmebot to send me messages` → it texts you an APIKEY → add
secrets `WHATSAPP_PHONE` + `WHATSAPP_API_KEY`. The script tries Green API
first and falls back to CallMeBot automatically — set whichever you have.

**Most reliable of all: Telegram.** Official API, free forever, nothing can
fill up. If WhatsApp ever frustrates you, install Telegram and do the 2-minute
BotFather setup above — then forget about it forever.

## What the robot will and won't do

- Each morning alert includes, per job: the **job name**, **pay**, **what the
  role involves**, **whether you need a cover letter** (and exactly where it
  goes), and the **apply link** — not just a bare link.
- It **filters** for your area and Christmas/seasonal/part-time roles, and
  blocks obvious 18+ listings before they ever reach your screen.
- It **alerts you** each morning on Telegram **or WhatsApp** (whichever
  secrets you set) — free, and it runs on GitHub's servers, not your laptop.
- It does **not** apply for you. Blue cards are *leads*: the badge says
  "verify first" because a robot can't check age rules the way a human can.
  The 10 hand-checked cards have no blue badge — those were verified in chat.
- Each card now shows **"Where your letter goes"**: big chains take letters
  inside their online form only (no email exists), and for everywhere else the
  **Walk-in pack** on the site is how you collect a real email — in person.
- No keys yet? The robot still runs and just keeps the site working.
  Add keys any time — 5 minutes.

## Safety rules (unchanged)

- Real employers **never** ask you to pay to apply. Ever.
- Your legal minimum wage at 16–17 is **£8.00/hr** (from April 2026) — never accept less.
- Tell every employer your real availability: college Mon/Tue/Thu, free
  Wed/Fri/Sat/Sun, then every day in the college holidays.
