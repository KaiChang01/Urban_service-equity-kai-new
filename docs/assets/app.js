import { CLUSTER_COLORS, equityColor, clamp, INDICATOR_LABELS, fmt } from "./utils.js";

const DATA_BASE = new URL("../outputs/", import.meta.url);
const DATA_GEOJSON = new URL("grid_points.geojson", DATA_BASE).href;
const DATA_META = new URL("metadata.json", DATA_BASE).href;
const DATA_SUMMARY = new URL("cluster_summary.csv", DATA_BASE).href;
const DATA_Z = new URL("cluster_feature_zscores.csv", DATA_BASE).href;

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
  // cluster mode fields
  selClusterSection: document.getElementById("selClusterSection"),
  selCluster: document.getElementById("selCluster"),
  selClusterN: document.getElementById("selClusterN"),
  selClusterEquityMean: document.getElementById("selClusterEquityMean"),
  selClusterTop: document.getElementById("selClusterTop"),
  // equity mode fields
  selEquitySection: document.getElementById("selEquitySection"),
  selEquity: document.getElementById("selEquity"),
  selTop: document.getElementById("selTop"),
  clearSelection: document.getElementById("clearSelection"),
};

els.dataPath.textContent = "outputs/grid_points.geojson";

let meta = null;
let map = null;
let layer = null;
let geo = null;
let summaryRows = [];
let zRows = [];
let selectedProps = null;
const EQUITY_HIST_BINS_MAX = 10;
let sortedScores = [];

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
  const bySpan = Math.round(span * 2);
  return Math.max(4, Math.min(EQUITY_HIST_BINS_MAX, bySpan));
}

function fmtBinEdge(v, span) {
  if (span <= 2) return v.toFixed(2);
  if (span <= 10) return v.toFixed(1);
  return v.toFixed(0);
}

function rawToPercent(score) {
  const n = sortedScores.length;
  if (!n) return 0;
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
  return Object.entries(zRow)
    .filter(([k]) => k !== "cluster")
    .map(([k, v]) => ({ k, z: Number(v) }))
    .filter((d) => Number.isFinite(d.z))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 3)
    .map((d) => `${INDICATOR_LABELS[d.k] ?? d.k} (${d.z >= 0 ? "+" : ""}${d.z.toFixed(2)})`)
    .join("<br>");
}

function markerStyle(props) {
  const mode = els.colorMode.value;
  if (mode === "cluster") {
    return { color: CLUSTER_COLORS[props.cluster] ?? "#888", fillColor: CLUSTER_COLORS[props.cluster] ?? "#888" };
  }
  const eq = Number(props.equity_score);
  const pct = rawToPercent(eq);
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  const c = equityColor(clamp((pct - emin) / span, 0, 1));
  return { color: c, fillColor: c };
}

function getEquityHistogram(features, rangeMin, rangeMax, bins = EQUITY_HIST_BINS_MAX) {
  const counts = Array.from({ length: bins }, () => 0);
  let total = 0;
  const span = Math.max(1e-9, rangeMax - rangeMin);
  for (const feature of features ?? []) {
    const score = rawToPercent(Number(feature?.properties?.equity_score));
    if (!Number.isFinite(score)) continue;
    if (score < rangeMin || score > rangeMax) continue;
    const idx = Math.min(bins - 1, Math.floor(((score - rangeMin) / span) * bins));
    counts[idx] += 1;
    total += 1;
  }
  return { counts, total };
}

function renderEquityHistogram() {
  if (!geo?.features?.length) {
    return `<div class="legendHint">Distribution loading...</div>`;
  }
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  const bins = histogramBinsForSpan(span);
  const { counts, total } = getEquityHistogram(geo.features, emin, emax, bins);
  if (!total) {
    return `<div class="legendHint">No equity scores in ${emin.toFixed(0)}-${emax.toFixed(0)}.</div>`;
  }

  const maxCount = Math.max(...counts, 1);
  const bars = counts
    .map((count, i) => {
      const lo = emin + i * (span / bins);
      const hi = emin + (i + 1) * (span / bins);
      const h = Math.max(4, Math.round((count / maxCount) * 36));
      return `<div class="histBar" style="height:${h}px" title="${fmtBinEdge(lo, span)}-${fmtBinEdge(hi, span)}: ${count}"></div>`;
    })
    .join("");
  const catRows = counts
    .map((count, i) => {
      const lo = emin + i * (span / bins);
      const hi = emin + (i + 1) * (span / bins);
      return `<div class="histCat"><span>${fmtBinEdge(lo, span)}-${fmtBinEdge(hi, span)}</span><b>${count.toLocaleString()}</b></div>`;
    })
    .join("");

  return `
    <div class="histWrap">
      <div class="histHeader">
        <span>Distribution ${emin.toFixed(0)}-${emax.toFixed(0)}</span>
        <span>n=${total.toLocaleString()}</span>
      </div>
      <div class="histBars">${bars}</div>
      <div class="histLabels">
        <span>${fmtBinEdge(emin, span)}</span>
        <span>${fmtBinEdge((emin + emax) / 2, span)}</span>
        <span>${fmtBinEdge(emax, span)}</span>
      </div>
      <div class="histCats">${catRows}</div>
    </div>
  `;
}

