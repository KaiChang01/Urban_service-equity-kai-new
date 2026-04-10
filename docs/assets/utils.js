export const CLUSTER_COLORS = {
  0: "#5b8cff",
  1: "#22c55e",
  2: "#f59e0b",
  3: "#ef4444",
};

export const INDICATOR_LABELS = {
  S1: "Service Volume",
  S2: "Resolution Speed",
  S3: "Service Diversity",
  S4_pos: "Positive Services",
  S4_neg: "Negative Services",
  N1: "Housing Density Ratio",
  N2: "Space Crowding",
  N3: "Property Age & Rent Control",
  N4: "Affordability Need",
  N5: "Tenure Instability",
};

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Spread dense mid-range scores (around 0.5) using a smooth S-curve while
 * keeping endpoints pinned at 0 and 1 for stable legend semantics.
 */
function contrastMid(score01, k = 7) {
  const s = clamp(score01, 0, 1);
  const f0 = sigmoid(-0.5 * k);
  const f1 = sigmoid(0.5 * k);
  const fx = sigmoid((s - 0.5) * k);
  return clamp((fx - f0) / (f1 - f0), 0, 1);
}

function colorAt(stops, t01) {
  const t = clamp(t01, 0, 1);
  let i = 0;
  while (i < stops.length - 2 && t > stops[i + 1].t) i += 1;
  const a = stops[i];
  const b = stops[i + 1];
  const localT = (t - a.t) / (b.t - a.t);
  const ar = hexToRgb(a.color);
  const br = hexToRgb(b.color);
  return rgbToHex({
    r: Math.round(lerp(ar.r, br.r, localT)),
    g: Math.round(lerp(ar.g, br.g, localT)),
    b: Math.round(lerp(ar.b, br.b, localT)),
  });
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHex({ r, g, b }) {
  const toHex = (x) => x.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Equity ramp: red -> amber -> green.
 */
export function equityColor(score01) {
  // After midpoint-contrast warping, use extra stops near the center to
  // make 40-60 visually more separable.
  const s = contrastMid(score01);
  const stops = [
    { t: 0.0, color: "#b91c1c" },
    { t: 0.28, color: "#ef4444" },
    { t: 0.44, color: "#f97316" },
    { t: 0.5, color: "#fde047" },
    { t: 0.56, color: "#a3e635" },
    { t: 0.72, color: "#22c55e" },
    { t: 1.0, color: "#166534" },
  ];
  return colorAt(stops, s);
}

export function fmt(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

export function getQueryParam(name, fallback = null) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name) ?? fallback;
}

