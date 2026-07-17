// marketData.js

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
      accept: "text/csv",
      "user-agent": "CRE-Daily-Brief/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `FRED ${seriesId} failed: ${response.status}`
    );
  }

  const csv = await response.text();

  const observations = csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map(line => {
      const comma = line.indexOf(",");

      if (comma === -1) {
        return null;
      }

      const date = line
        .slice(0, comma)
        .trim();

      const rawValue = line
        .slice(comma + 1)
        .replaceAll('"', "")
        .trim();

      if (
        !rawValue ||
        rawValue === "."
      ) {
        return null;
      }

      const value = Number(rawValue);

      if (!Number.isFinite(value)) {
        return null;
      }

      return {
        date,
        value,
      };
    })
    .filter(Boolean);

  if (!observations.length) {
    throw new Error(
      `No usable ${seriesId} values returned`
    );
  }

  return {
    latest:
      observations[
        observations.length - 1
      ],
    previous:
      observations.length > 1
        ? observations[
            observations.length - 2
          ]
        : null,
  };
}

function formatChange(
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
    return "UNCH";
  }

  return basisPoints > 0
    ? `▲ ${basisPoints}bp`
    : `▼ ${Math.abs(
        basisPoints
      )}bp`;
}

function optionalNumber(value) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function percentMetric({
  key,
  label,
  value,
  source,
  asOf,
}) {
  return {
    key,
    label,
    value:
      value === null
        ? "—"
        : `${value.toFixed(2)}%`,
    change: null,
    source,
    asOf: asOf || null,
  };
}

function spreadMetric({
  key,
  label,
  value,
  source,
  asOf,
}) {
  return {
    key,
    label,
    value:
      value === null
        ? "—"
        : `+${Math.round(value)}bp`,
    change: null,
    source,
    asOf: asOf || null,
  };
}

export async function fetchMarketPulse() {
  const [treasuryResult, sofrResult] =
    await Promise.allSettled([
      fetchFredSeries("DGS10"),
      fetchFredSeries("SOFR"),
    ]);

  const treasury =
    treasuryResult.status ===
    "fulfilled"
      ? treasuryResult.value
      : null;

  const sofr =
    sofrResult.status ===
    "fulfilled"
      ? sofrResult.value
      : null;

  if (!treasury) {
    console.error(
      "10Y Treasury failed:",
      treasuryResult.reason?.message
    );
  }

  if (!sofr) {
    console.error(
      "SOFR failed:",
      sofrResult.reason?.message
    );
  }

  const benchmarkAsOf =
    process.env
      .CRE_BENCHMARK_AS_OF ||
    null;

  const cmbsSource =
    process.env
      .CMBS_BENCHMARK_SOURCE ||
    "Manual CMBS benchmark";

  const capRateSource =
    process.env
      .CAP_RATE_SOURCE ||
    "CBRE U.S. Cap Rate Survey";

  return {
    rates: [
      {
        key: "treasury10Y",
        label: "10Y UST",
        value: treasury
          ? `${treasury.latest.value.toFixed(
              2
            )}%`
          : "—",
        change: treasury
          ? formatChange(
              treasury.latest,
              treasury.previous
            )
          : null,
        source:
          "Federal Reserve H.15 via FRED",
        asOf:
          treasury?.latest?.date ||
          null,
      },
      {
        key: "sofr",
        label: "SOFR",
        value: sofr
          ? `${sofr.latest.value.toFixed(
              2
            )}%`
          : "—",
        change: sofr
          ? formatChange(
              sofr.latest,
              sofr.previous
            )
          : null,
        source:
          "Federal Reserve Bank of New York via FRED",
        asOf:
          sofr?.latest?.date ||
          null,
      },
    ],

    cmbs: [
      spreadMetric({
        key: "cmbsAAA",
        label: "AAA CMBS",
        value: optionalNumber(
          process.env
            .CMBS_AAA_SPREAD_BPS
        ),
        source: cmbsSource,
        asOf: benchmarkAsOf,
      }),

      spreadMetric({
        key: "cmbsBBB",
        label: "BBB CMBS",
        value: optionalNumber(
          process.env
            .CMBS_BBB_SPREAD_BPS
        ),
        source: cmbsSource,
        asOf: benchmarkAsOf,
      }),
    ],

    capRates: [
      percentMetric({
        key: "industrialCap",
        label: "INDUSTRIAL",
        value: optionalNumber(
          process.env
            .INDUSTRIAL_CAP_RATE
        ),
        source: capRateSource,
        asOf: benchmarkAsOf,
      }),

      percentMetric({
        key: "officeCap",
        label: "OFFICE",
        value: optionalNumber(
          process.env
            .OFFICE_CAP_RATE
        ),
        source: capRateSource,
        asOf: benchmarkAsOf,
      }),

      percentMetric({
        key: "multifamilyCap",
        label: "MULTIFAMILY",
        value: optionalNumber(
          process.env
            .MULTIFAMILY_CAP_RATE
        ),
        source: capRateSource,
        asOf: benchmarkAsOf,
      }),

      percentMetric({
        key: "retailCap",
        label: "RETAIL",
        value: optionalNumber(
          process.env
            .RETAIL_CAP_RATE
        ),
        source: capRateSource,
        asOf: benchmarkAsOf,
      }),
    ],
  };
}