function renderLegend() {
  const mode = els.colorMode.value;
  if (mode === "cluster") {
    els.legend.innerHTML = `
      <div class="legendTitle">Legend: Cluster</div>
      ${[0, 1, 2, 3]
        .map(
          (c) => `
        <div class="legendRow">
          <div class="swatch" style="background:${CLUSTER_COLORS[c]}"></div>
          <div>${clusterName(c)}</div>
        </div>`
        )
        .join("")}
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

  if (mode === "cluster") {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Cluster Report";
    els.selClusterSection.classList.remove("hidden");
    els.selEquitySection.classList.add("hidden");

    els.selCluster.textContent = clusterName(props.cluster);

    const row = summaryRows.find((r) => String(r.cluster) === String(props.cluster));
    els.selClusterN.textContent = row?.n_grids_scored?.toLocaleString?.() ?? "—";
    els.selClusterEquityMean.textContent = row ? fmt(row.equity_mean, 2) : "—";

    const zRow = zRows.find((r) => String(r.cluster) === String(props.cluster));
    els.selClusterTop.innerHTML = formatTop3(zRow);
  } else {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Equity Score Report";
    els.selClusterSection.classList.add("hidden");
    els.selEquitySection.classList.remove("hidden");

    els.selEquity.textContent = Number.isFinite(Number(props.equity_score))
      ? Number(props.equity_score).toFixed(2)
      : "—";

    const zRow = zRows.find((r) => String(r.cluster) === String(props.cluster));
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
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (err) => reject(err),
    });
  });
}

function rebuildLayer() {
  if (!map || !geo) return;
  if (layer) layer.remove();

  layer = L.geoJSON(geo, {
    filter: (feature) => passesFilters(feature.properties ?? {}),
    pointToLayer: (feature, latlng) => {
      const props = feature.properties ?? {};
      const style = markerStyle(props);
      return L.circleMarker(latlng, {
        radius: 5,
        weight: 1,
        opacity: 0.9,
        fillOpacity: 0.85,
        ...style,
      });
    },
    onEachFeature: (feature, l) => {
      const p = feature.properties ?? {};
      l.on("click", () => setSelection(p));
      l.bindTooltip(
        `<div style="font-family: ui-sans-serif, system-ui; font-size:12px">
          <div><b>${p.grid_id ?? "grid"}</b></div>
          <div>${clusterName(p.cluster)}</div>
          <div>Equity: ${Number.isFinite(Number(p.equity_score)) ? `${rawToPercent(Number(p.equity_score))}%` : "—"}</div>
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

  const [m, g, summary, z] = await Promise.all([
    fetchJson(DATA_META),
    fetchJson(DATA_GEOJSON),
    parseCsv(DATA_SUMMARY),
    parseCsv(DATA_Z),
  ]);
  meta = m;
  geo = g;
  summaryRows = summary;
  zRows = z;

  sortedScores = geo.features
    .map((f) => Number(f.properties?.equity_score))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  renderLegend();
  rebuildLayer();
}

els.applyFilters.addEventListener("click", () => {
  renderLegend();
  rebuildLayer();
});
els.colorMode.addEventListener("change", () => {
  renderLegend();
  rebuildLayer();
  if (selectedProps) setSelection(selectedProps);
});
els.clearSelection.addEventListener("click", () => clearSelection());

init().catch((err) => {
  console.error(err);
  alert(`Failed to load dashboard data.\n\nError: ${String(err?.message || err)}\n\nStack: ${err?.stack ?? "n/a"}`);
});
