#!/usr/bin/env node
// Pulls GitHub traffic (views + clones) for every public repo the account owns,
// accumulates it into .github/traffic-data.json (GitHub's API only exposes a
// rolling 14-day window, so history has to be persisted run over run), and
// regenerates the "Reach" section of README.md between the TRAFFIC markers.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const USERNAME = process.env.GITHUB_USERNAME;
const TOKEN = process.env.TRAFFIC_TOKEN;
const DATA_PATH = ".github/traffic-data.json";
const README_PATH = "README.md";
const CHART_PATH_LIGHT = ".github/assets/traffic-chart-light.svg";
const CHART_PATH_DARK = ".github/assets/traffic-chart-dark.svg";
const MIN_UNIQUE_VISITORS = 5;
const START_MARKER = "<!-- TRAFFIC:START -->";
const END_MARKER = "<!-- TRAFFIC:END -->";

// Validated palette slot 1 (blue) from the dataviz skill's reference palette,
// stepped for each surface so the chart matches whichever GitHub theme the
// viewer has selected.
const CHART_THEME = {
  light: {
    surface: "#fcfcfb",
    primaryInk: "#0b0b0b",
    secondaryInk: "#52514e",
    muted: "#898781",
    gridline: "#e1e0d9",
    baseline: "#c3c2b7",
    series: "#2a78d6",
  },
  dark: {
    surface: "#1a1a19",
    primaryInk: "#ffffff",
    secondaryInk: "#c3c2b7",
    muted: "#898781",
    gridline: "#2c2c2a",
    baseline: "#383835",
    series: "#3987e5",
  },
};

