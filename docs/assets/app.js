import { CLUSTER_COLORS, equityColor, clamp, INDICATOR_LABELS, fmt } from "./utils.js";

// Relative to index.html (fetch base URL), not this file.
const DATA_GEOJSON = "outputs/grid_points.geojson";
const DATA_META = "outputs/metadata.json";
const DATA_SUMMARY = "outputs/cluster_summary.csv";
const DATA_Z = "outputs/cluster_feature_zscores.csv";

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

els.dataPath.textContent = DATA_GEOJSON;

let meta = null;
let map = null;
let layer = null;
let geo = null;
let summaryRows = [];
let zRows = [];
let zChart = null;

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

function markerStyle(props) {
  const mode = els.colorMode.value;
  if (mode === "cluster") {
    return { color: CLUSTER_COLORS[props.cluster] ?? "#888", fillColor: CLUSTER_COLORS[props.cluster] ?? "#888" };
  }
  const eq = Number(props.equity_score);
  const c = equityColor(clamp(eq / 100.0, 0, 1));
  return { color: c, fillColor: c };
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
  els.legend.innerHTML = `
    <div class="legendTitle">Legend: Equity score</div>
    <div class="ramp"></div>
    <div class="rampLabels"><span>0</span><span>50</span><span>100</span></div>
    <div class="legendRow" style="margin-top:10px">
      <div style="color:var(--muted)">Red = lower equity</div>
    </div>
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

  const [metaResp, geoResp, summary, z] = await Promise.all([
    fetch(DATA_META),
    fetch(DATA_GEOJSON),
    parseCsv(DATA_SUMMARY),
    parseCsv(DATA_Z),
  ]);
  meta = await metaResp.json();
  geo = await geoResp.json();
  summaryRows = summary;
  zRows = z;

  renderPca();
  setReportCluster("0");

  rebuildLayer();
}

els.applyFilters.addEventListener("click", () => rebuildLayer());
els.colorMode.addEventListener("change", () => {
  renderLegend();
  rebuildLayer();
});
els.clearSelection.addEventListener("click", () => clearSelection());
els.reportCluster?.addEventListener("change", (e) => setReportCluster(e.target.value));

init().catch((err) => {
  console.error(err);
  alert(
    "Failed to load dashboard data. Make sure you are serving the folder with a local HTTP server (not file://) and that docs/outputs or outputs exists."
  );
});

