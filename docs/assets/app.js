import { CLUSTER_COLORS, equityColor, clamp, INDICATOR_LABELS, fmt } from "./utils.js";

const MODE_CLUSTER = "cluster";
const MODE_EQUITY = "equity";
const MODE_LISA = "lisa";

// LISA quadrant palette. Optimized for the urban-planner use case:
// LL (underserved cluster) is the priority signal — deep red, full opacity.
// LH (struggling outlier in well-served area) is the secondary signal — orange.
// HH (well-served cluster) is green; HL (well-served outlier) muted blue.
// NS (non-significant) fades into the background.
const LISA_COLORS = {
  LL: "#dc2626", // priority: deep red
  LH: "#f59e0b", // secondary: orange
  HH: "#16a34a", // well-served: green
  HL: "#3b82f6", // outlier high: blue
  NS: "#475569", // non-significant: slate gray
};
const LISA_LABELS = {
  LL: "Low–Low (underserved cluster)",
  LH: "Low–High (struggling pocket)",
  HH: "High–High (well-served cluster)",
  HL: "High–Low (well-served outlier)",
  NS: "Not significant",
};

const DATA_BASE = new URL("../outputs/", import.meta.url);
const DATA_GEOJSON = new URL("grid_points.geojson", DATA_BASE).href;
const DATA_META = new URL("metadata.json", DATA_BASE).href;
const DATA_SUMMARY = new URL("cluster_summary.csv", DATA_BASE).href;
const DATA_Z = new URL("cluster_feature_zscores.csv", DATA_BASE).href;
const DATA_NBHD = new URL("sf_neighborhoods.geojson", DATA_BASE).href;

const els = {
  colorMode: document.getElementById("colorMode"),
  clusterFilter: document.getElementById("clusterFilter"),
  equityMin: document.getElementById("equityMin"),
  equityMax: document.getElementById("equityMax"),
  applyFilters: document.getElementById("applyFilters"),
  legend: document.getElementById("legend"),
  dataPath: document.getElementById("dataPath"),
  selPanelTitle: document.getElementById("selPanelTitle"),
  selectionEmpty: document.getElementById("selectionEmpty"),
  selection: document.getElementById("selection"),
  selGridId: document.getElementById("selGridId"),
  // cluster mode side panel
  selClusterSection: document.getElementById("selClusterSection"),
  selCluster: document.getElementById("selCluster"),
  selClusterN: document.getElementById("selClusterN"),
  selClusterNeighborhood: document.getElementById("selClusterNeighborhood"),
  selClusterEquityMean: document.getElementById("selClusterEquityMean"),
  selClusterTop: document.getElementById("selClusterTop"),
  clusterLink: document.getElementById("clusterLink"),
  // equity mode side panel
  selEquitySection: document.getElementById("selEquitySection"),
  selEquity: document.getElementById("selEquity"),
  selEquityNeighborhood: document.getElementById("selEquityNeighborhood"),
  selTop: document.getElementById("selTop"),
  // LISA mode side panel
  selLisaSection: document.getElementById("selLisaSection"),
  selLisaQuadrant: document.getElementById("selLisaQuadrant"),
  selLisaEquity: document.getElementById("selLisaEquity"),
  selLisaNeighborhood: document.getElementById("selLisaNeighborhood"),
  selLisaI: document.getElementById("selLisaI"),
  selLisaP: document.getElementById("selLisaP"),
  clearSelection: document.getElementById("clearSelection"),
  // bottom report section
  reportCluster: document.getElementById("reportCluster"),
  reportAnchor: document.getElementById("report"),
  direNeeds: document.getElementById("direNeeds"),
  priorityQueue: document.getElementById("priorityQueue"),
  needsAndInterventions: document.getElementById("needsAndInterventions"),
};

els.dataPath.textContent = "outputs/grid_points.geojson";

let meta = null;
let map = null;
let layer = null;
let nbhdLayer = null;
let nbhdGeo = null;
let geo = null;
let summaryRows = [];
let zRows = [];
let zChart = null;
let selectedProps = null;
const EQUITY_HIST_BINS_MAX = 10;
let sortedScores = [];

// Chart.js inline plugins
const zeroLinePlugin = {
  id: "zeroLine",
  afterDraw(chart) {
    const { ctx, scales: { x, y } } = chart;
    const xPos = x.getPixelForValue(0);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xPos, y.top);
    ctx.lineTo(xPos, y.bottom);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  },
};