if (!USERNAME) {
  console.error("Missing GITHUB_USERNAME env var.");
  process.exit(1);
}
if (!TOKEN) {
  console.error("Missing TRAFFIC_TOKEN secret.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${USERNAME}-traffic-script`,
};

async function ghGet(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function listOwnedPublicRepos() {
  const repos = [];
  let page = 1;
  for (;;) {
    const batch = await ghGet(
      `https://api.github.com/user/repos?affiliation=owner&visibility=public&per_page=100&page=${page}`,
    );
    repos.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  return repos.filter((r) => !r.fork && r.owner.login === USERNAME);
}

function loadData() {
  if (existsSync(DATA_PATH)) {
    return JSON.parse(readFileSync(DATA_PATH, "utf8"));
  }
  return { startedAt: new Date().toISOString(), repos: {} };
}

// Each day's count/uniques from GitHub is an absolute value for that date, not
// a delta, so overwriting by date is idempotent no matter how often this runs.
function mergeDaily(target, entries, countKey, uniqueKey) {
  for (const e of entries) {
    const date = e.timestamp.slice(0, 10);
    target[date] = target[date] || { views: 0, uniqueViews: 0, clones: 0, uniqueClones: 0 };
    target[date][countKey] = e.count;
    target[date][uniqueKey] = e.uniques;
  }
}

function summarize(repoData) {
  let views = 0, uniqueViews = 0, clones = 0, uniqueClones = 0;
  for (const day of Object.values(repoData.daily)) {
    views += day.views || 0;
    uniqueViews += day.uniqueViews || 0;
    clones += day.clones || 0;
    uniqueClones += day.uniqueClones || 0;
  }
  return { views, uniqueViews, clones, uniqueClones };
}

function buildDailySeries(data) {
  const byDate = {};
  for (const repoData of Object.values(data.repos)) {
    for (const [date, day] of Object.entries(repoData.daily)) {
      byDate[date] = (byDate[date] || 0) + (day.uniqueViews || 0);
    }
  }
  return Object.keys(byDate)
    .sort()
    .map((date) => ({ date, value: byDate[date] }));
}

// Rounds up to a clean 1/2/5/10 step so the gridline reads as a round number.
function niceMax(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const norm = value / base;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return niceNorm * base;
}

function fmtDateShort(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function buildChartSvg(series, themeName, fmt) {
  const c = CHART_THEME[themeName];
  const width = 720;
  const height = 200;
  const padLeft = 46;
  const padRight = 16;
  const padTop = 30;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const rawMax = Math.max(1, ...series.map((p) => p.value));
  const gridMax = niceMax(rawMax);
  // 20% headroom above the tallest gridline so the highest point's end-label
  // never crowds the caption above it.
  const scaleMax = gridMax * 1.2;

  const xFor = (i) => (series.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (series.length - 1)) * plotW);
  const yFor = (v) => padTop + plotH - (v / scaleMax) * plotH;

  const linePath = series
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`)
    .join(" ");
  const baselineY = yFor(0);
  const lastIdx = series.length - 1;
  const areaPath = `${linePath} L ${xFor(lastIdx).toFixed(1)} ${baselineY.toFixed(1)} L ${xFor(0).toFixed(1)} ${baselineY.toFixed(1)} Z`;

  const last = series[lastIdx];
  const lastX = xFor(lastIdx);
  const lastY = yFor(last.value);
  const gridY = yFor(gridMax);

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Daily unique visitors over the last ${series.length} days">
<style>text { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }</style>
<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="${c.surface}"/>
<text x="${padLeft}" y="18" font-size="11" fill="${c.secondaryInk}">Unique visitors per day</text>
<line x1="${padLeft}" y1="${gridY.toFixed(1)}" x2="${width - padRight}" y2="${gridY.toFixed(1)}" stroke="${c.gridline}" stroke-width="1"/>
<text x="${padLeft - 8}" y="${(gridY + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="${c.muted}">${fmt(gridMax)}</text>
<line x1="${padLeft}" y1="${baselineY.toFixed(1)}" x2="${width - padRight}" y2="${baselineY.toFixed(1)}" stroke="${c.baseline}" stroke-width="1"/>
<path d="${areaPath}" fill="${c.series}" fill-opacity="0.1" stroke="none"/>
<path d="${linePath}" fill="none" stroke="${c.series}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="4" fill="${c.series}" stroke="${c.surface}" stroke-width="2"/>
<text x="${lastX.toFixed(1)}" y="${(lastY - 10).toFixed(1)}" text-anchor="end" font-size="12" font-weight="600" fill="${c.primaryInk}">${fmt(last.value)}</text>
<text x="${padLeft}" y="${height - 8}" font-size="10" fill="${c.muted}">${fmtDateShort(series[0].date)}</text>
<text x="${width - padRight}" y="${height - 8}" text-anchor="end" font-size="10" fill="${c.muted}">${fmtDateShort(series[lastIdx].date)}</text>
</svg>
`;
}

function renderReadme(data) {
  const summaries = Object.entries(data.repos).map(([name, repoData]) => ({
    name,
    url: repoData.url,
    ...summarize(repoData),
  }));

  const totals = summaries.reduce(
    (acc, s) => ({
      views: acc.views + s.views,
      uniqueViews: acc.uniqueViews + s.uniqueViews,
      clones: acc.clones + s.clones,
      uniqueClones: acc.uniqueClones + s.uniqueClones,
    }),
    { views: 0, uniqueViews: 0, clones: 0, uniqueClones: 0 },
  );

  const qualifying = summaries
    .filter((s) => s.uniqueViews >= MIN_UNIQUE_VISITORS)
    .sort((a, b) => b.uniqueViews - a.uniqueViews);

  // Use the earliest date actually present in the data (GitHub backfills up to
  // ~14 days on the very first call) rather than the date this script first
  // ran, so the label doesn't understate how far back the numbers go.
  let startDate = null;
  for (const repoData of Object.values(data.repos)) {
    for (const date of Object.keys(repoData.daily)) {
      if (!startDate || date < startDate) startDate = date;
    }
  }
  startDate = startDate || data.startedAt.slice(0, 10);
  const updatedDate = data.lastUpdated.slice(0, 10);
  const fmt = (n) => n.toLocaleString("en-US");

  let section = `${START_MARKER}\n`;
  section += `<h3 align="center">Reach</h3>\n\n`;

  if (summaries.length === 0) {
    section += `<p align="center"><i>Tracking starts once the traffic workflow runs for the first time, check back soon!</i></p>\n\n`;
  } else {
    section += `<p align="center">\n`;
    section += `<b>${fmt(totals.uniqueViews)}</b> unique visitors · <b>${fmt(totals.views)}</b> views · <b>${fmt(totals.uniqueClones)}</b> unique cloners · <b>${fmt(totals.clones)}</b> clones across ${summaries.length} public repos<br>\n`;
    section += `<sub>Tracking since ${startDate} · last updated ${updatedDate}</sub>\n`;
    section += `</p>\n\n`;

    const series = buildDailySeries(data);
    if (series.length >= 2) {
      mkdirSync(dirname(CHART_PATH_LIGHT), { recursive: true });
      writeFileSync(CHART_PATH_LIGHT, buildChartSvg(series, "light", fmt));
      writeFileSync(CHART_PATH_DARK, buildChartSvg(series, "dark", fmt));
      section += `<p align="center">\n`;
      section += `<picture>\n`;
      section += `<source media="(prefers-color-scheme: dark)" srcset="${CHART_PATH_DARK}">\n`;
      section += `<source media="(prefers-color-scheme: light)" srcset="${CHART_PATH_LIGHT}">\n`;
      section += `<img src="${CHART_PATH_LIGHT}" alt="Daily unique visitors chart" width="720">\n`;
      section += `</picture>\n`;
      section += `</p>\n\n`;
    }

    if (qualifying.length === 0) {
      section += `<p align="center"><i>Still gathering enough data to rank repos, check back soon.</i></p>\n\n`;
    } else {
      const top = qualifying[0];
      section += `<p align="center"><b>Most visited:</b> <a href="${top.url}"><b>${top.name}</b></a> (${fmt(top.uniqueViews)} unique visitors, ${fmt(top.views)} views)</p>\n\n`;
      section += `<div align="center">\n\n`;
      section += `| Repo | Unique Visitors | Views | Unique Cloners | Clones |\n`;
      section += `|---|---|---|---|---|\n`;
      for (const s of qualifying) {
        section += `| [${s.name}](${s.url}) | ${fmt(s.uniqueViews)} | ${fmt(s.views)} | ${fmt(s.uniqueClones)} | ${fmt(s.clones)} |\n`;
      }
      section += `\n</div>\n\n`;
      section += `<p align="center"><sub>Repos need ${MIN_UNIQUE_VISITORS}+ unique visitors to appear in the table above.</sub></p>\n\n`;
    }
  }

  section += END_MARKER;

  const readme = readFileSync(README_PATH, "utf8");
  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);

  let updated;
  if (startIdx !== -1 && endIdx !== -1) {
    updated = readme.slice(0, startIdx) + section + readme.slice(endIdx + END_MARKER.length);
  } else {
    updated = readme.trimEnd() + `\n\n${section}\n`;
  }
  writeFileSync(README_PATH, updated);
}

async function main() {
  const data = loadData();
  const repos = await listOwnedPublicRepos();

  for (const repo of repos) {
    const name = repo.name;
    data.repos[name] = data.repos[name] || { daily: {} };
    data.repos[name].url = repo.html_url;

    try {
      const views = await ghGet(`https://api.github.com/repos/${USERNAME}/${name}/traffic/views`);
      mergeDaily(data.repos[name].daily, views.views, "views", "uniqueViews");
    } catch (err) {
      console.warn(`views fetch failed for ${name}: ${err.message}`);
    }

    try {
      const clones = await ghGet(`https://api.github.com/repos/${USERNAME}/${name}/traffic/clones`);
      mergeDaily(data.repos[name].daily, clones.clones, "clones", "uniqueClones");
    } catch (err) {
      console.warn(`clones fetch failed for ${name}: ${err.message}`);
    }
  }

  data.lastUpdated = new Date().toISOString();
  mkdirSync(dirname(DATA_PATH), { recursive: true });
  writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");

  renderReadme(data);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
