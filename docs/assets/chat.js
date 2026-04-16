const DATA_BASE = new URL("../outputs/", import.meta.url);
const DATA_GEOJSON = new URL("grid_points.geojson", DATA_BASE).href;
const DATA_META = new URL("metadata.json", DATA_BASE).href;
const DATA_SUMMARY = new URL("cluster_summary.csv", DATA_BASE).href;
const DATA_RENT_CSV = new URL("rent_dataset_module2.csv", DATA_BASE).href;
const SOCIOPAPER_TXT = new URL("../sociopaper/zahnow1.txt", import.meta.url).href;

const STORAGE_KEY = "equity_prompt_lab_v1";
const MAX_HISTORY = 16;
const SOCIOPAPER_ID = "zahnow1";
const SOCIOPAPER_TOP_K = 5;
const SOCIOPAPER_CHUNK_TARGET = 1100;
const RENT_CONTEXT_MAX_ROWS = 22;
const QUIET_FRIENDLY_HOODS = new Set([
  "Outer Richmond",
  "Inner Richmond",
  "Sunset/Parkside",
  "Lakeshore",
  "Seacliff",
  "Oceanview/Merced/Ingleside",
  "West of Twin Peaks",
  "Visitacion Valley",
  "Bayview Hunters Point",
]);
const BUSIER_HOODS = new Set([
  "Tenderloin",
  "South of Market",
  "Financial District/South Beach",
  "Mission",
  "Chinatown",
  "North Beach",
]);
/** Canonical analysis_neighborhood values in rent_dataset_module2 (keep in sync with data). */
const SF_RENT_NEIGHBORHOODS = [
  "Bayview Hunters Point",
  "Bernal Heights",
  "Castro/Upper Market",
  "Chinatown",
  "Excelsior",
  "Financial District/South Beach",
  "Glen Park",
  "Golden Gate Park",
  "Haight Ashbury",
  "Hayes Valley",
  "Inner Richmond",
  "Inner Sunset",
  "Japantown",
  "Lakeshore",
  "Lincoln Park",
  "Lone Mountain/USF",
  "Marina",
  "McLaren Park",
  "Mission",
  "Mission Bay",
  "Nob Hill",
  "Noe Valley",
  "North Beach",
  "Oceanview/Merced/Ingleside",
  "Outer Mission",
  "Outer Richmond",
  "Pacific Heights",
  "Portola",
  "Potrero Hill",
  "Presidio",
  "Presidio Heights",
  "Russian Hill",
  "Seacliff",
  "South of Market",
  "Sunset/Parkside",
  "Tenderloin",
  "Treasure Island",
  "Twin Peaks",
  "Visitacion Valley",
  "West of Twin Peaks",
  "Western Addition",
];
const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "her", "was", "one", "our", "out", "has", "have", "been", "were", "said", "each",
  "which", "their", "time", "will", "about", "there", "could", "other", "than", "then", "them", "these", "some", "what", "with", "from", "that",
  "this", "into", "such", "when", "may", "more", "also", "how", "its", "who", "had", "any",
]);

const els = {
  modelSelect: document.getElementById("modelSelect"),
  customModel: document.getElementById("customModel"),
  apiKey: document.getElementById("apiKey"),
  temperature: document.getElementById("temperature"),
  maxTokens: document.getElementById("maxTokens"),
  contextMode: document.getElementById("contextMode"),
  clusterContext: document.getElementById("clusterContext"),
  gridContext: document.getElementById("gridContext"),
  systemPrompt: document.getElementById("systemPrompt"),
  contextPreview: document.getElementById("contextPreview"),
  chatMessages: document.getElementById("chatMessages"),
  userInput: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  clearChat: document.getElementById("clearChat"),
  refreshContext: document.getElementById("refreshContext"),
  chatStatus: document.getElementById("chatStatus"),
};

const state = {
  chat: [],
  meta: null,
  geo: null,
  summaryRows: [],
  gridById: new Map(),
  summaryByCluster: new Map(),
  /** @type {{ id: number; text: string }[]} */
  sociopaperChunks: [],
  /** @type {{ addr: string; hood: string; rent: number; beds: number | null; baths: number | null; sqft: number | null; year: number | null; district: number | null }[]} */
  rentListings: [],
};

