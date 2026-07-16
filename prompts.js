// Shared by the server (cron) and the app (on-demand pulls).
const dateLong = () => new Date().toLocaleDateString("en-US",
  { weekday: "long", month: "long", day: "numeric", year: "numeric" });

export const MACRO_SECTIONS = [
  "Rates & debt", "Capital markets", "Office",
  "Industrial & data centers", "Multifamily & retail",
];

export function macroPrompt() {
  return `Today is ${dateLong()}. Search the web for the latest commercial real estate news and market data from the past 48 hours. Cover: Treasury yields and Fed policy, CRE debt/CMBS/lending conditions, transaction volume and cap rates, and sector news across office, industrial, data centers, multifamily and retail.

Brief a commercial real estate professional. Prioritize what moved and what is actionable. Use real, current figures from your search.

Return ONLY a JSON object, no prose, no markdown:
{"pulse":[{"value":"4.28%","note":"+6bps on the week"},{"value":"4.33%","note":"flat"},{"value":"AAA +82","note":"tightening"},{"value":"Stable","note":"industrial 5.5-6.0%"}],
"sections":[{"title":"Rates & debt","items":[{"headline":"short factual headline","detail":"25 words max on what happened, with figures","why":"12 words max on what it means for CRE","source":"outlet name","url":"https://..."}]}]}

"pulse" must have exactly 4 entries in this order: 10Y Treasury, SOFR, CMBS spreads, cap rate direction.
"sections" must be exactly these 5 titles in this order: ${MACRO_SECTIONS.map(s => '"' + s + '"').join(", ")}. Give 1-2 items each. If a sector had no real news, return an empty items array rather than filler.`;
}

export function localPrompt(geo, market) {
  const where = market
    ? `The user's market is "${market}".`
    : `The user is at latitude ${Number(geo.lat).toFixed(4)}, longitude ${Number(geo.lng).toFixed(4)}. First identify the metro area and the specific CRE submarket those coordinates fall in.`;

  return `Today is ${dateLong()}. ${where}

Search the web for commercial real estate news and market data specific to that metro from the past 14 days: notable sales and acquisitions, major leases, new development and entitlements, and market fundamentals. Use the metro's real CRE vocabulary and named submarkets.

Return ONLY a JSON object, no prose, no markdown:
{"market":"Metro name, ST","submarket":"nearest CRE submarket name",
"fundamentals":[{"value":"18.4%","note":"office vacancy, Q2"},{"value":"$34.10","note":"office asking, NNN"},{"value":"5.2%","note":"industrial vacancy"},{"value":"2.1M SF","note":"under construction"}],
"items":[{"headline":"short factual headline","detail":"30 words max with price, PSF, address, buyer/seller or tenant","date":"Jul 12","tag":"deal","source":"outlet name","url":"https://..."}]}

"market" must be the real metro name, never coordinates. "fundamentals" must have exactly 4 entries in this order: office vacancy, office asking rent, industrial vacancy, construction pipeline — with the metro's actual current figures from your search. Give up to 5 items, newest first. "tag" must be one of: deal, capital, leasing, development, other. Only include real news with a working source URL. If the metro is small and has little CRE coverage, widen to the nearest major metro and say so in "market". Never invent a story.`;
}

export function firmPrompt(firm) {
  return `Today is ${dateLong()}. Search the web for news about the commercial real estate firm "${firm}" from the past 7 days — acquisitions, dispositions, financings, fund closes, leasing, earnings, and leadership changes.

Return ONLY a JSON object, no prose, no markdown:
{"items":[{"headline":"short factual headline","detail":"30 words max, with deal size, asset, market and counterparty where known","date":"Jul 14","tag":"deal","source":"outlet name","url":"https://..."}]}

Up to 3 items, newest first. "tag" must be one of: deal, capital, leasing, earnings, people, other. Only include real news you found in search results with a working source URL. If there is nothing from the past 7 days, return {"items":[]}. Never invent a story.`;
}
