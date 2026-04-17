import { CLUSTER_COLORS, equityColor, clamp, INDICATOR_LABELS, fmt } from "./utils.js";

const MODE_CLUSTER = "cluster";
const MODE_EQUITY = "equity";

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
  // cluster mode side panel
  selClusterSection: document.getElementById("selClusterSection"),
  selCluster: document.getElementById("selCluster"),
  selClusterN: document.getElementById("selClusterN"),
  selClusterEquityMean: document.getElementById("selClusterEquityMean"),
  selClusterTop: document.getElementById("selClusterTop"),
  clusterLink: document.getElementById("clusterLink"),
  // equity mode side panel
  selEquitySection: document.getElementById("selEquitySection"),
  selEquity: document.getElementById("selEquity"),
  selTop: document.getElementById("selTop"),
  clearSelection: document.getElementById("clearSelection"),
  // bottom report section
  reportCluster: document.getElementById("reportCluster"),
  reportAnchor: document.getElementById("report"),
  direNeeds: document.getElementById("direNeeds"),
  priorityQueue: document.getElementById("priorityQueue"),
};

els.dataPath.textContent = "outputs/grid_points.geojson";

let meta = null;
let map = null;
let layer = null;
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
  const pct = rawToPercent(Number(props.equity_score));
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  const c = equityColor(clamp(((pct ?? 0) - emin) / span, 0, 1));
  return { color: c, fillColor: c };
}

function getEquityHistogram(features, rangeMin, rangeMax, bins = EQUITY_HIST_BINS_MAX) {
  const counts = Array.from({ length: bins }, () => 0);
  let total = 0;
  const span = Math.max(1e-9, rangeMax - rangeMin);
  for (const feature of features ?? []) {
    const score = rawToPercent(Number(feature?.properties?.equity_score));
    if (score === null) continue;
    if (score < rangeMin || score > rangeMax) continue;
    const idx = Math.min(bins - 1, Math.floor(((score - rangeMin) / span) * bins));
    counts[idx] += 1;
    total += 1;
  }
  return { counts, total };
}

function renderEquityHistogram() {
  if (!geo?.features?.length) return `<div class="legendHint">Distribution loading...</div>`;
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  const bins = histogramBinsForSpan(span);
  const { counts, total } = getEquityHistogram(geo.features, emin, emax, bins);
  if (!total) return `<div class="legendHint">No equity scores in ${emin.toFixed(0)}-${emax.toFixed(0)}.</div>`;
  const maxCount = Math.max(...counts, 1);
  const bars = counts.map((count, i) => {
    const lo = emin + i * (span / bins);
    const hi = emin + (i + 1) * (span / bins);
    const h = Math.max(4, Math.round((count / maxCount) * 36));
    return `<div class="histBar" style="height:${h}px" title="${fmtBinEdge(lo, span)}-${fmtBinEdge(hi, span)}: ${count}"></div>`;
  }).join("");
  const catRows = counts.map((count, i) => {
    const lo = emin + i * (span / bins);
    const hi = emin + (i + 1) * (span / bins);
    return `<div class="histCat"><span>${fmtBinEdge(lo, span)}-${fmtBinEdge(hi, span)}</span><b>${count.toLocaleString()}</b></div>`;
  }).join("");
  return `
    <div class="histWrap">
      <div class="histHeader"><span>Distribution ${emin.toFixed(0)}-${emax.toFixed(0)}</span><span>n=${total.toLocaleString()}</span></div>
      <div class="histBars">${bars}</div>
      <div class="histLabels"><span>${fmtBinEdge(emin, span)}</span><span>${fmtBinEdge((emin + emax) / 2, span)}</span><span>${fmtBinEdge(emax, span)}</span></div>
      <div class="histCats">${catRows}</div>
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

  if (mode === MODE_CLUSTER) {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Cluster Report";
    els.selClusterSection.classList.remove("hidden");
    els.selEquitySection.classList.add("hidden");

    els.selCluster.textContent = clusterName(props.cluster);
    const row = summaryRows.find((r) => String(r.cluster) === String(props.cluster));
    els.selClusterN.textContent = row?.n_grids_scored?.toLocaleString?.() ?? "—";
    els.selClusterEquityMean.textContent = row ? fmt(row.equity_mean, 2) : "—";
    els.selClusterTop.innerHTML = formatTop3(zRow);

    if (els.clusterLink) els.clusterLink.href = "#report";
    setReportCluster(props.cluster);
    setTimeout(() => els.reportAnchor?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  } else {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Equity Score Report";
    els.selClusterSection.classList.add("hidden");
    els.selEquitySection.classList.remove("hidden");

    const raw = Number(props.equity_score);
    const pct = rawToPercent(raw);
    els.selEquity.textContent = Number.isFinite(raw)
      ? `${raw.toFixed(2)}${pct !== null ? ` (${pct}th pctile)` : ""}`
      : "—";
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

function renderHeuristics(c) {
  const h = meta?.heuristics?.[String(c)] ?? meta?.heuristics?.[c];
  if (!h) {
    if (els.direNeeds) els.direNeeds.textContent = "—";
    if (els.priorityQueue) els.priorityQueue.textContent = "—";
    return;
  }
  const needs = h.needs ?? [];
  if (els.direNeeds) els.direNeeds.innerHTML = needs.map((n) =>
    `<div class="needCard"><div class="needTitle">${n.title}</div><div class="needDesc">${n.desc}</div></div>`
  ).join("") || "—";
  const allActions = needs.flatMap((n) => n.actions ?? []);
  if (els.priorityQueue) els.priorityQueue.innerHTML = allActions.map((a) =>
    `<div class="queueItem"><div class="queueAction">${a}</div></div>`
  ).join("") || "—";
}

function setReportCluster(c) {
  const v = String(c);
  if (els.reportCluster) els.reportCluster.value = v;
  renderZChart(v);
  renderHeuristics(v);
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
      l.on("click", () => setSelection(p));
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
  const [m, g, summary, z] = await Promise.all([
    fetchJson(DATA_META), fetchJson(DATA_GEOJSON), parseCsv(DATA_SUMMARY), parseCsv(DATA_Z),
  ]);
  meta = m; geo = g; summaryRows = summary; zRows = z;
  sortedScores = geo.features
    .map((f) => Number(f.properties?.equity_score))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  renderLegend();
  setReportCluster("0");
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
