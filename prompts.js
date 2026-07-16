// Shared by the server cron job.
const dateLong = () =>
  new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });

export const MACRO_SECTIONS = [
  "Rates & debt",
  "Capital markets",
  "Office",
  "Industrial & data centers",
  "Multifamily & retail",
];

export function macroPrompt() {
  return `Today is ${dateLong()}. Search the web for the latest commercial real estate news and market data from the past 48 hours. Cover: Treasury yields and Fed policy, CRE debt/CMBS/lending conditions, transaction volume and cap rates, and sector news across office, industrial, data centers, multifamily and retail.

Brief a commercial real estate professional. Prioritize what moved and what is actionable. Use real, current figures from your search.

Return ONLY a valid JSON object, with no prose and no markdown:

{
  "pulse": [
    {
      "value": "4.28%",
      "note": "+6bps on the week"
    },
    {
      "value": "4.33%",
      "note": "flat"
    },
    {
      "value": "AAA +82",
      "note": "tightening"
    },
    {
      "value": "Stable",
      "note": "industrial 5.5-6.0%"
    }
  ],
  "sections": [
    {
      "title": "Rates & debt",
      "items": [
        {
          "headline": "Short factual headline",
          "detail": "Maximum 25 words describing what happened, including figures",
          "why": "Maximum 12 words explaining what it means for CRE",
          "source": "Publication name",
          "url": "https://..."
        }
      ]
    }
  ]
}

Requirements:

- "pulse" must contain exactly 4 entries in this order:
  1. 10Y Treasury
  2. SOFR
  3. CMBS spreads
  4. Cap rate direction
- "sections" must contain exactly these 5 titles in this order:
  ${MACRO_SECTIONS.map(section => `"${section}"`).join(", ")}
- Return no more than 2 items per section.
- If a section has no real news, return an empty "items" array.
- Only include real information supported by a working source URL.
- Never invent a figure, story, source, or URL.`;
}

export function localPrompt(geo, market) {
  const where = market
    ? `The user's market is "${market}".`
    : `The user is at latitude ${Number(geo.lat).toFixed(4)}, longitude ${Number(
        geo.lng
      ).toFixed(
        4
      )}. First identify the metro area and the specific CRE submarket those coordinates fall in.`;

  return `Today is ${dateLong()}. ${where}

Search the web for commercial real estate news and market data specific to that metro from the past 14 days. Look for notable sales and acquisitions, major leases, new development and entitlements, and market fundamentals. Use the metro's real CRE vocabulary and named submarkets.

Return ONLY a valid JSON object, with no prose and no markdown:

{
  "market": "Metro name, ST",
  "submarket": "Nearest CRE submarket name",
  "fundamentals": [
    {
      "value": "18.4%",
      "note": "office vacancy, Q2"
    },
    {
      "value": "$34.10",
      "note": "office asking, NNN"
    },
    {
      "value": "5.2%",
      "note": "industrial vacancy"
    },
    {
      "value": "2.1M SF",
      "note": "under construction"
    }
  ],
  "items": [
    {
      "headline": "Short factual headline",
      "detail": "Maximum 30 words including price, PSF, address, buyer and seller, or tenant",
      "date": "Jul 12",
      "tag": "deal",
      "source": "Publication name",
      "url": "https://..."
    }
  ]
}

Requirements:

- "market" must be the real metro name, never coordinates.
- "fundamentals" must contain exactly 4 entries in this order:
  1. Office vacancy
  2. Office asking rent
  3. Industrial vacancy
  4. Construction pipeline
- Use actual current figures from your search.
- Return no more than 5 news items, newest first.
- "tag" must be one of:
  deal, capital, leasing, development, other
- Only include real news supported by a working source URL.
- If the market is small and has little CRE coverage, widen to the nearest major metro and say so in "market".
- Never invent a story, figure, date, source, or URL.`;
}

export function watchlistPrompt(firms = []) {
  const cleanFirms = firms
    .map(firm => String(firm).trim())
    .filter(Boolean);

  return `Today is ${dateLong()}.

Search the web for recent commercial real estate news involving all of the following firms:

${cleanFirms.map(firm => `- ${firm}`).join("\n")}

Look for news from the past 7 days involving acquisitions, dispositions, financings, fund closes, leasing, earnings, development, and leadership changes.

Return ONLY a valid JSON object, with no prose and no markdown:

{
  "firms": [
    {
      "name": "Exact firm name from the supplied list",
      "items": [
        {
          "headline": "Short factual headline",
          "detail": "Maximum 30 words including deal size, asset, market, and counterparty when known",
          "date": "Jul 16",
          "tag": "deal",
          "source": "Publication name",
          "url": "https://..."
        }
      ]
    }
  ]
}

Requirements:

- Include every supplied firm exactly once.
- Preserve each firm's spelling exactly as supplied.
- Return no more than 2 items per firm.
- Order items newest first.
- "tag" must be one of:
  deal, capital, leasing, earnings, people, development, other
- Only include real news supported by a working source URL.
- If no qualifying news exists for a firm, return an empty "items" array for that firm.
- Never invent a story, date, amount, source, or URL.`;
}