const barValuePlugin = {
  id: "barValue",
  afterDatasetsDraw(chart) {
    const { ctx, scales: { x } } = chart;
    const zero = x.getPixelForValue(0);
    chart.data.datasets.forEach((dataset, i) => {
      chart.getDatasetMeta(i).data.forEach((bar, index) => {
        const value = dataset.data[index];
        if (value === undefined || value === null) return;
        const label = `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
        ctx.save();
        ctx.fillStyle = "rgba(232,234,240,0.9)";
        ctx.font = "bold 10px ui-sans-serif,system-ui,sans-serif";
        ctx.textBaseline = "middle";
        if (value >= 0) {
          ctx.textAlign = "left";
          ctx.fillText(label, Math.max(bar.x, zero) + 4, bar.y);
        } else {
          ctx.textAlign = "right";
          ctx.fillText(label, Math.min(bar.x, zero) - 4, bar.y);
        }
        ctx.restore();
      });
    });
  },
};

function clusterName(c) {
  if (!meta?.config?.cluster_names) return `Cluster ${c}`;
  return meta.config.cluster_names[String(c)] ?? meta.config.cluster_names[c] ?? `Cluster ${c}`;
}

function passesFilters(props) {
  const cf = els.clusterFilter.value;
  if (cf !== "all" && String(props.cluster) !== cf) return false;
  const emin = clamp(Number(els.equityMin.value), 0, 100);
  const emax = clamp(Number(els.equityMax.value), 0, 100);
  const pct = rawToPercent(Number(props.equity_score));
  if (Number.isFinite(pct) && (pct < Math.min(emin, emax) || pct > Math.max(emin, emax))) return false;
  return true;
}

function selectedEquityRange() {
  const a = clamp(Number(els.equityMin.value), 0, 100);
  const b = clamp(Number(els.equityMax.value), 0, 100);
  return [Math.min(a, b), Math.max(a, b)];
}

function histogramBinsForSpan(span) {
  return Math.max(4, Math.min(EQUITY_HIST_BINS_MAX, Math.round(span * 2)));
}

function fmtBinEdge(v, span) {
  if (span <= 2) return v.toFixed(2);
  if (span <= 10) return v.toFixed(1);
  return v.toFixed(0);
}

function rawToPercent(score) {
  const n = sortedScores.length;
  if (!n || !Number.isFinite(score)) return null;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sortedScores[mid] < score) lo = mid + 1;
    else hi = mid;
  }
  return Math.min(99, Math.floor((lo / n) * 100));
}

function formatTop3(zRow) {
  if (!zRow) return "—";
  const lines = Object.entries(zRow)
    .filter(([k]) => k !== "cluster")
    .map(([k, v]) => ({ k, z: Number(v) }))
    .filter((d) => Number.isFinite(d.z))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3)
    .map((d) => `${INDICATOR_LABELS[d.k] ?? d.k} (${d.z >= 0 ? "+" : ""}${d.z.toFixed(2)})`);
  return lines.length ? lines.join("<br>") : "—";
}

function markerStyle(props) {
  const mode = els.colorMode.value;
  if (mode === MODE_CLUSTER) {
    return { color: CLUSTER_COLORS[props.cluster] ?? "#888", fillColor: CLUSTER_COLORS[props.cluster] ?? "#888" };
  }
  if (mode === MODE_LISA) {
    const q = props.lisa_quadrant ?? "NS";
    const c = LISA_COLORS[q] ?? LISA_COLORS.NS;
    return { color: c, fillColor: c };
  }
  const pct = rawToPercent(Number(props.equity_score));
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  const c = equityColor(clamp(((pct ?? 0) - emin) / span, 0, 1));
  return { color: c, fillColor: c };
}

// Raw equity-score distribution for the legend.
// `sortedScores` holds the ascending raw equity_score values across the dataset.
// v19: zoom the histogram into the underservice end of the distribution (40–50).
// This range surfaces the lower tail where intervention effort matters most;
// the upper end (well-served cells) is summarized via the LISA legend.
const HIST_LO = 40;
const HIST_HI = 50;

function getRawEquityHistogram(scores, bins) {
  if (!scores?.length) return null;
  const lo = HIST_LO;
  const hi = HIST_HI;
  const span = Math.max(1e-9, hi - lo);
  const counts = Array.from({ length: bins }, () => 0);
  let inWindow = 0;
  for (const s of scores) {
    if (s < lo || s > hi) continue;
    inWindow += 1;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(((s - lo) / span) * bins)));
    counts[idx] += 1;
  }
  return { counts, lo, hi, span, inWindow, total: scores.length };
}

function renderEquityHistogram() {
  if (!sortedScores?.length) {
    return `<div class="legendHint">Distribution loading...</div>`;
  }
  const bins = EQUITY_HIST_BINS_MAX;
  const hist = getRawEquityHistogram(sortedScores, bins);
  if (!hist) return `<div class="legendHint">No equity scores available.</div>`;
  const { counts, lo, hi, span, inWindow, total } = hist;
  const maxCount = Math.max(...counts, 1);

  // Translate the user-selected percentile range into raw-score thresholds so
  // we can shade the bars that are inside the filter (clipped to the 40–50 window).
  const [pmin, pmax] = selectedEquityRange();
  const pctToRaw = (p) => {
    const idx = Math.min(sortedScores.length - 1, Math.max(0, Math.round((p / 100) * (sortedScores.length - 1))));
    return sortedScores[idx];
  };
  const rawMin = pctToRaw(pmin);
  const rawMax = pctToRaw(pmax);

  const fmtRaw = (v) => v.toFixed(1);

  const bars = counts.map((count, i) => {
    const binLo = lo + i * (span / bins);
    const binHi = lo + (i + 1) * (span / bins);
    const inRange = binHi >= rawMin && binLo <= rawMax;
    const h = Math.max(3, Math.round((count / maxCount) * 32));
    const cls = inRange ? "histBar histBar--in" : "histBar histBar--out";
    return `<div class="${cls}" style="height:${h}px" title="${fmtRaw(binLo)}–${fmtRaw(binHi)}: ${count.toLocaleString()}"></div>`;
  }).join("");

  const mid = lo + span / 2;

  return `
    <div class="histWrap">
      <div class="histHeader">
        <span>Raw score (${HIST_LO}–${HIST_HI})</span>
        <span>${inWindow.toLocaleString()} / ${total.toLocaleString()}</span>
      </div>
      <div class="histBars">${bars}</div>
      <div class="histLabels">
        <span>${fmtRaw(lo)}</span>
        <span>${fmtRaw(mid)}</span>
        <span>${fmtRaw(hi)}</span>
      </div>
    </div>
  `;
}

function renderLegend() {
  const mode = els.colorMode.value;
  if (mode === MODE_CLUSTER) {
    els.legend.innerHTML = `
      <div class="legendTitle">Legend: Cluster</div>
      ${[0, 1, 2, 3].map((c) => `
        <div class="legendRow">
          <div class="swatch" style="background:${CLUSTER_COLORS[c]}"></div>
          <div>${clusterName(c)}</div>
        </div>`).join("")}
    `;
    return;
  }
  if (mode === MODE_LISA) {
    // Count quadrants from currently-loaded geo.
    const counts = { LL: 0, LH: 0, HH: 0, HL: 0, NS: 0 };
    for (const f of (geo?.features ?? [])) {
      const q = f.properties?.lisa_quadrant ?? "NS";
      counts[q] = (counts[q] ?? 0) + 1;
    }
    const order = ["LL", "LH", "HH", "HL", "NS"];
    els.legend.innerHTML = `
      <div class="legendTitle">Legend: LISA quadrant</div>
      ${order.map((q) => `
        <div class="legendRow">
          <div class="swatch" style="background:${LISA_COLORS[q]}"></div>
          <div style="flex:1">${LISA_LABELS[q]}</div>
          <div style="color:var(--muted);font-size:11px">${counts[q].toLocaleString()}</div>
        </div>`).join("")}
      <div class="legendHint">Significance: p &le; 0.05 (KNN k=8, 999 perms)</div>
    `;
    return;
  }
  const [emin, emax] = selectedEquityRange();
  els.legend.innerHTML = `
    <div class="legendTitle">Legend: Equity score (%)</div>
    <div class="ramp"></div>
    <div class="rampLabels"><span>${emin.toFixed(0)}</span><span>${((emin + emax) / 2).toFixed(0)}</span><span>${emax.toFixed(0)}</span></div>
    ${renderEquityHistogram()}
    <div class="legendHint">Red = lower (within selected range)</div>
  `;
}

function clearSelection() {
  selectedProps = null;
  els.selectionEmpty.classList.remove("hidden");
  els.selection.classList.add("hidden");
}

function setSelection(props) {
  selectedProps = props;
  els.selectionEmpty.classList.add("hidden");
  els.selection.classList.remove("hidden");
  els.selGridId.textContent = props.grid_id ?? "—";

  const mode = els.colorMode.value;
  const zRow = zRows.find((r) => String(r.cluster) === String(props.cluster));

  const neighborhood = props.neighborhood && String(props.neighborhood).trim()
    ? String(props.neighborhood)
    : "—";

  // hide all mode-specific sections by default
  els.selClusterSection.classList.add("hidden");
  els.selEquitySection.classList.add("hidden");
  if (els.selLisaSection) els.selLisaSection.classList.add("hidden");

  if (mode === MODE_CLUSTER) {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Cluster Report";
    els.selClusterSection.classList.remove("hidden");

    els.selCluster.textContent = clusterName(props.cluster);
    const row = summaryRows.find((r) => String(r.cluster) === String(props.cluster));
    els.selClusterN.textContent = row?.n_grids_scored?.toLocaleString?.() ?? "—";
    if (els.selClusterNeighborhood) els.selClusterNeighborhood.textContent = neighborhood;
    els.selClusterEquityMean.textContent = row ? fmt(row.equity_mean, 2) : "—";
    els.selClusterTop.innerHTML = formatTop3(zRow);

    if (els.clusterLink) els.clusterLink.href = "#report";
    setReportCluster(props.cluster);
    // Auto-scroll disabled (v12): user can use the "View cluster report" button instead.
  } else if (mode === MODE_LISA) {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "LISA Report";
    if (els.selLisaSection) els.selLisaSection.classList.remove("hidden");

    const q = props.lisa_quadrant ?? "NS";
    if (els.selLisaQuadrant) {
      els.selLisaQuadrant.textContent = LISA_LABELS[q] ?? q;
      els.selLisaQuadrant.style.background = (LISA_COLORS[q] ?? LISA_COLORS.NS) + "33";
      els.selLisaQuadrant.style.borderColor = LISA_COLORS[q] ?? LISA_COLORS.NS;
      els.selLisaQuadrant.style.color = LISA_COLORS[q] ?? LISA_COLORS.NS;
    }
    const raw = Number(props.equity_score);
    if (els.selLisaEquity) {
      els.selLisaEquity.textContent = Number.isFinite(raw) ? raw.toFixed(2) : "—";
    }
    if (els.selLisaNeighborhood) els.selLisaNeighborhood.textContent = neighborhood;
    if (els.selLisaI) {
      const li = Number(props.lisa_I);
      els.selLisaI.textContent = Number.isFinite(li) ? li.toFixed(3) : "—";
    }
    if (els.selLisaP) {
      const p = Number(props.lisa_p);
      els.selLisaP.textContent = Number.isFinite(p) ? p.toFixed(3) : "—";
    }
  } else {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Equity Score Report";
    els.selEquitySection.classList.remove("hidden");

    const raw = Number(props.equity_score);
    const pct = rawToPercent(raw);
    els.selEquity.textContent = Number.isFinite(raw)
      ? `${raw.toFixed(2)}${pct !== null ? ` (${pct}th pctile)` : ""}`
      : "—";
    if (els.selEquityNeighborhood) els.selEquityNeighborhood.textContent = neighborhood;
    els.selTop.innerHTML = formatTop3(zRow);
  }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} loading ${url}`);
  return r.json();
}

function parseCsv(url) {
  return new Promise((resolve, reject) => {
    Papa.parse(url, {
      download: true, header: true, dynamicTyping: true, skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(err),
    });
  });
}

function renderZChart(c) {
  const row = zRows.find((r) => String(r.cluster) === String(c));
  if (!row) return;

  // All features sorted ascending (chart renders bottom-to-top, so most negative appears at top)
  const items = Object.keys(row)
    .filter((k) => k !== "cluster" && row[k] !== null && row[k] !== undefined && !Number.isNaN(row[k]))
    .map((k) => ({ k, z: Number(row[k]) }))
    .filter((d) => Number.isFinite(d.z))
    .sort((a, b) => a.z - b.z);

  const labels = items.map((d) => INDICATOR_LABELS[d.k] ?? d.k);
  const data = items.map((d) => d.z);
  const colors = items.map((d) => (d.z >= 0 ? "rgba(34,197,94,.55)" : "rgba(239,68,68,.55)"));
  const borders = items.map((d) => (d.z >= 0 ? "rgba(34,197,94,1)" : "rgba(239,68,68,1)"));

  const ctx = document.getElementById("zChart");
  if (!ctx) return;
  if (zChart) zChart.destroy();
  zChart = new Chart(ctx, {
    type: "bar",
    plugins: [zeroLinePlugin, barValuePlugin],
    data: {
      labels,
      datasets: [{
        label: "z-score vs city avg",
        data,
        backgroundColor: colors,
        borderColor: borders,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => {
              const v = item.parsed.x;
              const dir = v >= 0 ? "above" : "below";
              return ` ${v >= 0 ? "+" : ""}${v.toFixed(3)} σ ${dir} city average`;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,.08)" },
          ticks: {
            color: "rgba(232,234,240,.75)",
            callback: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}σ`,
          },
          title: { display: true, text: "Standard deviations from city average", color: "rgba(232,234,240,.5)", font: { size: 11 } },
        },
        y: {
          grid: { display: false },
          ticks: { color: "rgba(232,234,240,.9)", font: { size: 11 } },
        },
      },
    },
  });
}

function renderHeuristics(c, target = els.needsAndInterventions) {
  const h = meta?.heuristics?.[String(c)] ?? meta?.heuristics?.[c];
  if (!h) {
    if (target) target.textContent = "—";
    return;
  }
  if (!target) return;

  const priorityClass = (p) => {
    const pp = String(p ?? "").toUpperCase();
    if (pp === "CRITICAL") return "critical";
    if (pp === "HIGH") return "high";
    return "med";
  };
  // Rank order: CRITICAL > HIGH > MED (lower number = higher intensity, sorted first)
  const priorityRank = (p) => {
    const pp = String(p ?? "").toUpperCase();
    if (pp === "CRITICAL") return 0;
    if (pp === "HIGH") return 1;
    return 2;
  };

  // Sort needs by priority intensity (descending intensity → ascending rank).
  // Stable sort preserves original order within same priority.
  const needs = (h.needs ?? []).slice().sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  if (!needs.length) { target.textContent = "—"; return; }

  target.innerHTML = needs.map((n, i) => {
    const pcls = priorityClass(n.priority);
    const actions = (n.actions ?? []);
    const actionsHTML = actions.length
      ? actions.map((a) => `<li class="niAction"><span class="niBullet" aria-hidden="true"></span><span class="niActionText">${a}</span></li>`).join("")
      : `<li class="niAction niActionEmpty">No interventions defined</li>`;
    const meta = [
      n.owner ? `<span class="niMetaItem"><span class="niMetaK">Owner</span><span class="niMetaV">${n.owner}</span></span>` : "",
      n.kpi   ? `<span class="niMetaItem"><span class="niMetaK">KPI</span><span class="niMetaV">${n.kpi}</span></span>`   : "",
    ].filter(Boolean).join("");
    return `
      <article class="niBlock niBlock--${pcls}">
        <header class="niBlock__head">
          <span class="niBlock__rank">${n.rank ?? (i + 1)}</span>
          <div class="niBlock__headText">
            <div class="niBlock__titleRow">
              <h3 class="niBlock__title">${n.title ?? "Need"}</h3>
              <span class="pill ${pcls}">${String(n.priority ?? "MED").toUpperCase()}</span>
            </div>
            ${n.desc ? `<p class="niBlock__desc">${n.desc}</p>` : ""}
            ${meta ? `<div class="niBlock__meta">${meta}</div>` : ""}
          </div>
        </header>
        <div class="niBlock__body">
          <div class="niBlock__interventionsLabel">
            <span class="niDot"></span>Interventions
          </div>
          <ul class="niBlock__interventions">${actionsHTML}</ul>
        </div>
      </article>
    `;
  }).join("");
}

function setReportCluster(c) {
  const v = String(c);
  if (els.reportCluster) els.reportCluster.value = v;
  renderZChart(v);
  renderHeuristics(v);
}

// ===== v21: LISA underserved groups + low-equity neighborhoods + cell lookup =====
//
// Three views, top to bottom in the report column:
//   (a) renderLisaUnderservedGroups — LL + LH cells grouped by quadrant > nbhd,
//       with grid_id and a lazy-loaded street descriptor per cell.
//   (b) renderLowEquityCongregations — ranked-bar table of neighborhoods, with
//       a click-to-expand sample of underserved cells per row.
//   (c) setupCellLookup — input box: type a grid_id, get a street-level
//       location via OpenStreetMap Nominatim reverse geocoding (cached).

// ----- shared geocoding utilities -----
const STREET_CACHE_KEY = "useq:streetCache:v1";
let streetCache = (() => {
  try { return JSON.parse(localStorage.getItem(STREET_CACHE_KEY) || "{}"); }
  catch { return {}; }
})();
function persistStreetCache() {
  try { localStorage.setItem(STREET_CACHE_KEY, JSON.stringify(streetCache)); } catch {}
}

// Throttle to ~1 req/sec to comply with Nominatim usage policy
let _geocodeQueue = Promise.resolve();
function reverseGeocode(lat, lon) {
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (streetCache[key]) return Promise.resolve(streetCache[key]);
  _geocodeQueue = _geocodeQueue.then(() => new Promise((res) => setTimeout(res, 1100)));
  return _geocodeQueue.then(async () => {
    if (streetCache[key]) return streetCache[key]; // race
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
    const resp = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!resp.ok) throw new Error(`nominatim ${resp.status}`);
    const j = await resp.json();
    const a = j.address || {};
    const road = a.road || a.pedestrian || a.footway || a.path || "";
    const xstreet = a.cycleway || a["road:reference"] || "";
    const nbhd = a.neighbourhood || a.suburb || a.quarter || "";
    const desc = road
      ? `${road}${nbhd ? ` (${nbhd})` : ""}`
      : (j.display_name || "").split(",").slice(0, 2).join(", ");
    const out = { road, neighborhood: nbhd, display: desc, full: j.display_name || "" };
    streetCache[key] = out;
    persistStreetCache();
    return out;
  });
}

function streetDescriptorFor(props) {
  const lat = Number(props?.lat ?? props?.latitude);
  const lon = Number(props?.lon ?? props?.longitude);
  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  return streetCache[key]?.display || null;
}

function lazyAttachStreet(el, lat, lon) {
  // IntersectionObserver: only fetch when scrolled into view
  if (!el || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const trigger = () => {
    reverseGeocode(lat, lon)
      .then((s) => { if (s?.display) el.textContent = s.display; })
      .catch(() => { el.textContent = `(${lat.toFixed(4)}, ${lon.toFixed(4)})`; });
  };
  if (!("IntersectionObserver" in window)) { trigger(); return; }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { io.unobserve(e.target); trigger(); }
    }
  }, { rootMargin: "200px" });
  io.observe(el);
}

// ----- LISA underserved groups -----
function renderLisaUnderservedGroups() {
  const target = document.getElementById("lisaGroups");
  if (!target) return;
  if (!geo?.features?.length) { target.textContent = "—"; return; }

  // Collect LL + LH cells, grouped by quadrant then neighborhood.
  const byQuad = { LL: new Map(), LH: new Map() };
  for (const f of geo.features) {
    const q = f.properties?.lisa_quadrant;
    if (q !== "LL" && q !== "LH") continue;
    const name = (f.properties?.neighborhood ?? "").trim() || "(unknown)";
    if (!byQuad[q].has(name)) byQuad[q].set(name, []);
    byQuad[q].get(name).push(f);
  }
  const totals = { LL: Array.from(byQuad.LL.values()).reduce((a, l) => a + l.length, 0),
                   LH: Array.from(byQuad.LH.values()).reduce((a, l) => a + l.length, 0) };

  if (totals.LL + totals.LH === 0) { target.textContent = "No statistically significant low-equity cells."; return; }

  const renderQuad = (qcode, qlabel, qcolor, sub) => {
    const groups = Array.from(byQuad[qcode].entries())
      .map(([name, list]) => ({ name, list }))
      .sort((a, b) => b.list.length - a.list.length);
    const nbhdHTML = groups.map((g) => {
      const cellsHTML = g.list
        .sort((a, b) => Number(a.properties.equity_score) - Number(b.properties.equity_score))
        .map((f) => {
          const p = f.properties;
          const lat = Number(f.geometry?.coordinates?.[1]);
          const lon = Number(f.geometry?.coordinates?.[0]);
          const eq = Number(p.equity_score);
          const cached = streetDescriptorFor({ lat, lon });
          return `
            <li class="lisaCell" data-lat="${lat}" data-lon="${lon}">
              <span class="lisaCellId">#${p.grid_id ?? "?"}</span>
              <span class="lisaCellEq">eq ${Number.isFinite(eq) ? eq.toFixed(2) : "—"}</span>
              <span class="lisaCellStreet" data-street="1">${cached || `(${lat.toFixed(4)}, ${lon.toFixed(4)})`}</span>
            </li>`;
        }).join("");
      return `
        <details class="lisaNbhd" ${groups.indexOf(g) < 2 ? "open" : ""}>
          <summary class="lisaNbhdHead">
            <span class="lisaNbhdName">${g.name}</span>
            <span class="lisaNbhdCount">${g.list.length} ${g.list.length === 1 ? "cell" : "cells"}</span>
          </summary>
          <ul class="lisaCellList">${cellsHTML}</ul>
        </details>`;
    }).join("");
    return `
      <div class="lisaQuadGroup">
        <div class="lisaQuadHead" style="--quadAccent:${qcolor}">
          <span class="lisaQuadCode">${qcode}</span>
          <span class="lisaQuadLabel">${qlabel}</span>
          <span class="lisaQuadCount">${totals[qcode]} cells &middot; ${groups.length} neighborhoods</span>
        </div>
        <div class="lisaQuadSub">${sub}</div>
        <div class="lisaQuadBody">${nbhdHTML || "<div class='lisaEmpty'>None</div>"}</div>
      </div>`;
  };

  target.innerHTML = `
    ${renderQuad("LL", "Underserved clusters", "#dc2626", "Low equity surrounded by low equity — true underserved zones; highest priority.")}
    ${renderQuad("LH", "Struggling pockets", "#f59e0b", "Low equity sitting next to higher equity — isolated pockets within otherwise well-served areas.")}
  `;

  // Trigger lazy reverse-geocoding for the first ~30 visible cells
  target.querySelectorAll(".lisaCell").forEach((li) => {
    const street = li.querySelector(".lisaCellStreet[data-street='1']");
    if (!street || street.textContent.indexOf("(") !== 0) return; // already resolved
    const lat = Number(li.dataset.lat);
    const lon = Number(li.dataset.lon);
    lazyAttachStreet(street, lat, lon);
  });
}

// ----- Cell lookup widget -----
function setupCellLookup() {
  const input = document.getElementById("cellLookupInput");
  const btn = document.getElementById("cellLookupBtn");
  const out = document.getElementById("cellLookupResult");
  if (!input || !btn || !out) return;

  const findCell = (idStr) => {
    const id = String(idStr).trim();
    if (!id) return null;
    return geo?.features?.find((f) => String(f.properties?.grid_id) === id) || null;
  };

  const doLookup = async () => {
    out.classList.remove("emptyResult");
    const f = findCell(input.value);
    if (!f) {
      out.innerHTML = `<div class="lookupErr">No grid cell found for "<b>${input.value || "—"}</b>". Try a numeric grid_id from the map.</div>`;
      return;
    }
    const p = f.properties;
    const lat = Number(f.geometry?.coordinates?.[1]);
    const lon = Number(f.geometry?.coordinates?.[0]);
    const eq = Number(p.equity_score);
    const cluster = clusterName(p.cluster);
    const quad = p.lisa_quadrant || "—";
    out.innerHTML = `
      <div class="lookupHead">
        <div class="lookupGridId">Grid #${p.grid_id ?? "?"}</div>
        <div class="lookupBadges">
          <span class="lookupBadge">${cluster}</span>
          <span class="lookupBadge lookupQuad lookupQuad--${quad}">LISA: ${quad}</span>
          <span class="lookupBadge">Equity ${Number.isFinite(eq) ? eq.toFixed(2) : "—"}</span>
        </div>
      </div>
      <div class="lookupGrid">
        <div class="lookupKv"><div class="lookupK">Neighborhood</div><div class="lookupV">${(p.neighborhood ?? "—") || "—"}</div></div>
        <div class="lookupKv"><div class="lookupK">Coordinates</div><div class="lookupV">${lat.toFixed(5)}°N, ${Math.abs(lon).toFixed(5)}°W</div></div>
        <div class="lookupKv lookupKv--street"><div class="lookupK">Street descriptor</div><div class="lookupV" id="lookupStreet">resolving via OpenStreetMap…</div></div>
      </div>
      <div class="lookupActions">
        <a class="btn secondary" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=18/${lat}/${lon}">Open on OSM</a>
        <a class="btn secondary" target="_blank" rel="noopener" href="https://www.google.com/maps?q=${lat},${lon}">Open in Google Maps</a>
      </div>
    `;
    try {
      const s = await reverseGeocode(lat, lon);
      const el = document.getElementById("lookupStreet");
      if (el) el.textContent = s.display || s.full || "(unresolved)";
    } catch (err) {
      const el = document.getElementById("lookupStreet");
      if (el) el.textContent = `(geocoding failed: ${err.message || err})`;
    }
  };

  btn.addEventListener("click", doLookup);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(); });
}

// ----- Low Equity Neighborhoods (renamed from "Top areas with congregations of low equity") -----
function renderLowEquityCongregations() {
  const target = document.getElementById("lowEquityCongregations");
  if (!target) return;
  if (!geo?.features?.length) { target.textContent = "—"; return; }

  // Group LL + LH cells by neighborhood; count + average equity per neighborhood.
  const byNbhd = new Map();
  for (const f of geo.features) {
    const q = f.properties?.lisa_quadrant;
    if (q !== "LL" && q !== "LH") continue;
    const name = (f.properties?.neighborhood ?? "").trim() || "(unknown)";
    if (!byNbhd.has(name)) byNbhd.set(name, { name, ll: 0, lh: 0, scores: [] });
    const e = byNbhd.get(name);
    if (q === "LL") e.ll += 1; else e.lh += 1;
    const eq = Number(f.properties?.equity_score);
    if (Number.isFinite(eq)) e.scores.push(eq);
  }
  const ranked = Array.from(byNbhd.values())
    .map((e) => ({
      ...e,
      total: e.ll + e.lh,
      meanScore: e.scores.length ? e.scores.reduce((a, b) => a + b, 0) / e.scores.length : NaN,
    }))
    .filter((e) => e.total > 0)
    .sort((a, b) => (b.ll * 2 + b.lh) - (a.ll * 2 + a.lh)) // LL counts double — true clusters > pockets
    .slice(0, 10);

  if (!ranked.length) { target.textContent = "No statistically significant low-equity cells found."; return; }

  const maxTotal = Math.max(...ranked.map((r) => r.total));

  target.innerHTML = `
    <div class="congHead">
      <div class="congCol congCol--rank">#</div>
      <div class="congCol congCol--name">Neighborhood</div>
      <div class="congCol congCol--bar">Underserved cells</div>
      <div class="congCol congCol--n">LL</div>
      <div class="congCol congCol--n">LH</div>
      <div class="congCol congCol--score">Mean eq.</div>
    </div>
    ${ranked.map((r, i) => {
      const llW = (r.ll / maxTotal) * 100;
      const lhW = (r.lh / maxTotal) * 100;
      return `
        <button type="button" class="congRow" data-nbhd="${encodeURIComponent(r.name)}">
          <div class="congCol congCol--rank">${i + 1}</div>
          <div class="congCol congCol--name">${r.name}</div>
          <div class="congCol congCol--bar">
            <div class="congBarTrack">
              <div class="congBarLL" style="width:${llW}%" title="LL: ${r.ll}"></div>
              <div class="congBarLH" style="width:${lhW}%" title="LH: ${r.lh}"></div>
            </div>
          </div>
          <div class="congCol congCol--n congCol--n-ll">${r.ll}</div>
          <div class="congCol congCol--n congCol--n-lh">${r.lh}</div>
          <div class="congCol congCol--score">${Number.isFinite(r.meanScore) ? r.meanScore.toFixed(2) : "—"}</div>
        </button>`;
    }).join("")}
    <div class="congLegend">
      <span class="congSwatch congSwatch--ll"></span> LL = significant low-equity cluster
      &nbsp;&nbsp;
      <span class="congSwatch congSwatch--lh"></span> LH = low-equity pocket in well-served surroundings
    </div>
  `;

  // Wire up click-to-expand: clicking a neighborhood row reveals a concise
  // sample of its underserved cells with a street descriptor (LL first, then
  // worst LH cells, capped at ~6 per neighborhood for brevity).
  target.querySelectorAll(".congRow[data-nbhd]").forEach((row) => {
    row.addEventListener("click", () => {
      const name = decodeURIComponent(row.dataset.nbhd);
      target.querySelectorAll(".congRow").forEach((r) => r.classList.toggle("isActive", r === row));
      renderLowEquityCellsForNeighborhood(name);
    });
  });
}

function renderLowEquityCellsForNeighborhood(name) {
  const out = document.getElementById("lowEquityCells");
  if (!out) return;
  const cells = geo.features.filter((f) => {
    const q = f.properties?.lisa_quadrant;
    if (q !== "LL" && q !== "LH") return false;
    const n = (f.properties?.neighborhood ?? "").trim() || "(unknown)";
    return n === name;
  });
  if (!cells.length) { out.innerHTML = `<div class="emptyText">No underserved cells found in ${name}.</div>`; return; }

  // Pick representative samples: all LL cells (always priority) + lowest-equity LH cells, cap at 6.
  const ll = cells.filter((f) => f.properties.lisa_quadrant === "LL")
    .sort((a, b) => Number(a.properties.equity_score) - Number(b.properties.equity_score));
  const lh = cells.filter((f) => f.properties.lisa_quadrant === "LH")
    .sort((a, b) => Number(a.properties.equity_score) - Number(b.properties.equity_score));
  const sample = ll.concat(lh).slice(0, 6);

  out.innerHTML = `
    <div class="lowEqTitle">Sample of underserved cells in <b>${name}</b>
      <span class="lowEqCount">(${cells.length} total &middot; showing ${sample.length})</span>
    </div>
    <ul class="lowEqList">
      ${sample.map((f) => {
        const p = f.properties;
        const lat = Number(f.geometry?.coordinates?.[1]);
        const lon = Number(f.geometry?.coordinates?.[0]);
        const eq = Number(p.equity_score);
        const cached = streetDescriptorFor({ lat, lon });
        return `
          <li class="lowEqCell" data-lat="${lat}" data-lon="${lon}">
            <span class="lowEqQuad lowEqQuad--${p.lisa_quadrant}">${p.lisa_quadrant}</span>
            <span class="lowEqId">#${p.grid_id ?? "?"}</span>
            <span class="lowEqEq">eq ${Number.isFinite(eq) ? eq.toFixed(2) : "—"}</span>
            <span class="lowEqStreet" data-street="1">${cached || `(${lat.toFixed(4)}, ${lon.toFixed(4)})`}</span>
          </li>`;
      }).join("")}
    </ul>
  `;

  out.querySelectorAll(".lowEqCell").forEach((li) => {
    const street = li.querySelector(".lowEqStreet[data-street='1']");
    if (!street || street.textContent.indexOf("(") !== 0) return;
    lazyAttachStreet(street, Number(li.dataset.lat), Number(li.dataset.lon));
  });
}

// ===== v19: SF neighborhood boundary overlay =====
function ensureNeighborhoodOverlay() {
  if (!map || !nbhdGeo) return;
  if (nbhdLayer) return; // already rendered
  nbhdLayer = L.geoJSON(nbhdGeo, {
    interactive: false, // don't steal clicks from grid points
    style: () => ({
      color: "rgba(255,255,255,.55)",
      weight: 1.2,
      opacity: 0.85,
      fill: true,
      fillColor: "#ffffff",
      fillOpacity: 0.0, // transparent fill — boundary lines only
      dashArray: "3,3",
    }),
  }).addTo(map);
  // Keep boundaries below the grid-point markers but above the basemap.
  if (nbhdLayer.bringToBack) nbhdLayer.bringToBack();
}

function rebuildLayer() {
  if (!map || !geo) return;
  if (layer) layer.remove();
  layer = L.geoJSON(geo, {
    filter: (feature) => passesFilters(feature.properties ?? {}),
    pointToLayer: (feature, latlng) => {
      const props = feature.properties ?? {};
      const style = markerStyle(props);
      return L.circleMarker(latlng, { radius: 5, weight: 1, opacity: 0.9, fillOpacity: 0.85, ...style });
    },
    onEachFeature: (feature, l) => {
      const p = feature.properties ?? {};
      const pct = rawToPercent(Number(p.equity_score));
      // Lock page scroll across setSelection so nothing (focus jumps, hash
      // updates, Leaflet internals) can auto-scroll the page on point click.
      l.on("click", () => {
        const y = window.scrollY, x = window.scrollX;
        setSelection(p);
        requestAnimationFrame(() => window.scrollTo(x, y));
      });
      l.bindTooltip(
        `<div style="font-family:ui-sans-serif,system-ui;font-size:12px">
          <div><b>${p.grid_id ?? "grid"}</b></div>
          <div>${clusterName(p.cluster)}</div>
          <div>Equity: ${pct !== null ? `${pct}th pctile` : "—"}</div>
        </div>`,
        { sticky: true }
      );
    },
  }).addTo(map);
}

async function init() {
  renderLegend();
  clearSelection();
  map = L.map("map", { zoomControl: true }).setView([37.77, -122.44], 12);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  const [m, g, summary, z, nbhd] = await Promise.all([
    fetchJson(DATA_META),
    fetchJson(DATA_GEOJSON),
    parseCsv(DATA_SUMMARY),
    parseCsv(DATA_Z),
    fetchJson(DATA_NBHD).catch((e) => { console.warn("neighborhood overlay unavailable", e); return null; }),
  ]);
  meta = m; geo = g; summaryRows = summary; zRows = z; nbhdGeo = nbhd;
  sortedScores = geo.features
    .map((f) => Number(f.properties?.equity_score))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  renderLegend();
  setReportCluster("0");
  renderLisaUnderservedGroups();
  renderLowEquityCongregations();
  setupCellLookup();
  ensureNeighborhoodOverlay();
  rebuildLayer();
}

els.applyFilters.addEventListener("click", () => { renderLegend(); rebuildLayer(); });
els.colorMode.addEventListener("change", () => { renderLegend(); rebuildLayer(); if (selectedProps) setSelection(selectedProps); });
els.clearSelection.addEventListener("click", () => clearSelection());
els.reportCluster?.addEventListener("change", (e) => setReportCluster(e.target.value));

init().catch((err) => {
  console.error(err);
  alert(`Failed to load dashboard data.\n\nError: ${String(err?.message || err)}\n\nStack: ${err?.stack ?? "n/a"}`);
});