const DEFAULT_SYSTEM_PROMPT = `You are an urban service equity assistant.
Your job is to answer user questions clearly using dashboard data and policy reasoning.

Rules:
1) Separate your answer into: place-specific analysis, cluster-level analysis, and general recommendations.
2) If evidence is uncertain, say what is uncertain.
3) Cite concrete references when provided in context.
4) Keep explanations concise and actionable.
5) When sociology paper excerpts are included in the system message, ground relevant conceptual claims in those passages and cite them (e.g. zahnow1 chunk 3).
6) Never output bolded quoted phrases (avoid patterns like **"..."**).
7) Avoid user-facing technical jargon such as "performance", "equity score", "z-score", and "pipeline".
8) Prefer plain-language paraphrases:
   - "performance" => "service access and quality in daily life"
   - "equity score" => "overall fairness level across areas"
   - "z-score" => "distance from city average"
9) If a technical term is unavoidable, explain it immediately in one short sentence.
10) When the context includes San Francisco Housing Inventory unit rows, give concrete examples from those rows only (block, neighborhood, bedrooms, rent, approximate size). Say clearly these are city inventory records and may not reflect current open listings.

You are an assistant with access to a sociology paper (zahnow1).

Before answering, you must decide:

1. Does the user's question require sociological reasoning?
   - Yes if it involves:
     - social behavior, communities, inequality, urban dynamics
     - concepts like collective efficacy, social interaction, etc.
   - No if it is:
     - purely technical (coding, math, API usage)
     - factual lookup without social interpretation

2. If YES:
   - Use the provided zahnow1 chunks when relevant
   - Integrate concepts or findings from the paper
   - Cite as [zahnow1 chunk N] when used

3. If NO:
   - Ignore zahnow1 completely
   - Answer normally

4. Never force citations if irrelevant`;

const RESPONSE_STYLE_GUARD = `Mandatory output style rules:
- Never output bolded quoted text (including patterns like **"..."**, **“...”**, or ** '...' **).
- Do not use technical labels in user-facing text: "performance", "equity score", "equity mean", "performance mean", "z-score", "pipeline", "equity_mean", "performance_mean".
- Always paraphrase those labels into plain language.
- Never expose raw cluster taxonomy names in user-facing text, such as "Cluster A/B/C" or labels like "Dominant Residential".
- Do not expose raw field names from JSON context in the final answer.
- When Housing Inventory rows are provided, do not substitute generic national rental advice; stay within San Francisco and those rows.`;

function setStatus(msg) {
  els.chatStatus.textContent = msg;
}

function loadSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    els.modelSelect.value = saved.model ?? els.modelSelect.value;
    els.customModel.value = saved.customModel ?? "";
    els.apiKey.value = saved.apiKey ?? "";
    els.temperature.value = String(saved.temperature ?? 0.3);
    els.maxTokens.value = String(saved.maxTokens ?? 900);
    els.contextMode.value = saved.contextMode ?? "global";
    els.clusterContext.value = saved.clusterContext ?? "0";
    els.gridContext.value = saved.gridContext ?? "";
    els.systemPrompt.value = saved.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    state.chat = Array.isArray(saved.chat)
      ? saved.chat.slice(-MAX_HISTORY).map((m) => ({
          ...m,
          content: m?.role === "assistant" ? sanitizeAssistantText(m?.content) : String(m?.content ?? ""),
        }))
      : [];
  } catch {
    // ignore malformed local storage
  }
}

