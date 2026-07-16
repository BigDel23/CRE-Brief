import express from "express";
import webpush from "web-push";
import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "data.json");
const PORT = process.env.PORT || 3000;

// ── config ────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:you@example.com",
  BRIEF_CRON = "30 6 * * 1-5",   // 6:30am, weekdays
  BRIEF_TZ = "America/New_York",
} = process.env;

for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY })) {
  if (!v) { console.error(`Missing ${k}. See README.`); process.exit(1); }
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ── tiny json store ───────────────────────────────────────
// One file. Good for one person or a small team; swap for Postgres if it grows.
async function read() {
  try { return JSON.parse(await fs.readFile(DB, "utf8")); }
  catch { return { subs: {} }; }
}
async function write(db) { await fs.writeFile(DB, JSON.stringify(db, null, 2)); }

// ── model ─────────────────────────────────────────────────
async function ask(prompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

function parseJSON(text) {
  const t = text.replace(/```json/g, "").replace(/```/g, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1) throw new Error("No JSON in response");
  return JSON.parse(t.slice(a, b + 1));
}

// ── prompts (shared with the client) ──────────────────────
import { macroPrompt, localPrompt, firmPrompt } from "./prompts.js";

// ── brief generation ──────────────────────────────────────
async function buildBrief(sub) {
  const brief = { date: new Date().toISOString().slice(0, 10), generatedAt: Date.now() };

  try { brief.macro = parseJSON(await ask(macroPrompt())); }
  catch (e) { brief.macro = { sections: [] }; console.error("macro:", e.message); }

  if (sub.geo || sub.market) {
    try { brief.local = parseJSON(await ask(localPrompt(sub.geo, sub.market))); }
    catch (e) { brief.local = { items: [] }; console.error("local:", e.message); }
  }

  brief.firms = {};
  for (const firm of sub.watchlist || []) {
    try {
      const d = parseJSON(await ask(firmPrompt(firm)));
      brief.firms[firm] = { status: "done", items: d.items || [] };
    } catch (e) {
      brief.firms[firm] = { status: "error", items: [], msg: e.message };
      console.error(`firm ${firm}:`, e.message);
    }
  }
  return brief;
}

// Push payloads cap around 4KB, so send the headline count and let the
// app load the full brief when tapped.
function summarize(brief) {
  const firmHits = Object.values(brief.firms || {}).reduce((n, f) => n + (f.items?.length || 0), 0);
  const localHits = brief.local?.items?.length || 0;
  const tenY = brief.macro?.pulse?.[0]?.value;

  const bits = [];
  if (tenY) bits.push(`10Y ${tenY}`);
  if (firmHits) bits.push(`${firmHits} on your watchlist`);
  if (localHits) bits.push(`${localHits} in ${brief.local?.market || "your market"}`);

  const lead = brief.local?.items?.[0]?.headline
    || brief.macro?.sections?.find(s => s.items?.length)?.items?.[0]?.headline
    || "Tap to read the stack.";

  return {
    title: bits.length ? bits.join(" · ") : "Your CRE brief is ready",
    body: lead.slice(0, 140),
  };
}

async function runDaily() {
  const db = await read();
  const entries = Object.entries(db.subs);
  console.log(`[cron] ${new Date().toISOString()} — ${entries.length} subscriber(s)`);

  for (const [id, sub] of entries) {
    try {
      const brief = await buildBrief(sub);
      sub.brief = brief;
      const { title, body } = summarize(brief);
      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({ title, body, date: brief.date })
      );
      console.log(`[cron] pushed to ${id.slice(0, 12)}… — ${title}`);
    } catch (e) {
      // 404/410 mean the browser threw the subscription away. Stop pushing to it.
      if (e.statusCode === 404 || e.statusCode === 410) {
        delete db.subs[id];
        console.log(`[cron] dropped dead subscription ${id.slice(0, 12)}…`);
      } else {
        console.error(`[cron] ${id.slice(0, 12)}… failed:`, e.message);
      }
    }
  }
  await write(db);
}

cron.schedule(BRIEF_CRON, runDaily, { timezone: BRIEF_TZ });
console.log(`Daily brief scheduled: "${BRIEF_CRON}" (${BRIEF_TZ})`);

// ── api ───────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const idOf = sub => Buffer.from(sub.endpoint).toString("base64url").slice(-40);

app.get("/api/key", (_req, res) => res.json({ key: VAPID_PUBLIC_KEY }));

// Register or update a device: its push subscription, watchlist, and location.
app.post("/api/subscribe", async (req, res) => {
  const { subscription, watchlist, geo, market } = req.body || {};
  if (!subscription?.endpoint) return res.status(400).json({ error: "No push subscription sent." });

  const db = await read();
  const id = idOf(subscription);
  db.subs[id] = { ...(db.subs[id] || {}), subscription, watchlist, geo, market, updated: Date.now() };
  await write(db);
  res.json({ ok: true, id });
});

app.post("/api/unsubscribe", async (req, res) => {
  const db = await read();
  const { endpoint } = req.body || {};
  if (endpoint) delete db.subs[Buffer.from(endpoint).toString("base64url").slice(-40)];
  await write(db);
  res.json({ ok: true });
});

// The brief the cron already built, so opening the app after a push is instant.
app.get("/api/brief/:id", async (req, res) => {
  const db = await read();
  const brief = db.subs[req.params.id]?.brief;
  if (!brief) return res.status(404).json({ error: "No brief stored yet." });
  res.json(brief);
});

// On-demand pull from the app. Keeps the API key off the phone.
app.post("/api/ask", async (req, res) => {
  try {
    const text = await ask(req.body.prompt);
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Fire the daily job by hand — useful for testing the push path.
// app.post("/api/test-push", async (_req, res) => { runDaily(); res.json({ ok: true, note: "Running now; watch the logs." }); });

app.listen(PORT, () => console.log(`CRE brief server on :${PORT}`));
