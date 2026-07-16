# CRE Daily Brief — phone app

Installs to your home screen. Pushes you a brief every weekday morning **without you opening it**.

## Why this needs a server

Your phone can't wake itself up to run web searches. Web push works like this:

```
6:30am  →  your server runs the searches  →  builds the brief
        →  signs a push with your VAPID key
        →  Apple/Google's push service  →  your phone lights up
```

The server is the only thing that can be awake at 6:30am. That's why this is a deploy, not a file
you open. Once it's up you never touch it again.

Cost: a free tier anywhere below, plus Anthropic API usage. A daily brief with 5 firms runs
roughly 8–12 searches — cents a day.

## Setup

**1. Get your keys**

```bash
npm install
npm run keys          # prints your VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
```

Copy `.env.example` to `.env` and fill in:
- `ANTHROPIC_API_KEY` — from console.anthropic.com
- the two VAPID keys you just generated
- `VAPID_SUBJECT` — your real email, `mailto:you@example.com`
- `BRIEF_CRON` / `BRIEF_TZ` — when it lands. Default 6:30am weekdays, New York.

**2. Run it locally**

```bash
npm start                    # http://localhost:3000
```

Push and geolocation both need HTTPS — `localhost` is exempt, so local testing works.

**3. Deploy it**

Any host that runs Node and stays awake. Free tiers that work:

| Host | Notes |
|---|---|
| **Render** | Web Service, free tier. Add a persistent disk or the `data.json` resets on redeploy. |
| **Railway** | Deploys straight from the repo. Add a volume for `data.json`. |
| **Fly.io** | `fly launch`, add a volume. |
| **A Raspberry Pi** | Genuinely fine. It's one Node process. |

Set the same env vars in your host's dashboard. **Do not commit `.env`.**

⚠️ Free tiers that sleep when idle (Render's included) may miss the cron. If your 6:30am
brief doesn't land, either upgrade off the sleeping tier or point a free uptime pinger
(cron-job.org, UptimeRobot) at your URL every 10 minutes to keep it awake.

**4. Install on your phone**

- **iPhone:** open the URL in **Safari** → Share → **Add to Home Screen** → open it *from the
  home screen icon* → tap **Notify**. iOS only allows push for home-screen apps — it will not
  work from the Safari tab. Needs iOS 16.4+.
- **Android:** open in Chrome → **Install app** when prompted → tap **Notify**.

Then tap **Pull brief** once and allow location. That registers your watchlist and market with
the server so the morning job builds *your* brief.

**5. Check the push works before you trust it**

```bash
curl -X POST https://your-url/api/test-push
```

Runs the whole daily job right now and pushes you the result. Watch your server logs.

## How it fits together

```
public/index.html   the app — same stack UI, calls the server instead of the API directly
public/sw.js        service worker — receives push while the app is closed
prompts.js          the three prompts, shared by server and app
server.js           API proxy + subscription store + the 6:30am cron
data.json           created on first subscribe — your subs and last brief
```

Your API key lives only on the server. The app calls `/api/ask` and never sees it.

## Changing things

- **When it lands:** `BRIEF_CRON`. `0 7 * * *` for 7am daily. crontab.guru helps.
- **What it covers:** edit `prompts.js`. Both the cron and the app pick it up.
- **More than one person:** it already handles multiple subscribers, each with their own
  watchlist and market. Past a handful of people, move `data.json` to Postgres — the read/write
  helpers at the top of `server.js` are the only things to swap.

## Troubleshooting

**Nothing arrives at 6:30.** Check logs for `[cron]`. No line means the process was asleep — see
the free-tier warning above. A line but no notification means the subscription expired; open the
app and tap Notify off and on.

**"Notify" says "No push here".** You're in an iOS Safari tab, not the home-screen app. Add to
Home Screen first.

**Location does nothing.** It needs HTTPS. Also check the site's location permission in phone
settings. The typed-market fallback works regardless.

**Briefs are thin.** Normal for private firms and small metros — there's just less reported.
An empty card means nothing happened, which is itself worth knowing.
