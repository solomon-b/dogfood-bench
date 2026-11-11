// Reduces data/issues.json to the weekly series that the site draws, and
// writes site/data.json.
//
// Every closure falls into exactly one bucket:
//   fixed     closed as completed by a human who is not the author
//   declined  closed as not planned or duplicate by a human who is not the author
//   self      closed by the author of the issue
//   swept     closed by a bot (stale, invalid, duplicate sweeps)
// Only "fixed" counts as evidence of engineering work.

import { readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Configuration

const DATA_FILE = new URL("../data/issues.json", import.meta.url);
const OUT_FILE = new URL("../site/data.json", import.meta.url);
const DAY = 86400;
const WEEK = 7 * DAY;
const COHORT_WINDOW = 30 * DAY;
const TREND_WEEKS = 26;
const HEADLINE_WEEKS = 4;

// ---------------------------------------------------------------------------
// Helpers

/** Start of the UTC week (Monday) that contains `t`, in Unix seconds. */
const weekStart = (t) => {
  const days = Math.floor(t / DAY);
  // 1970-01-01 was a Thursday, so Monday is day 4 modulo 7.
  return (days - ((days - 4 + 7) % 7)) * DAY;
};

/** @param {number[]} xs */
function median(xs) {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Ordinary least squares on (index, value). Returns slope per index step. */
function slope(ys) {
  const pts = ys.map((y, x) => [x, y]).filter(([, y]) => y !== null);
  const n = pts.length;
  if (n < 2) return null;
  const mx = pts.reduce((a, [x]) => a + x, 0) / n;
  const my = pts.reduce((a, [, y]) => a + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of pts) {
    num += (x - mx) * (y - my);
    den += (x - mx) ** 2;
  }
  return num / den;
}

/** @returns {"fixed" | "declined" | "self" | "swept"} */
function bucket(reason, closer) {
  if (closer === "b") return "swept";
  if (closer === "a") return "self";
  return reason === "c" ? "fixed" : "declined";
}

// ---------------------------------------------------------------------------
// Main

const db = JSON.parse(await readFile(DATA_FILE, "utf8"));
const issues = Object.values(db.issues);
const now = db.fetchedAt ? Math.floor(Date.parse(db.fetchedAt) / 1000) : Math.floor(Date.now() / 1000);

const first = weekStart(Math.min(...issues.map(([created]) => created)));
// Drop the current week, because it is incomplete.
const last = weekStart(now) - WEEK;
const weeks = [];
for (let t = first; t <= last; t += WEEK) {
  weeks.push({
    start: t,
    opened: 0,
    fixed: 0,
    declined: 0,
    self: 0,
    swept: 0,
    fixDays: [],
    cohortFixed: 0,
  });
}
const index = (t) => Math.floor((weekStart(t) - first) / WEEK);

for (const [created, closed, reason, closer] of issues) {
  const o = weeks[index(created)];
  if (o) o.opened++;
  if (closed === null) continue;
  const kind = bucket(reason, closer);
  const c = weeks[index(closed)];
  if (c) {
    c[kind]++;
    if (kind === "fixed") c.fixDays.push((closed - created) / DAY);
  }
  if (o && kind === "fixed" && closed - created <= COHORT_WINDOW) o.cohortFixed++;
}

// Backlog is the count of open issues at the end of each week.
let backlog = 0;
const series = weeks.map((w) => {
  backlog += w.opened - (w.fixed + w.declined + w.self + w.swept);
  const cohortDone = w.start + WEEK + COHORT_WINDOW <= now;
  return {
    week: new Date(w.start * 1000).toISOString().slice(0, 10),
    opened: w.opened,
    fixed: w.fixed,
    declined: w.declined,
    self: w.self,
    swept: w.swept,
    backlog,
    fixRate: w.opened ? w.fixed / w.opened : null,
    medianDaysToFix: median(w.fixDays),
    cohortFixed30: cohortDone && w.opened ? w.cohortFixed / w.opened : null,
  };
});

// ---------------------------------------------------------------------------
// Headline

const recent = series.slice(-HEADLINE_WEEKS);
const sum = (xs, k) => xs.reduce((a, x) => a + x[k], 0);
const trendWindow = series.slice(-TREND_WEEKS);
const totals = { opened: 0, fixed: 0, declined: 0, self: 0, swept: 0 };
for (const k of Object.keys(totals)) totals[k] = sum(series, k);

const headline = {
  fixRate: sum(recent, "fixed") / sum(recent, "opened"),
  openedPerWeek: sum(recent, "opened") / recent.length,
  fixedPerWeek: sum(recent, "fixed") / recent.length,
  // Percentage points per 30 days, from the weekly fix rate.
  trendPerMonth: (slope(trendWindow.map((w) => w.fixRate)) ?? 0) * (30 / 7),
  backlog: series.at(-1).backlog,
  backlogChange: series.at(-1).backlog - series.at(-1 - HEADLINE_WEEKS).backlog,
};

await writeFile(
  OUT_FILE,
  JSON.stringify({
    repo: db.repo,
    fetchedAt: db.fetchedAt,
    headlineWeeks: HEADLINE_WEEKS,
    trendWeeks: TREND_WEEKS,
    headline,
    totals,
    weeks: series,
  }),
);
console.error(`wrote ${series.length} weeks`);
