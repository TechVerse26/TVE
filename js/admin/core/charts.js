// ==========================================================================
// admin/core/charts.js — tiny chart helpers. Every function returns an HTML/SVG
// string: no library, flat colours only, responsive (SVG uses a viewBox,
// the bar charts are plain flex/grid). Colours come from CSS variables.
// ==========================================================================
import { esc } from "./ui.js";

export const COLORS = {
  accent: "var(--accent-soft)", teal: "var(--accent-teal)", coral: "var(--accent-coral)",
  amber: "var(--accent-amber)", green: "var(--accent-green)", muted: "var(--text-muted)",
};

/* Axis scale: the smallest "nice" step (1, 2, 5 × 10ⁿ) that needs at most 6 intervals — so counts get whole-number ticks. */
function niceScale(maxValue) {
  const max = Math.max(1, maxValue);
  for (let pow = 0.01; pow < 1e12; pow *= 10) {
    for (const m of [1, 2, 5]) {
      const step = m * pow;
      const intervals = Math.ceil(max / step - 1e-9);
      if (intervals <= 6) return { step, intervals: Math.max(2, intervals) };
    }
  }
  return { step: max / 4, intervals: 4 };
}

/** series: [{ name, color, data: [{ x: "label", y: number }] }] — all series share the same x list. */
export function lineChart({ series, height = 220, yFormat = (v) => String(v), area = true }) {
  const n = series[0]?.data.length || 0;
  if (!n) return "";
  const W = 640, pad = { l: 40, r: 14, t: 12, b: 28 };
  const iw = W - pad.l - pad.r, ih = height - pad.t - pad.b;
  const scale = niceScale(Math.max(1, ...series.flatMap((s) => s.data.map((p) => p.y))));
  const top = scale.step * scale.intervals;
  const px = (i) => pad.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const py = (v) => pad.t + ih - (ih * v) / top;

  let grid = "";
  for (let i = 0; i <= scale.intervals; i++) {
    const v = scale.step * i, y = py(v);
    grid += `<line class="c-grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="c-tick" x="${pad.l - 6}" y="${y + 3.5}" text-anchor="end">${esc(yFormat(Math.round(v * 10) / 10))}</text>`;
  }
  const step = Math.max(1, Math.ceil(n / 6));
  let xl = "";
  series[0].data.forEach((p, i) => {
    if (i % step === 0 || i === n - 1) xl += `<text class="c-tick" x="${px(i)}" y="${height - 8}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(p.x)}</text>`;
  });

  const paths = series.map((s, si) => {
    const pts = s.data.map((p, i) => `${px(i).toFixed(1)},${py(p.y).toFixed(1)}`);
    const line = `<polyline class="c-line" fill="none" stroke="${s.color}" points="${pts.join(" ")}"/>`;
    const fill = area && si === 0 && n > 1
      ? `<polygon class="c-area" fill="${s.color}" points="${px(0).toFixed(1)},${py(0)} ${pts.join(" ")} ${px(n - 1).toFixed(1)},${py(0)}"/>` : "";
    const dots = n <= 40 ? s.data.map((p, i) => `<circle class="c-dot" cx="${px(i).toFixed(1)}" cy="${py(p.y).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.name)} · ${esc(p.x)}: ${esc(yFormat(p.y))}</title></circle>`).join("") : "";
    return fill + line + dots;
  }).join("");

  return `<svg class="chart" viewBox="0 0 ${W} ${height}" role="img" aria-label="${esc(series.map((s) => s.name).join(", "))}">${grid}${xl}${paths}</svg>${legend(series)}`;
}

export function legend(items) {
  if (items.length < 2 && !items[0]?.name) return "";
  return `<div class="legend">${items.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
}

/** bins: [{ label, value, tone? }] — vertical columns with the value above each. */
export function columns({ bins, height = 150, format = (v) => v }) {
  if (!bins.length) return "";
  const max = Math.max(1, ...bins.map((b) => b.value));
  return `<div class="cols" style="--h:${height}px">${bins.map((b) =>
    `<div class="col" title="${esc(b.label)}: ${esc(format(b.value))}"><span class="col-v">${b.value ? esc(format(b.value)) : ""}</span><span class="col-plot"><span class="col-bar ${b.tone || ""}" style="height:${Math.max(b.value ? 3 : 0, (b.value / max) * 100)}%"></span></span><span class="col-l">${esc(b.label)}</span></div>`).join("")}</div>`;
}

/** items: [{ label, value, sub?, tone? }] — ranked horizontal bars. */
export function hbars({ items, max, format = (v) => v }) {
  if (!items.length) return "";
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return `<div class="hbars">${items.map((i) =>
    `<div class="hbar"><div class="hbar-l" title="${esc(i.label)}">${esc(i.label)}${i.sub ? `<small>${esc(i.sub)}</small>` : ""}</div><div class="hbar-t"><span class="${i.tone || ""}" style="width:${Math.min(100, (i.value / top) * 100)}%"></span></div><div class="hbar-v">${esc(format(i.value))}</div></div>`).join("")}</div>`;
}

/** items: [{ label, value, color }] */
export function donut({ items, centerValue = "", centerLabel = "" }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total) return "";
  let acc = 0;
  const arcs = items.filter((i) => i.value > 0).map((i) => {
    const pct = (i.value / total) * 100;
    const el = `<circle class="d-seg" cx="18" cy="18" r="15.915" fill="none" stroke="${i.color}" stroke-width="5" stroke-dasharray="${pct.toFixed(2)} ${(100 - pct).toFixed(2)}" stroke-dashoffset="${(25 - acc).toFixed(2)}"><title>${esc(i.label)}: ${i.value}</title></circle>`;
    acc += pct;
    return el;
  }).join("");
  return `<div class="donut"><svg viewBox="0 0 36 36" role="img" aria-label="${esc(items.map((i) => `${i.label} ${i.value}`).join(", "))}"><circle cx="18" cy="18" r="15.915" fill="none" class="d-track" stroke-width="5"/>${arcs}</svg><div class="donut-c"><b>${esc(centerValue)}</b><small>${esc(centerLabel)}</small></div></div>
  <div class="legend col">${items.map((i) => `<span><i style="background:${i.color}"></i>${esc(i.label)} <b>${i.value}</b></span>`).join("")}</div>`;
}
