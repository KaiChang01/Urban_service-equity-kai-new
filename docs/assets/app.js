import { CLUSTER_COLORS, equityColor, clamp, INDICATOR_LABELS, fmt } from "./utils.js";

// Resolve from this module so paths work on GitHub Pages, local /docs server, or nested URLs.
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
  selectionEmpty: document.getElementById("selectionEmpty"),
  selection: document.getElementById("selection"),
  selGridId: document.getElementById("selGridId"),
  selCluster: document.getElementById("selCluster"),
  selEquity: document.getElementById("selEquity"),
  selTop: document.getElementById("selTop"),
  clusterLink: document.getElementById("clusterLink"),
  clearSelection: document.getElementById("clearSelection"),

  // report section
  reportCluster: document.getElementById("reportCluster"),
  reportAnchor: document.getElementById("report"),
  clusterName: document.getElementById("clusterName"),
  statN: document.getElementById("statN"),
  statEquityMean: document.getElementById("statEquityMean"),
  statEquityMedian: document.getElementById("statEquityMedian"),
  statEquityBand: document.getElementById("statEquityBand"),
  statPerf: document.getElementById("statPerf"),
  statNeed: document.getElementById("statNeed"),
  direNeeds: document.getElementById("direNeeds"),
  priorityQueue: document.getElementById("priorityQueue"),
  pcaS: document.getElementById("pcaS"),
  pcaN: document.getElementById("pcaN"),
};

els.dataPath.textContent = "outputs/grid_points.geojson";

let meta = null;
let map = null;
let layer = null;
let geo = null;
let summaryRows = [];
let zRows = [];
let zChart = null;
const EQUITY_HIST_BINS_MAX = 10;

function clusterName(c) {
  if (!meta?.config?.cluster_names) return `Cluster ${c}`;
  // keys may be strings in JSON
  return meta.config.cluster_names[String(c)] ?? meta.config.cluster_names[c] ?? `Cluster ${c}`;
}

function passesFilters(props) {
  const cf = els.clusterFilter.value;
  if (cf !== "all" && String(props.cluster) !== cf) return false;

  const emin = clamp(Number(els.equityMin.value), 0, 100);
  const emax = clamp(Number(els.equityMax.value), 0, 100);
  const eq = Number(props.equity_score);
  if (Number.isFinite(eq) && (eq < Math.min(emin, emax) || eq > Math.max(emin, emax))) return false;

  return true;
}

function selectedEquityRange() {
  const a = clamp(Number(els.equityMin.value), 0, 100);
  const b = clamp(Number(els.equityMax.value), 0, 100);
  return [Math.min(a, b), Math.max(a, b)];
}

function histogramBinsForSpan(span) {
  // Keep bins readable for narrow ranges (e.g. 46-47) while preserving detail.
  const bySpan = Math.round(span * 2);
  return Math.max(4, Math.min(EQUITY_HIST_BINS_MAX, bySpan));
}

function fmtBinEdge(v, span) {
  if (span <= 2) return v.toFixed(2);
  if (span <= 10) return v.toFixed(1);
  return v.toFixed(0);
}

function markerStyle(props) {
  const mode = els.colorMode.value;
  if (mode === "cluster") {
    return { color: CLUSTER_COLORS[props.cluster] ?? "#888", fillColor: CLUSTER_COLORS[props.cluster] ?? "#888" };
  }
  const eq = Number(props.equity_score);
  const [emin, emax] = selectedEquityRange();
  const span = Math.max(1e-9, emax - emin);
  // Stretch color mapping to the selected range (ex: 40-60) for better separation.
  const c = equityColor(clamp((eq - emin) / span, 0, 1));
  return { color: c, fillColor: c };
}

