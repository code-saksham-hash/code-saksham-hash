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
const MIN_UNIQUE_VISITORS = 5;
const START_MARKER = "<!-- TRAFFIC:START -->";
const END_MARKER = "<!-- TRAFFIC:END -->";

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
  section += `<h3 align="center">📊 Reach</h3>\n\n`;

  if (summaries.length === 0) {
    section += `<p align="center"><i>Tracking starts once the traffic workflow runs for the first time — check back soon!</i></p>\n\n`;
  } else {
    section += `<p align="center">\n`;
    section += `<b>${fmt(totals.uniqueViews)}</b> unique visitors · <b>${fmt(totals.views)}</b> views · <b>${fmt(totals.uniqueClones)}</b> unique cloners · <b>${fmt(totals.clones)}</b> clones — across ${summaries.length} public repos<br>\n`;
    section += `<sub>Tracking since ${startDate} · last updated ${updatedDate}</sub>\n`;
    section += `</p>\n\n`;

    if (qualifying.length === 0) {
      section += `<p align="center"><i>Still gathering enough data to rank repos — check back soon.</i></p>\n\n`;
    } else {
      const top = qualifying[0];
      section += `<p align="center"><b>🔥 Most visited:</b> <a href="${top.url}"><b>${top.name}</b></a> — ${fmt(top.uniqueViews)} unique visitors, ${fmt(top.views)} views</p>\n\n`;
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
