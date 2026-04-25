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
  selClusterNeighborhood: document.getElementById("selClusterNeighborhood"),
  selClusterEquityMean: document.getElementById("selClusterEquityMean"),
  selClusterTop: document.getElementById("selClusterTop"),
  clusterLink: document.getElementById("clusterLink"),
  // equity mode side panel
  selEquitySection: document.getElementById("selEquitySection"),
  selEquity: document.getElementById("selEquity"),
  selEquityNeighborhood: document.getElementById("selEquityNeighborhood"),
  selTop: document.getElementById("selTop"),
  clearSelection: document.getElementById("clearSelection"),
  // bottom report section
  reportCluster: document.getElementById("reportCluster"),
  reportAnchor: document.getElementById("report"),
  direNeeds: document.getElementById("direNeeds"),
  priorityQueue: document.getElementById("priorityQueue"),
  needsAndInterventions: document.getElementById("needsAndInterventions"),
  needsAndInterventionsEquity: document.getElementById("needsAndInterventionsEquity"),
  reportEquityBand: document.getElementById("reportEquityBand"),
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

// Raw equity-score distribution for the legend.
// `sortedScores` holds the ascending raw equity_score values across the dataset.
// v17: zoom the histogram into the dense core of the distribution (45–53) so
// the bell-curve shape is actually visible. Outside this window the
// distribution has long thin tails that flatten everything when included.
const HIST_LO = 45;
const HIST_HI = 53;

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
  // we can shade the bars that are inside the filter (clipped to the 45–53 window).
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

  if (mode === MODE_CLUSTER) {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Cluster Report";
    els.selClusterSection.classList.remove("hidden");
    els.selEquitySection.classList.add("hidden");

    els.selCluster.textContent = clusterName(props.cluster);
    const row = summaryRows.find((r) => String(r.cluster) === String(props.cluster));
    els.selClusterN.textContent = row?.n_grids_scored?.toLocaleString?.() ?? "—";
    if (els.selClusterNeighborhood) els.selClusterNeighborhood.textContent = neighborhood;
    els.selClusterEquityMean.textContent = row ? fmt(row.equity_mean, 2) : "—";
    els.selClusterTop.innerHTML = formatTop3(zRow);

    if (els.clusterLink) els.clusterLink.href = "#report";
    setReportCluster(props.cluster);
    // Auto-scroll disabled (v12): user can use the "View cluster report" button instead.
  } else {
    if (els.selPanelTitle) els.selPanelTitle.textContent = "Equity Score Report";
    els.selClusterSection.classList.add("hidden");
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

// Map equity tier (lowest/low/high/highest) to the cluster ID whose
// equity_mean places it at that tier. Computed from summaryRows on data load.
let equityBandToCluster = { lowest: "0", low: "0", high: "0", highest: "0" };

function buildEquityBandMap() {
  if (!summaryRows?.length) return;
  const ranked = summaryRows
    .filter((r) => Number.isFinite(Number(r.equity_mean)))
    .map((r) => ({ cluster: String(r.cluster), eq: Number(r.equity_mean) }))
    .sort((a, b) => a.eq - b.eq);
  if (!ranked.length) return;
  // 4 clusters → 4 tiers (ascending equity mean)
  const labels = ["lowest", "low", "high", "highest"];
  equityBandToCluster = {};
  for (let i = 0; i < labels.length; i++) {
    const idx = Math.min(ranked.length - 1, Math.floor((i / (labels.length - 1)) * (ranked.length - 1)));
    equityBandToCluster[labels[i]] = ranked[idx].cluster;
  }
  // For >4 clusters or fewer, the proportional indexing above still gives
  // a sensible mapping; identical clusters at boundary just repeat.
}

function setReportEquityBand(band) {
  const c = equityBandToCluster[band] ?? equityBandToCluster.lowest;
  if (els.reportEquityBand) els.reportEquityBand.value = band;

  // Compute the tier context from the underlying grid features so the urban
  // planner can see exactly which cells are in this tier.
  const cells = (geo?.features ?? []).filter((f) => String(f.properties?.cluster) === String(c));
  const scores = cells.map((f) => Number(f.properties?.equity_score)).filter(Number.isFinite);
  let scoreMin = NaN, scoreMax = NaN, scoreMean = NaN;
  if (scores.length) {
    scoreMin = Math.min(...scores);
    scoreMax = Math.max(...scores);
    scoreMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  }
  const neighborhoodCounts = {};
  for (const f of cells) {
    const n = (f.properties?.neighborhood ?? "").trim();
    if (!n) continue;
    neighborhoodCounts[n] = (neighborhoodCounts[n] ?? 0) + 1;
  }
  const topNeighborhoods = Object.entries(neighborhoodCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${name} <span class="tierMutedSmall">(${n})</span>`)
    .join(" &middot; ") || "—";

  const tierLabel = {
    lowest: "Most underserved (lowest equity)",
    low: "Underserved",
    high: "Better served",
    highest: "Best served (highest equity)",
  }[band] ?? band;

  const fmtN = (n) => Number.isFinite(n) ? n.toLocaleString() : "—";
  const fmtR = (n) => Number.isFinite(n) ? n.toFixed(2) : "—";

  const ctxHTML = `
    <div class="tierContext tierContext--${band}">
      <div class="tierContextHead">
        <div class="tierContextLabel">${tierLabel}</div>
        <div class="tierContextSub">Mapped to ${clusterName(c)}</div>
      </div>
      <div class="tierStats">
        <div class="tierStat"><div class="tierStatK">Grid cells</div><div class="tierStatV">${fmtN(cells.length)}</div></div>
        <div class="tierStat"><div class="tierStatK">Equity score range</div><div class="tierStatV">${fmtR(scoreMin)} &ndash; ${fmtR(scoreMax)}</div></div>
        <div class="tierStat"><div class="tierStatK">Mean equity</div><div class="tierStatV">${fmtR(scoreMean)}</div></div>
      </div>
      <div class="tierNbhd"><span class="tierNbhdK">Top neighborhoods:</span> ${topNeighborhoods}</div>
    </div>
  `;

  // Render heuristics into the target, then prepend the context block.
  renderHeuristics(c, els.needsAndInterventionsEquity);
  if (els.needsAndInterventionsEquity) {
    els.needsAndInterventionsEquity.insertAdjacentHTML("afterbegin", ctxHTML);
  }
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
  const [m, g, summary, z] = await Promise.all([
    fetchJson(DATA_META), fetchJson(DATA_GEOJSON), parseCsv(DATA_SUMMARY), parseCsv(DATA_Z),
  ]);
  meta = m; geo = g; summaryRows = summary; zRows = z;
  sortedScores = geo.features
    .map((f) => Number(f.properties?.equity_score))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  buildEquityBandMap();
  renderLegend();
  setReportCluster("0");
  setReportEquityBand("lowest");
  rebuildLayer();
}

els.applyFilters.addEventListener("click", () => { renderLegend(); rebuildLayer(); });
els.colorMode.addEventListener("change", () => { renderLegend(); rebuildLayer(); if (selectedProps) setSelection(selectedProps); });
els.clearSelection.addEventListener("click", () => clearSelection());
els.reportCluster?.addEventListener("change", (e) => setReportCluster(e.target.value));
els.reportEquityBand?.addEventListener("change", (e) => setReportEquityBand(e.target.value));

init().catch((err) => {
  console.error(err);
  alert(`Failed to load dashboard data.\n\nError: ${String(err?.message || err)}\n\nStack: ${err?.stack ?? "n/a"}`);
});
