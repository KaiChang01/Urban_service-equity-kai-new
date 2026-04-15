const DATA_BASE = new URL("../outputs/", import.meta.url);
const DATA_GEOJSON = new URL("grid_points.geojson", DATA_BASE).href;
const DATA_META = new URL("metadata.json", DATA_BASE).href;
const DATA_SUMMARY = new URL("cluster_summary.csv", DATA_BASE).href;
const SOCIOPAPER_TXT = new URL("../sociopaper/zahnow1.txt", import.meta.url).href;

const STORAGE_KEY = "equity_prompt_lab_v1";
const MAX_HISTORY = 16;
const SOCIOPAPER_ID = "zahnow1";
const SOCIOPAPER_TOP_K = 5;
const SOCIOPAPER_CHUNK_TARGET = 1100;
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
};

const DEFAULT_SYSTEM_PROMPT = `You are an urban service equity assistant.
Your job is to answer user questions clearly using dashboard data and policy reasoning.

Rules:
1) Separate your answer into: place-specific analysis, cluster-level analysis, and general recommendations.
2) If evidence is uncertain, say what is uncertain.
3) Cite concrete references when provided in context.
4) Keep explanations concise and actionable.
5) When sociology paper excerpts are included in the system message, ground relevant conceptual claims in those passages and cite them (e.g. zahnow1 chunk 3).

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
    state.chat = Array.isArray(saved.chat) ? saved.chat.slice(-MAX_HISTORY) : [];
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
      equity_score: "0-100 normalized score from performance/need ratio pipeline",
      top3_features: "cluster-level top 3 absolute z-score features vs city average",
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
  body.textContent = text;
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

function fullSystemPrompt(userQuery) {
  const manualPayload = (els.contextPreview.value || "").trim();
  const payloadText = manualPayload || JSON.stringify(contextPayload(), null, 2);
  const paper = retrieveSociopaperExcerpts(userQuery);
  const paperBlock = paper ? `\n\n${paper}` : "";
  return `${els.systemPrompt.value.trim()}\n\nContext payload (JSON):\n${payloadText}${paperBlock}`;
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
    const content = await callModel({
      model,
      apiKey,
      messages,
      temperature,
      maxTokens,
    });
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
    setStatus("Loading dashboard context...");
    await Promise.all([loadContextData(), loadSociopaper()]);
    renderContextPreview();
    setStatus("Ready");
  } catch (err) {
    const msg = String(err?.message || err);
    setStatus("Context load failed");
    els.contextPreview.value = `Failed to load outputs for context.\n${msg}`;
  }
}

init();