function saveState() {
  const payload = {
    model: els.modelSelect.value,
    customModel: els.customModel.value,
    apiKey: els.apiKey.value,
    temperature: Number(els.temperature.value),
    maxTokens: Number(els.maxTokens.value),
    contextMode: els.contextMode.value,
    clusterContext: els.clusterContext.value,
    gridContext: els.gridContext.value,
    systemPrompt: els.systemPrompt.value,
    chat: state.chat.slice(-MAX_HISTORY),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function selectedModel() {
  const custom = (els.customModel.value || "").trim();
  return custom || els.modelSelect.value;
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

function loadRentDataset() {
  return new Promise((resolve, reject) => {
    const rows = [];
    Papa.parse(DATA_RENT_CSV, {
      download: true,
      header: true,
      dynamicTyping: true,
      skipEmptyLines: true,
      step: (res) => {
        const r = res.data;
        if (!r || typeof r !== "object") return;
        const rentRaw = r.monthly_rent_clean;
        const rent =
          typeof rentRaw === "number" && !Number.isNaN(rentRaw)
            ? rentRaw
            : Number(String(rentRaw ?? "").replace(/,/g, "").trim());
        if (!Number.isFinite(rent) || rent <= 0) return;
        const addr = String(r.block_address ?? "").trim();
        const hood = String(r.analysis_neighborhood ?? "").trim();
        if (!addr || !hood) return;
        rows.push({
          addr,
          hood,
          rent,
          beds: typeof r.bedrooms_clean === "number" && !Number.isNaN(r.bedrooms_clean) ? r.bedrooms_clean : null,
          baths: typeof r.bathrooms_clean === "number" && !Number.isNaN(r.bathrooms_clean) ? r.bathrooms_clean : null,
          sqft: typeof r.sqft_avg === "number" && !Number.isNaN(r.sqft_avg) ? r.sqft_avg : null,
          year: typeof r.submission_year === "number" && !Number.isNaN(r.submission_year) ? r.submission_year : null,
          district: typeof r.supervisor_district === "number" && !Number.isNaN(r.supervisor_district) ? r.supervisor_district : null,
        });
      },
      complete: () => resolve(rows),
      error: (err) => reject(err),
    });
  });
}

function rentIntentFromQuery(q) {
  const s = String(q || "").toLowerCase();
  if (!s.trim()) return false;
  const hasMoney =
    /\$\s*\d/.test(s) ||
    /\d{3,5}\s*[-–—to]+\s*\d{3,5}/.test(s) ||
    /\b(?:under|below|over|above|less than|more than|at least)\s*\$?\s*\d{3,5}\b/.test(s);
  const housingWords =
    /\b(rent|rental|apartment|housing|lease|landlord|tenant|bedroom|bedrooms|studio|sqft|sq\.?\s*ft|afford|move|live|neighborhood|quiet|location|place|options|listing|unit|flat)\b/.test(
      s,
    );
  if (/\bsf\b|\bsan francisco\b|\bay area\b/.test(s) && housingWords) return true;
  if (housingWords && hasMoney) return true;
  if (hasMoney && /\b(live|place|quiet|budget|ideal|looking|want)\b/.test(s)) return true;
  if (/\b(rent|rental|apartment|housing|lease|bedroom|studio)\b/.test(s) && hasMoney) return true;
  if (/\$\s*\d{3,5}\b/.test(s) && /\b(rent|month|budget|afford)\b/.test(s)) return true;
  return false;
}

function parseRentRangeFromQuery(q) {
  const s = String(q || "");
  let min = null;
  let max = null;
  const dollarPair = s.match(/\$\s*(\d{3,5})\s*[-–—to,]+\s*\$?\s*(\d{3,5})/i);
  const plainPair = s.match(/\b(\d{3,5})\s*[-–—to]+\s*(\d{3,5})\b/);
  if (dollarPair) {
    min = Number(dollarPair[1]);
    max = Number(dollarPair[2]);
  } else if (plainPair) {
    min = Number(plainPair[1]);
    max = Number(plainPair[2]);
  }
  if (min != null && max != null && min > max) [min, max] = [max, min];
  const under = s.match(/\b(?:under|below|less than|max|maximum)\s*\$?\s*(\d{3,5})\b/i);
  if (under) max = Number(under[1]);
  const over = s.match(/\b(?:over|above|at least|min|minimum)\s*\$?\s*(\d{3,5})\b/i);
  if (over) min = Number(over[1]);
  return { min, max };
}

function parseBedroomsHint(q) {
  const s = String(q || "").toLowerCase();
  if (/\bstudio\b/.test(s)) return 0;
  const m = s.match(/\b(\d)\s*(?:br|bed|bedroom|bedrooms)\b/);
  if (m) return Number(m[1]);
  return null;
}

function neighborhoodsFromQuery(q) {
  const s = String(q || "");
  const lower = s.toLowerCase();
  const found = new Set();
  for (const hood of SF_RENT_NEIGHBORHOODS) {
    if (lower.includes(hood.toLowerCase())) found.add(hood);
  }
  if (/\bsoma\b/.test(lower) || /south of market/i.test(s)) found.add("South of Market");
  if (/\bfidi\b|financial district/i.test(lower)) found.add("Financial District/South Beach");
  if (/\bouter\s+richmond\b|\brichmond\b/.test(lower) && !/\binner\s+richmond\b/.test(lower)) {
    found.add("Outer Richmond");
    found.add("Inner Richmond");
  }
  if (/\binner\s+richmond\b/.test(lower)) found.add("Inner Richmond");
  if (/\bsunset\b|\bparkside\b/.test(lower)) found.add("Sunset/Parkside");
  if (/\bhaight\b/.test(lower)) found.add("Haight Ashbury");
  if (/\bcastro\b|\bupper market\b/.test(lower)) found.add("Castro/Upper Market");
  if (/\bnoe\b/.test(lower)) found.add("Noe Valley");
  if (/\bpotrero\b/.test(lower)) found.add("Potrero Hill");
  if (/\bmission\b/.test(lower) && !/mission bay/i.test(s)) found.add("Mission");
  if (/mission bay/i.test(s)) found.add("Mission Bay");
  return [...found];
}

function quietPreferenceFromQuery(q) {
  return /\bquiet\b|\bcalm\b|\bpeaceful\b|\blow noise\b/i.test(String(q || ""));
}

function retrieveRentListings(userQuery) {
  if (!state.rentListings.length) return "";
  const { min, max } = parseRentRangeFromQuery(userQuery);
  const hoods = neighborhoodsFromQuery(userQuery);
  const bedHint = parseBedroomsHint(userQuery);
  const wantQuiet = quietPreferenceFromQuery(userQuery);

  let candidates = state.rentListings;
  if (hoods.length) {
    const set = new Set(hoods);
    candidates = candidates.filter((r) => set.has(r.hood));
  }
  if (min != null) candidates = candidates.filter((r) => r.rent >= min);
  if (max != null) candidates = candidates.filter((r) => r.rent <= max);
  if (bedHint != null) {
    candidates = candidates.filter((r) => r.beds == null || Math.abs(Number(r.beds) - bedHint) < 0.51);
  }

  if (!candidates.length) {
    candidates = state.rentListings;
    if (min != null) candidates = candidates.filter((r) => r.rent >= min);
    if (max != null) candidates = candidates.filter((r) => r.rent <= max);
    if (bedHint != null) candidates = candidates.filter((r) => r.beds == null || Math.abs(Number(r.beds) - bedHint) < 0.51);
  }

  if (!candidates.length) {
    return `San Francisco housing inventory: no rows matched the parsed filters (budget or bedroom). Ask the user to widen the rent range or remove bedroom filters. Dataset has ${state.rentListings.length} units with rent.`;
  }

  const scored = candidates.map((r) => {
    let score = 0;
    if (wantQuiet) {
      if (QUIET_FRIENDLY_HOODS.has(r.hood)) score += 6;
      if (BUSIER_HOODS.has(r.hood)) score -= 4;
    }
    score -= r.rent / 5000;
    return { r, score };
  });
  scored.sort((a, b) => b.score - a.score || a.r.rent - b.r.rent);

  const picked = [];
  const seen = new Set();
  for (const { r } of scored) {
    const key = `${r.addr}|${r.hood}|${r.rent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(r);
    if (picked.length >= RENT_CONTEXT_MAX_ROWS) break;
  }

  const payload = {
    source: "San Francisco Housing Inventory (rent_dataset_module2.csv)",
    note: "Rows are city-reported units; not guaranteed to be vacant or on the market today.",
    filters_applied: { min, max, neighborhoods: hoods, bedroom_hint: bedHint, quiet_bias: wantQuiet },
    listings: picked.map((r, i) => ({
      n: i + 1,
      block: r.addr,
      neighborhood: r.hood,
      monthly_rent_usd: Math.round(r.rent * 100) / 100,
      bedrooms: r.beds,
      bathrooms: r.baths,
      approx_sqft: r.sqft,
      inventory_year: r.year,
      supervisor_district: r.district,
    })),
  };
  return `San Francisco housing inventory sample (use for concrete SF examples only):\n${JSON.stringify(payload, null, 2)}`;
}

async function loadContextData() {
  const [meta, geo, summary] = await Promise.all([fetchJson(DATA_META), fetchJson(DATA_GEOJSON), parseCsv(DATA_SUMMARY)]);
  state.meta = meta;
  state.geo = geo;
  state.summaryRows = summary;
  state.gridById.clear();
  state.summaryByCluster.clear();

  for (const row of summary) {
    state.summaryByCluster.set(String(row.cluster), row);
  }
  for (const feat of geo.features ?? []) {
    const id = String(feat?.properties?.grid_id ?? "");
    if (id) state.gridById.set(id, feat.properties);
  }
}

function normalizeSociopaperRaw(text) {
  return String(text || "")
    .replace(/-\r?\n/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function buildSociopaperChunks(text) {
  const flat = normalizeSociopaperRaw(text).replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const sentences = flat.split(/(?<=[.!?])\s+/).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (const s of sentences) {
    const next = buf ? `${buf} ${s}` : s;
    if (next.length >= SOCIOPAPER_CHUNK_TARGET && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf = next;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.map((t, i) => ({ id: i + 1, text: t }));
}

function sociopaperQueryTokens(query) {
  const raw = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!raw) return [];
  return raw.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function sociopaperChunkScore(chunkText, tokens) {
  if (!tokens.length) return 0;
  const hay = chunkText.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

function retrieveSociopaperExcerpts(userQuery) {
  const tokens = sociopaperQueryTokens(userQuery);
  if (!state.sociopaperChunks.length) return "";
  const ranked = state.sociopaperChunks
    .map((c) => ({ c, score: sociopaperChunkScore(c.text, tokens) }))
    .sort((a, b) => b.score - a.score);
  const picked = (tokens.length ? ranked.filter((x) => x.score > 0) : ranked).slice(0, SOCIOPAPER_TOP_K).map((x) => x.c);
  const fallback = tokens.length && !picked.length ? ranked.slice(0, SOCIOPAPER_TOP_K).map((x) => x.c) : picked;
  const lines = fallback.map((c) => `[${SOCIOPAPER_ID} chunk ${c.id}]\n${c.text}`);
  return `Sociology paper excerpts (source: ${SOCIOPAPER_ID}.txt). Prefer these passages for concepts and citations when they are relevant; integrate with dashboard context where useful.\n\n${lines.join("\n\n")}`;
}

async function loadSociopaper() {
  try {
    const r = await fetch(SOCIOPAPER_TXT);
    if (!r.ok) throw new Error(`HTTP ${r.status} loading sociopaper`);
    const text = await r.text();
    state.sociopaperChunks = buildSociopaperChunks(text);
  } catch {
    state.sociopaperChunks = [];
  }
}

function contextPayload() {
  const mode = els.contextMode.value;
  const base = {
    mode,
    modeling_notes: {
      overall_fairness_level: "0-100 index for how balanced service access and quality are across areas",
      top3_gap_factors: "top 3 factors with the largest differences from city average in each cluster",
    },
    selected_cluster: els.clusterContext.value,
  };

  if (mode === "global") {
    return {
      ...base,
      clusters: state.summaryRows,
      cluster_names: state.meta?.config?.cluster_names ?? {},
    };
  }

  if (mode === "cluster") {
    const c = String(els.clusterContext.value);
    return {
      ...base,
      cluster: c,
      cluster_summary: state.summaryByCluster.get(c) ?? null,
      top_features: state.meta?.top3_features_per_cluster?.[c] ?? state.meta?.top3_features_per_cluster?.[Number(c)] ?? [],
      heuristics: state.meta?.heuristics?.[c] ?? state.meta?.heuristics?.[Number(c)] ?? null,
    };
  }

  const gid = String(els.gridContext.value).trim();
  const row = state.gridById.get(gid) ?? null;
  return {
    ...base,
    grid_id: gid,
    grid_record: row,
    cluster_summary: row ? state.summaryByCluster.get(String(row.cluster)) ?? null : null,
    cluster_top_features: row
      ? state.meta?.top3_features_per_cluster?.[String(row.cluster)] ??
        state.meta?.top3_features_per_cluster?.[Number(row.cluster)] ??
        []
      : [],
  };
}

function renderContextPreview() {
  els.contextPreview.value = JSON.stringify(contextPayload(), null, 2);
}

function bubble(role, text) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${role === "assistant" ? "assistant" : "user"}`;
  const meta = document.createElement("div");
  meta.className = "msgMeta";
  meta.textContent = role === "assistant" ? "Assistant" : "You";
  const body = document.createElement("pre");
  body.className = "msgBody";
  body.textContent = role === "assistant" ? sanitizeAssistantText(text) : text;
  wrap.appendChild(meta);
  wrap.appendChild(body);
  return wrap;
}

function renderChat() {
  els.chatMessages.innerHTML = "";
  for (const m of state.chat) {
    els.chatMessages.appendChild(bubble(m.role, m.content));
  }
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function providerFromModel(model) {
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  return "openai";
}

async function callOpenAI({ model, apiKey, messages, temperature, maxTokens }) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });
  if (!r.ok) throw new Error(`OpenAI error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.choices?.[0]?.message?.content ?? "(empty response)";
}

async function callAnthropic({ model, apiKey, messages, maxTokens, temperature }) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const msg = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system,
      messages: msg,
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.content?.map((c) => c?.text ?? "").join("\n").trim() || "(empty response)";
}

function toGeminiContents(messages) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
}

async function callGoogle({ model, apiKey, messages, temperature, maxTokens }) {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: toGeminiContents(messages),
      generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
      },
    }),
  });
  if (!r.ok) throw new Error(`Google error ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.candidates?.[0]?.content?.parts?.map((p) => p?.text ?? "").join("\n").trim() || "(empty response)";
}

async function callModel(opts) {
  const provider = providerFromModel(opts.model);
  if (provider === "anthropic") return callAnthropic(opts);
  if (provider === "google") return callGoogle(opts);
  return callOpenAI(opts);
}

function sanitizeAssistantText(text) {
  return String(text || "")
    // Remove bold + quoted emphasis like **"term"** or **“term”** or **'term'**
    .replace(/\*\*"(.*?)"\*\*/g, "$1")
    .replace(/\*\*“(.*?)”\*\*/g, "$1")
    .replace(/\*\*'(.*?)'\*\*/g, "$1")
    // Remove spaced variants like ** "term" **.
    .replace(/\*\*\s*["“'](.*?)["”']\s*\*\*/g, "$1")
    // Remove remaining markdown emphasis marks.
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    // Remove visible quote marks.
    .replace(/[“”"]/g, "")
    // Plain-language replacements for frequent jargon.
    .replace(/\bperformance mean\b/gi, "citywide average service level")
    .replace(/\bperformance_mean\b/gi, "citywide average service level")
    .replace(/\bneed mean\b/gi, "citywide average demand level")
    .replace(/\bneed_mean\b/gi, "citywide average demand level")
    .replace(/\bequity mean\b/gi, "citywide average fairness level")
    .replace(/\bequity_mean\b/gi, "citywide average fairness level")
    .replace(/\bequity score\b/gi, "overall fairness level")
    .replace(/\bperformance\b/gi, "service access and quality")
    .replace(/\bz-score\b/gi, "distance from city average")
    .replace(/\bpipeline\b/gi, "calculation process")
    // Replace raw cluster taxonomy labels with plain language.
    .replace(/\bcluster\s*[A-Z]\b(?:\s*[—-]\s*[^.,;\n]*)?/gi, "a similar neighborhood type")
    .replace(/\bDominant Residential\b/gi, "mainly residential areas");
}

function fullSystemPrompt(userQuery) {
  const manualPayload = (els.contextPreview.value || "").trim();
  const payloadText = manualPayload || JSON.stringify(contextPayload(), null, 2);
  const paper = retrieveSociopaperExcerpts(userQuery);
  const paperBlock = paper ? `\n\n${paper}` : "";
  const rentExcerpt = rentIntentFromQuery(userQuery)
    ? state.rentListings.length
      ? `\n\n${retrieveRentListings(userQuery)}`
      : "\n\nSan Francisco housing inventory CSV was not loaded; answer without inventing specific addresses."
    : "";
  return `${els.systemPrompt.value.trim()}\n\n${RESPONSE_STYLE_GUARD}\n\nContext payload (JSON):\n${payloadText}${paperBlock}${rentExcerpt}`;
}

async function send() {
  const userText = els.userInput.value.trim();
  if (!userText) return;
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    setStatus("Missing API key");
    return;
  }

  const model = selectedModel();
  const temperature = Number(els.temperature.value || 0.3);
  const maxTokens = Number(els.maxTokens.value || 900);

  state.chat.push({ role: "user", content: userText });
  state.chat = state.chat.slice(-MAX_HISTORY);
  els.userInput.value = "";
  renderChat();
  setStatus(`Calling ${model}...`);
  saveState();

  try {
    const messages = [{ role: "system", content: fullSystemPrompt(userText) }, ...state.chat];
    const rawContent = await callModel({
      model,
      apiKey,
      messages,
      temperature,
      maxTokens,
    });
    const content = sanitizeAssistantText(rawContent);
    state.chat.push({ role: "assistant", content });
    state.chat = state.chat.slice(-MAX_HISTORY);
    renderChat();
    setStatus(`Response received from ${model}`);
    saveState();
  } catch (err) {
    const msg = String(err?.message || err);
    state.chat.push({ role: "assistant", content: `Error: ${msg}` });
    renderChat();
    setStatus("Request failed");
  }
}

function bindEvents() {
  els.sendBtn.addEventListener("click", () => send());
  els.userInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
  });

  const persistHandlers = [
    els.modelSelect,
    els.customModel,
    els.apiKey,
    els.temperature,
    els.maxTokens,
    els.contextMode,
    els.clusterContext,
    els.gridContext,
    els.systemPrompt,
  ];
  for (const el of persistHandlers) {
    el.addEventListener("change", () => {
      renderContextPreview();
      saveState();
    });
  }
  els.gridContext.addEventListener("input", () => renderContextPreview());
  els.refreshContext.addEventListener("click", () => renderContextPreview());
  els.clearChat.addEventListener("click", () => {
    state.chat = [];
    renderChat();
    saveState();
    setStatus("Chat cleared");
  });
}

async function init() {
  els.systemPrompt.value = DEFAULT_SYSTEM_PROMPT;
  loadSavedState();
  bindEvents();
  renderChat();

  try {
    setStatus("Loading dashboard context and housing inventory...");
    await Promise.all([loadContextData(), loadSociopaper()]);
    try {
      state.rentListings = await loadRentDataset();
    } catch (e) {
      state.rentListings = [];
      console.warn("Rent dataset load failed", e);
    }
    renderContextPreview();
    const n = state.rentListings.length;
    setStatus(n ? `Ready (${n.toLocaleString()} SF inventory units)` : "Ready (housing inventory unavailable)");
  } catch (err) {
    const msg = String(err?.message || err);
    setStatus("Context load failed");
    els.contextPreview.value = `Failed to load outputs for context.\n${msg}`;
  }
}

init();
