// Renders the benchmark from data.json. The charts are plain SVG with one
// shared renderer, so the page has no dependencies.

// ---------------------------------------------------------------------------
// Formatting

const pct = (v) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const int = (v) => (v === null ? "n/a" : Math.round(v).toLocaleString("en-US"));
const days = (v) => (v === null ? "n/a" : `${v < 10 ? v.toFixed(1) : Math.round(v)} d`);
const signed = (v, f) => (v > 0 ? "+" : v < 0 ? "−" : "") + f(Math.abs(v));
const WEEK_MS = 7 * 86400 * 1000;

/** @param {string} iso */
const weekLabel = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });


/** Rounds `max` up to a value that gives four even ticks. */
function niceMax(max) {
  if (max <= 0) return 1;
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  return step * 4;
}

const svg = (tag, attrs = {}) => {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

// ---------------------------------------------------------------------------
// Chart renderer
//
// A spec has optional stacked `bars`, optional `lines`, a value `format`, and
// an optional `trend` (series key and window length in weeks). Every series
// is { key, label, color } where color is a CSS variable name.

const tooltip = document.getElementById("tooltip");

function chart(el, weeks, releases, spec) {
  const draw = () => {
    el.replaceChildren();
    const W = Math.max(320, el.clientWidth);
    const H = W < 560 ? 220 : 260;
    const M = { l: 44, r: 8, t: 22, b: 26 };
    const iw = W - M.l - M.r;
    const ih = H - M.t - M.b;
    const n = weeks.length;
    const step = iw / n;
    const xc = (i) => M.l + step * (i + 0.5);

    const bars = spec.bars ?? [];
    const lines = spec.lines ?? [];
    const stackTotal = (w) => bars.reduce((a, s) => a + w[s.key], 0);
    const lineMax = (w) => Math.max(0, ...lines.map((s) => w[s.key] ?? 0));
    const ymax = spec.ymax ?? niceMax(Math.max(...weeks.map((w) => Math.max(stackTotal(w), lineMax(w)))));
    const y = (v) => M.t + ih - (v / ymax) * ih;

    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": spec.label });

    // Grid and y ticks.
    for (let k = 0; k <= 4; k++) {
      const v = (ymax / 4) * k;
      root.append(svg("line", { class: k ? "grid" : "baseline", x1: M.l, x2: W - M.r, y1: y(v), y2: y(v) }));
      const t = svg("text", { x: M.l - 6, y: y(v) + 4, "text-anchor": "end" });
      t.textContent = spec.tick ? spec.tick(v) : spec.format(v);
      root.append(t);
    }

    // X ticks on the first week of each quarter.
    // On narrow charts, skip a label that would touch the one before it.
    let lastQuarter = null;
    let lastX = -Infinity;
    weeks.forEach((w, i) => {
      const d = new Date(`${w.week}T00:00:00Z`);
      const q = `${d.getUTCFullYear()}-${Math.floor(d.getUTCMonth() / 3)}`;
      if (q === lastQuarter) return;
      lastQuarter = q;
      if (i === 0 && n > 8) return;
      if (xc(i) - lastX < 56) return;
      lastX = xc(i);
      const t = svg("text", { x: xc(i), y: H - 6, "text-anchor": "middle" });
      t.textContent = d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
      root.append(t);
    });

    // Model releases.
    const t0 = Date.parse(`${weeks[0].week}T00:00:00Z`);
    for (const r of releases) {
      const fi = (Date.parse(`${r.date}T00:00:00Z`) - t0) / WEEK_MS;
      if (fi < 0 || fi > n) continue;
      const x = M.l + step * fi;
      root.append(svg("line", { class: "release", x1: x, x2: x, y1: M.t - 4, y2: M.t + ih }));
      if (W >= 560) {
        const t = svg("text", { class: "release-label", x: x + 3, y: M.t - 8 });
        t.textContent = r.short;
        root.append(t);
      }
    }

    // Stacked bars, with a 2px surface gap between segments.
    const bw = Math.max(1, step * 0.72);
    weeks.forEach((w, i) => {
      let base = 0;
      for (const s of bars) {
        const v = w[s.key];
        if (!v) continue;
        const y1 = y(base + v);
        const h = Math.max(0, y(base) - y1 - (base ? 2 : 0));
        root.append(svg("rect", { x: xc(i) - bw / 2, y: y1, width: bw, height: h, fill: `var(${s.color})`, rx: Math.min(1.5, bw / 3) }));
        base += v;
      }
    });

    // Lines, broken where a value is null.
    for (const s of lines) {
      let d = "";
      let pen = false;
      weeks.forEach((w, i) => {
        const v = w[s.key];
        if (v === null || v === undefined) return void (pen = false);
        d += `${pen ? "L" : "M"}${xc(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      root.append(svg("path", { d, fill: "none", stroke: `var(${s.color})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }

    // Least-squares trend over the last `trend.weeks` weeks.
    if (spec.trend) {
      const from = Math.max(0, n - spec.trend.weeks);
      const pts = [];
      for (let i = from; i < n; i++) if (weeks[i][spec.trend.key] !== null) pts.push([i, weeks[i][spec.trend.key]]);
      if (pts.length > 1) {
        const mx = pts.reduce((a, [x]) => a + x, 0) / pts.length;
        const my = pts.reduce((a, [, v]) => a + v, 0) / pts.length;
        const b = pts.reduce((a, [x, v]) => a + (x - mx) * (v - my), 0) / pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
        const at = (x) => my + b * (x - mx);
        root.append(svg("path", { class: "trend", d: `M${xc(from)},${y(at(from))}L${xc(n - 1)},${y(at(n - 1))}` }));
      }
    }

    // Hover layer: crosshair plus tooltip, snapped to the nearest week.
    const cross = svg("line", { class: "crosshair", y1: M.t, y2: M.t + ih, visibility: "hidden" });
    root.append(cross);
    const hit = svg("rect", { x: M.l, y: 0, width: iw, height: H, fill: "transparent" });
    root.append(hit);
    const move = (ev) => {
      const box = root.getBoundingClientRect();
      const px = ((ev.clientX - box.left) / box.width) * W;
      const i = Math.min(n - 1, Math.max(0, Math.floor((px - M.l) / step)));
      cross.setAttribute("x1", xc(i));
      cross.setAttribute("x2", xc(i));
      cross.setAttribute("visibility", "visible");
      const w = weeks[i];
      const rows = [...lines, ...[...bars].reverse()]
        .map((s) => `<div class="t-row"><span><i style="background:var(${s.color})"></i>${s.label}</span><b>${spec.format(w[s.key] ?? null)}</b></div>`)
        .join("");
      tooltip.innerHTML = `<div class="t-head">Week of ${weekLabel(w.week)}</div>${rows}`;
      tooltip.hidden = false;
      const tw = tooltip.offsetWidth;
      const left = ev.clientX + 14 + tw > window.innerWidth ? ev.clientX - 14 - tw : ev.clientX + 14;
      tooltip.style.left = `${Math.max(8, left)}px`;
      tooltip.style.top = `${ev.clientY + 14}px`;
    };
    const leave = () => {
      cross.setAttribute("visibility", "hidden");
      tooltip.hidden = true;
    };
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);

    el.append(root);
  };

  draw();
  new ResizeObserver(() => draw()).observe(el);
}

// ---------------------------------------------------------------------------
// Page

const CLOSURES = [
  { key: "fixed", label: "Fixed", color: "--series-1" },
  { key: "duplicate", label: "Duplicate", color: "--series-2" },
  { key: "notPlanned", label: "Not planned", color: "--series-3" },
];
const OPENED = { key: "opened", label: "Opened", color: "--ink" };

function verdict(h, trendWeeks) {
  const pp = h.trendPerMonth * 100;
  document.getElementById("trend-weeks").textContent = trendWeeks;
  const text = pp > 0.5 ? "Improving." : pp < -0.5 ? "Getting worse." : "No measurable improvement.";
  const el = document.getElementById("verdict");
  el.textContent = text;
  el.style.color = pp > 0.5 ? "var(--good)" : pp < -0.5 ? "var(--bad)" : "";
  document.getElementById("verdict-sub").textContent =
    `The weekly fix rate moves ${signed(pp, (v) => v.toFixed(2))} percentage points per month.`;
}

function tiles(h, n) {
  const items = [
    ["Fix rate", pct(h.fixRate), `last ${n} weeks`],
    ["Opened per week", int(h.openedPerWeek), `last ${n} weeks`],
    ["Fixed per week", int(h.fixedPerWeek), `last ${n} weeks`],
    ["Open backlog", int(h.backlog), `${signed(h.backlogChange, int)} in ${n} weeks`],
  ];
  document.getElementById("tiles").innerHTML = items
    .map(([l, v, note]) => `<div class="tile"><p class="tile-label">${l}</p><p class="tile-value">${v}</p><p class="tile-note">${note}</p></div>`)
    .join("");
}

function table(weeks) {
  const cols = [
    ["Week", (w) => w.week],
    ["Opened", (w) => int(w.opened)],
    ["Fixed", (w) => int(w.fixed)],
    ["Duplicate", (w) => int(w.duplicate)],
    ["Not planned", (w) => int(w.notPlanned)],
    ["Backlog", (w) => int(w.backlog)],
    ["Fix rate", (w) => pct(w.fixRate)],
    ["30-day", (w) => pct(w.cohortFixed30)],
    ["Median", (w) => days(w.medianDaysToFix)],
  ];
  const head = `<tr>${cols.map(([c]) => `<th>${c}</th>`).join("")}</tr>`;
  const body = [...weeks].reverse().map((w) => `<tr>${cols.map(([, f]) => `<td>${f(w)}</td>`).join("")}</tr>`).join("");
  document.getElementById("table").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
}

const [data, releases] = await Promise.all([
  fetch("data.json").then((r) => r.json()),
  fetch("releases.json").then((r) => r.json()).catch(() => []),
]);
const { weeks, headline } = data;

verdict(headline, data.trendWeeks);
tiles(headline, data.headlineWeeks);
table(weeks);
document.getElementById("fetched-at").textContent = data.fetchedAt
  ? new Date(data.fetchedAt).toUTCString()
  : "unknown";
document.getElementById("legend-closures").innerHTML = [
  `<span class="line" style="--swatch:var(${OPENED.color})">${OPENED.label}</span>`,
  ...CLOSURES.map((s) => `<span style="--swatch:var(${s.color})">${s.label}</span>`),
].join("");

const $ = (id) => document.getElementById(id);
chart($("chart-rate"), weeks, releases, {
  label: "Weekly fix rate",
  lines: [{ key: "fixRate", label: "Fix rate", color: "--series-1" }],
  format: pct,
  tick: (v) => `${Math.round(v * 100)}%`,
  trend: { key: "fixRate", weeks: data.trendWeeks },
});
chart($("chart-closures"), weeks, releases, {
  label: "Issues opened and closed per week",
  bars: CLOSURES,
  lines: [OPENED],
  format: int,
});
chart($("chart-backlog"), weeks, releases, {
  label: "Open backlog",
  lines: [{ key: "backlog", label: "Open issues", color: "--series-1" }],
  format: int,
});
chart($("chart-cohort"), weeks, releases, {
  label: "Share fixed within 30 days",
  lines: [{ key: "cohortFixed30", label: "Fixed in 30 days", color: "--series-1" }],
  format: pct,
  tick: (v) => `${Math.round(v * 100)}%`,
});
chart($("chart-days"), weeks, releases, {
  label: "Median days to fix",
  lines: [{ key: "medianDaysToFix", label: "Median", color: "--series-1" }],
  format: days,
  tick: (v) => `${Math.round(v)}`,
});
