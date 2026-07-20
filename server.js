import express from "express";
import webpush from "web-push";
import cron from "node-cron";
import path from "path";
import { fileURLToPath } from "url";

import {
  macroPrompt,
  localPrompt,
  watchlistPrompt,
} from "./prompts.js";

import {
  pool,
  initializeDatabase,
} from "./db.js";

import {
  fetchMarketPulse,
} from "./marketData.js";

const __dirname = path.dirname(
  fileURLToPath(import.meta.url)
);

const PORT = process.env.PORT || 3000;

// ── config ────────────────────────────────────────────────
const {
  ANTHROPIC_API_KEY,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT = "mailto:you@example.com",
  BRIEF_CRON = "0 8 * * 1-5",
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

// ── model ─────────────────────────────────────────────────
async function ask(prompt) {
  const tools = [
    {
      type: "web_search_20250305",
      name: "web_search",
      max_uses: 6,
    },
  ];

  const messages = [
    {
      role: "user",
      content: prompt,
    },
  ];

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 3000,
          messages,
          tools,
        }),
      }
    );

    if (!res.ok) {
      throw new Error(
        `Anthropic ${res.status}: ${await res.text()}`
      );
    }

    const data = await res.json();

    console.log(
      `[anthropic] attempt=${attempt} stop_reason=${data.stop_reason}`
    );

    const text = (data.content || [])
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim();

    if (data.stop_reason === "pause_turn") {
      messages.push({
        role: "assistant",
        content: data.content,
      });
      continue;
    }

    if (data.stop_reason === "max_tokens") {
      throw new Error("Claude hit max_tokens.");
    }

    if (!text) {
      throw new Error(
        `No text returned. stop_reason=${data.stop_reason}`
      );
    }

    return text;
  }

  throw new Error(
    "Anthropic web search never completed."
  );
}

function parseJSON(text) {
  const cleaned = String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (
    start === -1 ||
    end === -1 ||
    end <= start
  ) {
    throw new Error("No JSON in response");
  }

  return JSON.parse(
    cleaned.slice(start, end + 1)
  );
}
// ── direct market data ────────────────────────────────────

// FRED provides simple CSV downloads and mirrors the
// official Treasury and New York Fed series.
//
// DGS10 = 10-Year Treasury Constant Maturity Rate
// SOFR  = Secured Overnight Financing Rate
async function fetchFredSeries(seriesId) {
  const startDate = new Date(
    Date.now() - 21 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);

  const url =
    "https://fred.stlouisfed.org/graph/fredgraph.csv" +
    `?id=${encodeURIComponent(seriesId)}` +
    `&cosd=${startDate}`;

  const response = await fetch(url, {
    headers: {
      "user-agent": "CRE-Daily-Brief/1.0",
      accept: "text/csv",
    },
  });

  if (!response.ok) {
    throw new Error(
      `FRED ${seriesId} request failed: ${response.status}`
    );
  }

  const csv = await response.text();

  const lines = csv
    .trim()
    .split(/\r?\n/)
    .slice(1);

  const observations = [];

  for (const line of lines) {
    const commaIndex =
      line.indexOf(",");

    if (commaIndex === -1) {
      continue;
    }

    const date = line
      .slice(0, commaIndex)
      .trim();

    const rawValue = line
      .slice(commaIndex + 1)
      .trim()
      .replaceAll('"', "");

    // FRED uses "." for missing observations.
    if (
      !rawValue ||
      rawValue === "."
    ) {
      continue;
    }

    const value =
      Number(rawValue);

    if (!Number.isFinite(value)) {
      continue;
    }

    observations.push({
      date,
      value,
    });
  }

  if (!observations.length) {
    throw new Error(
      `No usable ${seriesId} observations returned`
    );
  }

  const latest =
    observations[
      observations.length - 1
    ];

  const previous =
    observations.length > 1
      ? observations[
          observations.length - 2
        ]
      : null;

  return {
    latest,
    previous,
  };
}

function formatBasisPointChange(
  latest,
  previous
) {
  if (!previous) {
    return null;
  }

  const basisPoints = Math.round(
    (latest.value -
      previous.value) *
      100
  );

  if (basisPoints === 0) {
    return "unch.";
  }

  return basisPoints > 0
    ? `▲ ${basisPoints}bp`
    : `▼ ${Math.abs(
        basisPoints
      )}bp`;
}

function readOptionalNumber(
  value
) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