function getEquityHistogram(features, rangeMin, rangeMax, bins = EQUITY_HIST_BINS_MAX) {
  const counts = Array.from({ length: bins }, () => 0);
  let total = 0;
  const span = Math.max(1e-9, rangeMax - rangeMin);
  for (const feature of features ?? []) {
    const score = Number(feature?.properties?.equity_score);
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
    <div class="legendTitle">Legend: Equity score</div>
    <div class="ramp"></div>
    <div class="rampLabels"><span>${emin.toFixed(0)}</span><span>${((emin + emax) / 2).toFixed(0)}</span><span>${emax.toFixed(0)}</span></div>
    ${renderEquityHistogram()}
    <div class="legendHint">Red = lower (within selected range)</div>
  `;
}

function clearSelection() {
  els.selectionEmpty.classList.remove("hidden");
  els.selection.classList.add("hidden");
}

function setSelection(props) {
  els.selectionEmpty.classList.add("hidden");
  els.selection.classList.remove("hidden");
  els.selGridId.textContent = props.grid_id ?? "—";
  els.selCluster.textContent = clusterName(props.cluster);
  els.selEquity.textContent = Number.isFinite(Number(props.equity_score)) ? Number(props.equity_score).toFixed(1) : "—";
  els.selTop.textContent = props.top3_features ?? "—";
  els.clusterLink.href = `#report`;

  // Update report to this cluster and scroll down
  setReportCluster(props.cluster);
  setTimeout(() => {
    els.reportAnchor?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 0);
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

function renderPca() {
  const p = meta?.pca_weights?.service_performance ?? {};
  const n = meta?.pca_weights?.service_need ?? {};
  els.pcaS.textContent = JSON.stringify(p, null, 2);
  els.pcaN.textContent = JSON.stringify(n, null, 2);
}

function renderSummary(c) {
  const row = summaryRows.find((r) => String(r.cluster) === String(c));
  els.clusterName.textContent = clusterName(c);
  if (!row) return;
  els.statN.textContent = row.n_grids_scored?.toLocaleString?.() ?? String(row.n_grids_scored ?? "—");
  els.statEquityMean.textContent = fmt(row.equity_mean, 2);
  els.statEquityMedian.textContent = fmt(row.equity_median, 2);
  els.statEquityBand.textContent = `${fmt(row.equity_p10, 2)} → ${fmt(row.equity_p90, 2)}`;
  els.statPerf.textContent = fmt(row.performance_mean, 2);
  els.statNeed.textContent = fmt(row.need_mean, 2);
}

function renderZChart(c) {
  const row = zRows.find((r) => String(r.cluster) === String(c));
  if (!row) return;

  const feats = Object.keys(row).filter(
    (k) => k !== "cluster" && row[k] !== null && row[k] !== undefined && !Number.isNaN(row[k])
  );
  const items = feats
    .map((k) => ({ k, z: Number(row[k]) }))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, 6)
    .reverse();

  const labels = items.map((d) => INDICATOR_LABELS[d.k] ?? d.k);
  const data = items.map((d) => d.z);
  const colors = items.map((d) => (d.z >= 0 ? "rgba(34,197,94,.65)" : "rgba(239,68,68,.65)"));
  const borders = items.map((d) => (d.z >= 0 ? "rgba(34,197,94,1)" : "rgba(239,68,68,1)"));

  const ctx = document.getElementById("zChart");
  if (zChart) zChart.destroy();
  zChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{ label: "z-score", data, backgroundColor: colors, borderColor: borders, borderWidth: 1 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: "rgba(255,255,255,.06)" }, ticks: { color: "rgba(232,234,240,.75)" } },
        y: { grid: { display: false }, ticks: { color: "rgba(232,234,240,.85)" } },
      },
    },
  });
}

function renderHeuristics(c) {
  const h = meta?.heuristics?.[String(c)] ?? meta?.heuristics?.[c];
  if (!h) {
    els.direNeeds.textContent = "—";
    els.priorityQueue.textContent = "—";
    return;
  }

  const priClass = (p) => (p || "").toLowerCase();
  els.direNeeds.innerHTML = (h.needs ?? [])
    .map((n) => {
      const actions = (n.actions ?? []).map((a) => `<li>${a}</li>`).join("");
      return `
        <div class="needCard">
          <div class="pill ${priClass(n.priority)}">${n.priority} · #${n.rank}</div>
          <div class="needTitle">${n.title}</div>
          <div class="needDesc">${n.desc}</div>
          <ul class="smallNote" style="margin:0;padding-left:18px">${actions}</ul>
        </div>
      `;
    })
    .join("");

  els.priorityQueue.innerHTML = (h.queue ?? [])
    .map(([num, action, why]) => {
      return `
        <div class="queueItem">
          <div class="queueNum">${num}</div>
          <div>
            <div class="queueAction">${action}</div>
            <div class="queueWhy">→ ${why}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function setReportCluster(c) {
  const v = String(c);
  if (els.reportCluster) els.reportCluster.value = v;
  renderSummary(v);
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
          <div>Equity: ${Number.isFinite(Number(p.equity_score)) ? Number(p.equity_score).toFixed(1) : "—"}</div>
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

  renderLegend();
  renderPca();
  setReportCluster("0");

  rebuildLayer();
}

els.applyFilters.addEventListener("click", () => {
  renderLegend();
  rebuildLayer();
});
els.colorMode.addEventListener("change", () => {
  renderLegend();
  rebuildLayer();
});
els.clearSelection.addEventListener("click", () => clearSelection());
els.reportCluster?.addEventListener("change", (e) => setReportCluster(e.target.value));

init().catch((err) => {
  console.error(err);
  alert(
    `Failed to load dashboard data.\n\n${String(err?.message || err)}\n\n` +
      "If you opened this as a file, run: python -m http.server 5173 --directory docs\n" +
      "Ensure docs/outputs contains the pipeline files (run run_pipeline.py --output-dir docs/outputs)."
  );
});

