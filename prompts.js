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
  return `Today is ${dateLong()}.

Search the web for significant commercial real estate news published within the past 7 days.

Cover these five categories:
${MACRO_SECTIONS.map(section => `- ${section}`).join("\n")}

Focus on:
- CRE lending, debt, refinancing and CMBS activity
- transaction markets, financing and capital flows
- office leasing, distress and conversions
- industrial and data center transactions or development
- multifamily and retail transactions, financing or leasing

Do not generate Treasury, SOFR, CMBS spread or cap-rate pulse figures. Those are supplied separately by direct market-data sources.

Return ONLY one valid JSON object. Do not include an introduction, explanation, markdown or code fences.

Use exactly this structure:
{
  "sections": [
    {
      "title": "Rates & debt",
      "items": [
        {
          "headline": "Short factual headline",
          "detail": "What happened, including relevant figures, in 35 words or fewer",
          "why": "Why it matters for CRE in 15 words or fewer",
          "source": "Publication name",
          "url": "https://working-source-url"
        }
      ]
    }
  ]
}

The sections array must contain exactly these five titles in this order:
${MACRO_SECTIONS.map(section => `"${section}"`).join(", ")}

Give up to 2 verified items per section. If no reliable news is available for a section, return an empty items array. Never invent facts, figures, sources or URLs. Always return the complete JSON structure, even when every items array is empty.`;
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