// ── brief generation ──────────────────────────────────────
async function buildBrief(sub) {
  const brief = {
  date: new Date()
    .toISOString()
    .slice(0, 10),
  generatedAt: Date.now(),

  marketPulse: {
    rates: [],
    cmbs: [],
    capRates: [],
  },

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
  console.error(
    "macro:",
    error.message
  );
}
  try {
  brief.marketPulse =
    await fetchMarketPulse();
} catch (error) {
  console.error(
    "market pulse:",
    error.message
  );
}

// Make sure the AI response has a valid structure.
if (
  !brief.macro ||
  typeof brief.macro !==
    "object"
) {
  brief.macro = {};
}

if (
  !Array.isArray(
    brief.macro.sections
  )
) {
  brief.macro.sections = [];
}

// Replace the AI-generated pulse with direct data.
try {
  brief.macro.pulse =
    await fetchMarketPulse();
} catch (error) {
  console.error(
    "market pulse:",
    error.message
  );

  brief.macro.pulse = [
    {
      key: "treasury10Y",
      label: "10Y UST",
      value: "—",
    },
    {
      key: "sofr",
      label: "SOFR",
      value: "—",
    },
    {
      key: "cmbsSpreads",
      label: "CMBS SPREADS",
      value: "—",
    },
    {
      key: "capRates",
      label: "CAP RATES",
      value: "—",
    },
  ];
}

  if (sub.geo || sub.market) {
    try {
      brief.local = parseJSON(
        await ask(
          localPrompt(
            sub.geo,
            sub.market
          )
        )
      );
    } catch (error) {
      brief.local = {
        items: [],
        fundamentals: [],
      };

      console.error(
        "local:",
        error.message
      );
    }
  }

  const watchlist = Array.isArray(
    sub.watchlist
  )
    ? sub.watchlist
        .map(firm =>
          String(firm).trim()
        )
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
        await ask(
          watchlistPrompt(watchlist)
        )
      );

      const returnedFirms =
        Array.isArray(result.firms)
          ? result.firms
          : [];

      for (
        const returnedFirm
        of returnedFirms
      ) {
        if (
          !returnedFirm ||
          typeof returnedFirm.name !==
            "string"
        ) {
          continue;
        }

        const returnedName =
          returnedFirm.name
            .trim()
            .toLowerCase();

        const originalName =
          watchlist.find(
            firm =>
              firm.toLowerCase() ===
              returnedName
          );

        if (!originalName) {
          continue;
        }

        brief.firms[originalName] = {
          status: "done",
          items: Array.isArray(
            returnedFirm.items
          )
            ? returnedFirm.items.slice(
                0,
                2
              )
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
      count +
      (firm.items?.length || 0),
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
    bits.push(
      `${firmHits} on your watchlist`
    );
  }

  if (localHits) {
    bits.push(
      `${localHits} in ${
        brief.local?.market ||
        "your market"
      }`
    );
  }

  const lead =
    brief.local?.items?.[0]
      ?.headline ||
    brief.macro?.sections?.find(
      section =>
        section.items?.length
    )?.items?.[0]?.headline ||
    "Tap to read the stack.";

  return {
    title: bits.length
      ? bits.join(" · ")
      : "Your CRE brief is ready",
    body: lead.slice(0, 140),
  };
}

// Prevent the same server process from starting a second
// generation while the first one is still running.
let dailyRunActive = false;

