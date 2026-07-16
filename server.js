import express from "express";
import webpush from "web-push";
import cron from "node-cron";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import {
  macroPrompt,
  localPrompt,
  watchlistPrompt,
} from "./prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB = path.join(__dirname, "data.json");
const PORT = process.env.PORT || 3000;

// ── config ────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:you@example.com",
  BRIEF_CRON = "30 6 * * 1-5",
  BRIEF_TZ = "America/New_York",
} = process.env;

for (const [key, value] of Object.entries({
  ANTHROPIC_API_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
})) {
  if (!value) {
    console.error(`Missing ${key}. See README.`);
    process.exit(1);
  }
}

webpush.setVapidDetails(
  VAPID_SUBJECT,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

// ── tiny JSON store ───────────────────────────────────────
async function read() {
  try {
    return JSON.parse(await fs.readFile(DB, "utf8"));
  } catch {
    return { subs: {} };
  }
}

async function write(db) {
  await fs.writeFile(DB, JSON.stringify(db, null, 2));
}

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
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Anthropic ${res.status}: ${await res.text()}`
    );
  }

  const data = await res.json();

  return (data.content || [])
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function parseJSON(text) {
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("No JSON in response");
  }

  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── brief generation ──────────────────────────────────────
async function buildBrief(sub) {
  const brief = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: Date.now(),
    macro: {
      pulse: [],
      sections: [],
    },
    firms: {},
  };

  try {
    brief.macro = parseJSON(
      await ask(macroPrompt())
    );
  } catch (error) {
    console.error("macro:", error.message);
  }

  if (sub.geo || sub.market) {
    try {
      brief.local = parseJSON(
        await ask(localPrompt(sub.geo, sub.market))
      );
    } catch (error) {
      brief.local = {
        items: [],
        fundamentals: [],
      };

      console.error("local:", error.message);
    }
  }

  const watchlist = Array.isArray(sub.watchlist)
    ? sub.watchlist
        .map(firm => String(firm).trim())
        .filter(Boolean)
    : [];

  // Initialize every firm so the frontend always receives
  // the same object shape, even if no news is found.
  for (const firm of watchlist) {
    brief.firms[firm] = {
      status: "done",
      items: [],
    };
  }

  // One combined Claude call for the entire watchlist.
  if (watchlist.length) {
    try {
      const result = parseJSON(
        await ask(watchlistPrompt(watchlist))
      );

      const returnedFirms = Array.isArray(result.firms)
        ? result.firms
        : [];

      for (const returnedFirm of returnedFirms) {
        if (
          !returnedFirm ||
          typeof returnedFirm.name !== "string"
        ) {
          continue;
        }

        const returnedName = returnedFirm.name
          .trim()
          .toLowerCase();

        const originalName = watchlist.find(
          firm => firm.toLowerCase() === returnedName
        );

        if (!originalName) {
          continue;
        }

        brief.firms[originalName] = {
          status: "done",
          items: Array.isArray(returnedFirm.items)
            ? returnedFirm.items.slice(0, 2)
            : [],
        };
      }
    } catch (error) {
      console.error(
        "combined watchlist:",
        error.message
      );

      for (const firm of watchlist) {
        brief.firms[firm] = {
          status: "error",
          items: [],
          msg: error.message,
        };
      }
    }
  }

  return brief;
}

// Push payloads cap around 4 KB, so send a summary and let
// the app load the full stored brief when opened.
function summarize(brief) {
  const firmHits = Object.values(
    brief.firms || {}
  ).reduce(
    (count, firm) =>
      count + (firm.items?.length || 0),
    0
  );

  const localHits =
    brief.local?.items?.length || 0;

  const tenY =
    brief.macro?.pulse?.[0]?.value;

  const bits = [];

  if (tenY) {
    bits.push(`10Y ${tenY}`);
  }

  if (firmHits) {
    bits.push(`${firmHits} on your watchlist`);
  }

  if (localHits) {
    bits.push(
      `${localHits} in ${
        brief.local?.market || "your market"
      }`
    );
  }

  const lead =
    brief.local?.items?.[0]?.headline ||
    brief.macro?.sections?.find(
      section => section.items?.length
    )?.items?.[0]?.headline ||
    "Tap to read the stack.";

  return {
    title: bits.length
      ? bits.join(" · ")
      : "Your CRE brief is ready",
    body: lead.slice(0, 140),
  };
}

async function runDaily() {
  const db = await read();
  const entries = Object.entries(db.subs);

  console.log(
    `[cron] ${new Date().toISOString()} — ${
      entries.length
    } subscriber(s)`
  );

  for (const [id, sub] of entries) {
    try {
      const brief = await buildBrief(sub);
      sub.brief = brief;

      const { title, body } =
        summarize(brief);

      await webpush.sendNotification(
        sub.subscription,
        JSON.stringify({
          title,
          body,
          date: brief.date,
        })
      );

      console.log(
        `[cron] pushed to ${id.slice(
          0,
          12
        )}… — ${title}`
      );
    } catch (error) {
      if (
        error.statusCode === 404 ||
        error.statusCode === 410
      ) {
        delete db.subs[id];

        console.log(
          `[cron] dropped dead subscription ${id.slice(
            0,
            12
          )}…`
        );
      } else {
        console.error(
          `[cron] ${id.slice(
            0,
            12
          )}… failed:`,
          error.message
        );
      }
    }
  }

  await write(db);
}

cron.schedule(BRIEF_CRON, runDaily, {
  timezone: BRIEF_TZ,
});

console.log(
  `Daily brief scheduled: "${BRIEF_CRON}" (${BRIEF_TZ})`
);

// ── API ───────────────────────────────────────────────────
const app = express();

app.use(
  express.json({
    limit: "1mb",
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

const idOf = subscription =>
  Buffer.from(subscription.endpoint)
    .toString("base64url")
    .slice(-40);

app.get("/api/key", (_req, res) => {
  res.json({
    key: VAPID_PUBLIC_KEY,
  });
});

// Register or update a device.
app.post(
  "/api/subscribe",
  async (req, res) => {
    const {
      subscription,
      watchlist,
      geo,
      market,
    } = req.body || {};

    if (!subscription?.endpoint) {
      return res.status(400).json({
        error:
          "No push subscription sent.",
      });
    }

    const db = await read();
    const id = idOf(subscription);

    db.subs[id] = {
      ...(db.subs[id] || {}),
      subscription,
      watchlist,
      geo,
      market,
      updated: Date.now(),
    };

    await write(db);

    res.json({
      ok: true,
      id,
    });
  }
);

app.post(
  "/api/unsubscribe",
  async (req, res) => {
    const db = await read();
    const { endpoint } = req.body || {};

    if (endpoint) {
      const id = Buffer.from(endpoint)
        .toString("base64url")
        .slice(-40);

      delete db.subs[id];
    }

    await write(db);

    res.json({
      ok: true,
    });
  }
);

// Return the most recently scheduled brief.
app.get(
  "/api/brief/:id",
  async (req, res) => {
    const db = await read();

    const brief =
      db.subs[req.params.id]?.brief;

    if (!brief) {
      return res.status(404).json({
        error:
          "No brief stored yet.",
      });
    }

    res.json(brief);
  }
);

// Manual AI generation is disabled.
app.post("/api/ask", (_req, res) => {
  res.status(403).json({
    error:
      "Manual brief generation is disabled.",
  });
});

// Keep the manual test route disabled in production.
// app.post("/api/test-push", async (_req, res) => {
//   await runDaily();
//   res.json({ ok: true });
// });

app.listen(PORT, () => {
  console.log(
    `CRE brief server on :${PORT}`
  );
});