async function runDaily() {
  if (dailyRunActive) {
    console.log(
      "[cron] skipped because a run is already active"
    );
    return;
  }

  dailyRunActive = true;

  try {
    const result = await pool.query(`
      SELECT
        id,
        subscription,
        watchlist,
        geo,
        market
      FROM subscribers
      ORDER BY updated_at ASC
    `);

    const subscribers = result.rows;

    console.log(
      `[cron] ${new Date().toISOString()} — ${
        subscribers.length
      } subscriber(s)`
    );

    for (const sub of subscribers) {
      const {
        id,
        subscription,
        watchlist,
        geo,
        market,
      } = sub;

      try {
        const brief = await buildBrief({
          watchlist,
          geo,
          market,
        });

        // Save the full brief before attempting the push.
        // It remains stored until the next scheduled run
        // replaces it.
        await pool.query(
          `
            UPDATE subscribers
            SET
              brief = $1::jsonb,
              brief_generated_at = NOW()
            WHERE id = $2
          `,
          [
            JSON.stringify(brief),
            id,
          ]
        );

        console.log(
          `[cron] saved brief for ${id.slice(
            0,
            12
          )}…`
        );

        const { title, body } =
          summarize(brief);

        try {
          await webpush.sendNotification(
            subscription,
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
        } catch (pushError) {
          if (
            pushError.statusCode ===
              404 ||
            pushError.statusCode === 410
          ) {
            await pool.query(
              `
                DELETE FROM subscribers
                WHERE id = $1
              `,
              [id]
            );

            console.log(
              `[cron] dropped dead subscription ${id.slice(
                0,
                12
              )}…`
            );
          } else {
            console.error(
              `[cron] brief saved, but push failed for ${id.slice(
                0,
                12
              )}…:`,
              pushError.message
            );
          }
        }
      } catch (error) {
        console.error(
          `[cron] ${id.slice(
            0,
            12
          )}… generation failed:`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error(
      "[cron] unable to load subscribers:",
      error
    );
  } finally {
    dailyRunActive = false;
  }
}

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
  Buffer.from(
    subscription.endpoint
  )
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
    try {
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

      const id =
        idOf(subscription);

      const cleanWatchlist =
        Array.isArray(watchlist)
          ? watchlist
              .map(firm =>
                String(firm).trim()
              )
              .filter(Boolean)
          : [];

      /*
       * Updating preferences does not overwrite the existing
       * stored brief.
       */
      await pool.query(
        `
          INSERT INTO subscribers (
            id,
            subscription,
            watchlist,
            geo,
            market,
            updated_at
          )
          VALUES (
            $1,
            $2::jsonb,
            $3::jsonb,
            $4,
            $5,
            NOW()
          )
          ON CONFLICT (id)
          DO UPDATE SET
            subscription =
              EXCLUDED.subscription,
            watchlist =
              EXCLUDED.watchlist,
            geo =
              EXCLUDED.geo,
            market =
              EXCLUDED.market,
            updated_at = NOW()
        `,
        [
          id,
          JSON.stringify(
            subscription
          ),
          JSON.stringify(
            cleanWatchlist
          ),
          geo || null,
          market || null,
        ]
      );

      console.log(
        `[subscribe] saved ${id.slice(
          0,
          12
        )}…`
      );

      res.json({
        ok: true,
        id,
      });
    } catch (error) {
      console.error(
        "subscribe:",
        error
      );

      res.status(500).json({
        error:
          "Unable to save subscription.",
      });
    }
  }
);

app.post(
  "/api/unsubscribe",
  async (req, res) => {
    try {
      const { endpoint } =
        req.body || {};

      if (endpoint) {
        const id = Buffer.from(
          endpoint
        )
          .toString("base64url")
          .slice(-40);

        await pool.query(
          `
            DELETE FROM subscribers
            WHERE id = $1
          `,
          [id]
        );

        console.log(
          `[unsubscribe] removed ${id.slice(
            0,
            12
          )}…`
        );
      }

      res.json({
        ok: true,
      });
    } catch (error) {
      console.error(
        "unsubscribe:",
        error
      );

      res.status(500).json({
        error:
          "Unable to unsubscribe.",
      });
    }
  }
);

// Return the most recently scheduled brief.
// Return the newest stored brief for browsers that do not
// have a device-specific notification subscription ID.
app.get(
  "/api/brief/latest",
  async (_req, res) => {
    try {
      const result = await pool.query(
        `
          SELECT brief
          FROM subscribers
          WHERE brief IS NOT NULL
          ORDER BY updated_at DESC
          LIMIT 1
        `
      );

      if (!result.rows.length || !result.rows[0].brief) {
        return res.status(404).json({
          error: "No brief stored yet.",
        });
      }

      res.set("Cache-Control", "no-store");

      res.json(result.rows[0].brief);
    } catch (error) {
      console.error(
        "latest brief lookup:",
        error
      );

      res.status(500).json({
        error: "Unable to load latest brief.",
      });
    }
  }
);
app.get(
  "/api/brief/:id",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
            SELECT brief
            FROM subscribers
            WHERE id = $1
          `,
          [req.params.id]
        );

      if (!result.rows.length) {
        return res.status(404).json({
          error:
            "Subscription not found.",
        });
      }

      const brief =
        result.rows[0].brief;

      if (!brief) {
        return res.status(404).json({
          error:
            "No brief stored yet.",
        });
      }

      // Do not serve an old browser-cached API response after
      // the next 8:00 AM brief is generated.
      res.set(
        "Cache-Control",
        "no-store"
      );
res.set("Cache-Control", "no-store");
      res.json(brief);
    } catch (error) {
      console.error(
        "brief lookup:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load brief.",
      });
    }
  }
);

// Manual AI generation is disabled.
app.post(
  "/api/ask",
  (_req, res) => {
    res.status(403).json({
      error:
        "Manual brief generation is disabled.",
    });
  }
);

// Verify that Render can reach PostgreSQL.
app.get(
  "/api/health",
  async (_req, res) => {
    try {
      await pool.query("SELECT 1");

      res.json({
        ok: true,
        database: "connected",
      });
    } catch (error) {
      console.error(
        "health check:",
        error
      );

      res.status(503).json({
        ok: false,
        database: "unavailable",
      });
    }
  }
);

// Keep the manual test route disabled in production.
// app.post("/api/test-push", async (_req, res) => {
//   await runDaily();
//   res.json({ ok: true });
// });

// ── startup ───────────────────────────────────────────────
async function start() {
  try {
    await initializeDatabase();

    cron.schedule(
      BRIEF_CRON,
      runDaily,
      {
        timezone: BRIEF_TZ,
      }
    );

    console.log(
      `Daily brief scheduled: "${BRIEF_CRON}" (${BRIEF_TZ})`
    );

    app.listen(PORT, () => {
      console.log(
        `CRE brief server on :${PORT}`
      );
    });
  } catch (error) {
    console.error(
      "Server startup failed:",
      error
    );

    process.exit(1);
  }
}

start();
