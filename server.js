// ═══════════════════════════════════════════════════════
// server.js — RokyGPT avec système de Tools + Multi-Agents
// ═══════════════════════════════════════════════════════
const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");
const multer  = require("multer");
const path    = require("path");
const vm      = require("vm");

const app = express();
app.use(express.json());
app.use(cors());

const conversations = {};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ═══════════════════════════════════════════════════════
// CLÉS API — 1 par agent
// ═══════════════════════════════════════════════════════
const API_KEYS = [
  process.env.MISTRAL_API_KEY_1,
  process.env.MISTRAL_API_KEY_2,
  process.env.MISTRAL_API_KEY_3,
  process.env.MISTRAL_API_KEY_4,
  process.env.MISTRAL_API_KEY_5,
];

// Fallback : si une seule clé est définie (rétrocompatibilité)
if (!API_KEYS[0] && process.env.MISTRAL_API_KEY) {
  for (let i = 0; i < 5; i++) API_KEYS[i] = process.env.MISTRAL_API_KEY;
}

// ═══════════════════════════════════════════════════════
// SYSTEM PROMPTS
// ═══════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Tu es RokyGPT, un assistant intelligent, concis et un peu fun.

Tu as accès à des tools internes. Quand l'utilisateur te demande quelque chose qui correspond à un tool, réponds UNIQUEMENT avec un JSON valide sur une seule ligne, sans markdown, sans texte avant ou après :
{"tool":"NomDuTool","input":"...","explanation":"texte optionnel à afficher à l'utilisateur"}

Tools disponibles :
- "Date" : pour donner la date et/ou l'heure actuelle. input = ""
- "Calcul" : pour effectuer un calcul mathématique. input = expression mathématique (ex: "23*47", "Math.sqrt(144)", "2**10")
- "CodeJS" : pour exécuter du code JavaScript simple et sécurisé. input = le code JS à exécuter (retourner une valeur avec return ou console.log)
- "Mermaid" : pour générer un diagramme Mermaid statique. input = le code Mermaid complet (ex: "graph TD; A-->B")
- "Search" : pour rechercher des informations récentes sur le web via DuckDuckGo. input = la requête de recherche en français ou anglais
- "Interactive" : pour générer un composant interactif riche. Utilise ce tool quand l'utilisateur demande :
  * Une liste de tâches / checklist / todo list
  * Un graphique interactif / chart / courbe avec des données
  * Un graphique mathématique où on peut changer les paramètres
  * Un diagramme qu'on peut déplacer / drag & drop
  * Un tableau de données interactif / tri / filtre
  * Un formulaire ou outil interactif (calculateur, convertisseur, quiz, timer)
  * Tout composant visuel où l'utilisateur doit pouvoir cliquer, glisser, ou modifier des valeurs
  input = description précise de ce qu'il faut générer

Si aucun tool n'est nécessaire, réponds normalement en texte ou Markdown.

Ne retourne JAMAIS de JSON enveloppé dans du markdown. Seulement du JSON brut ou du texte.`;

const INTERACTIVE_SYSTEM_PROMPT = `Tu es un expert en développement web qui génère des composants HTML/CSS/JS interactifs magnifiques.

Tu dois générer UNIQUEMENT du code HTML complet et autonome (un seul fichier HTML avec <style> et <script> inclus).

RÈGLES ABSOLUES :
1. Retourne UNIQUEMENT le code HTML, rien d'autre — pas de markdown, pas d'explication, pas de \`\`\`html
2. Le HTML doit être complet et autonome (fonctionne seul dans un iframe)
3. Design sombre par défaut : background #1a1a1a, texte #ececec, accent #10a37f
4. Taille : s'adapte à la largeur disponible (max 100%), hauteur auto
5. Pas de body padding excessif, commence directement le contenu

LIBRAIRIES AUTORISÉES (CDN) :
- Chart.js : https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js
- Mermaid : https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js
- D3.js : https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js
- interact.js : https://cdn.jsdelivr.net/npm/interactjs@1.10.27/dist/interact.min.js

Génère maintenant le composant demandé. UNIQUEMENT le HTML, rien d'autre.`;

// ═══════════════════════════════════════════════════════
// PROMPTS AGENTS MULTI-AGENTS
// ═══════════════════════════════════════════════════════
const AGENT_PROMPTS = {
  respondeur: `Tu es l'agent Répondeur de RokyGPT. Tu dois produire une réponse initiale complète, claire et bien structurée à la question de l'utilisateur. Sois précis et direct. Si un tool est nécessaire (Date, Calcul, CodeJS, Mermaid, Search, Interactive), réponds avec le JSON du tool.`,

  critique: `Tu es l'agent Critique Logique de RokyGPT. Tu reçois une réponse initiale. Ton rôle : détecter les erreurs de raisonnement, les incohérences, les imprécisions ou les manques. Produis une version corrigée et améliorée de la réponse. Si la réponse initiale est correcte, améliore sa clarté et sa structure. Réponds directement avec la réponse améliorée, sans mentionner ton rôle.`,

  verificateur: `Tu es l'agent Vérificateur Factuel de RokyGPT. Tu reçois une réponse. Ton rôle : vérifier les faits, corriger les erreurs factuelles, ajouter des précisions importantes manquantes. Produis la version vérifiée et enrichie. Réponds directement avec la réponse finale, sans mentionner ton rôle.`,

  alternative: `Tu es l'agent Alternative de RokyGPT. Tu reçois une réponse. Ton rôle : proposer une perspective différente, un angle complémentaire, ou une approche alternative qui enrichit la réponse. Intègre cet apport dans une réponse unifiée. Réponds directement, sans mentionner ton rôle.`,

  juge: `Tu es l'agent Juge Final de RokyGPT. Tu reçois plusieurs versions d'une réponse produites par différents agents. Ton rôle : fusionner le meilleur de chaque version pour produire LA réponse finale parfaite — précise, claire, complète et bien structurée. Réponds directement avec la réponse finale optimale, sans mentionner le processus multi-agents.`,
};

// ═══════════════════════════════════════════════════════
// APPEL MISTRAL GÉNÉRIQUE
// ═══════════════════════════════════════════════════════
async function callMistral(messages, apiKey, { temperature = 0.7, max_tokens = 2048, model = "mistral-small-latest" } = {}) {
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens }),
  });
  if (!response.ok) throw new Error(`Mistral HTTP ${response.status}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

// ═══════════════════════════════════════════════════════
// PIPELINE MULTI-AGENTS
// ═══════════════════════════════════════════════════════

/*
  FAST    : 1 agent  — Répondeur seul              (KEY_1)
  BALANCED: 3 agents — Répondeur → Critique → Juge (KEY_1, KEY_2, KEY_3)
  THINKING: 5 agents — Répondeur → Critique → Vérificateur → Alternative → Juge
                                                   (KEY_1 … KEY_5)
*/

async function runPipeline(mode, userMessage, conversationHistory, memories) {
  // System avec mémoires
  const sysContent = memories && memories.trim()
    ? SYSTEM_PROMPT + `\n\n📌 INSTRUCTIONS PERMANENTES :\n${memories.trim()}`
    : SYSTEM_PROMPT;

  // Historique de conversation (sans le system, on le réinjecte proprement)
  const historyWithoutSystem = conversationHistory.filter(m => m.role !== "system");

  console.log(`[Pipeline] Mode: ${mode.toUpperCase()}`);

  // ── FAST : 1 seul appel, exactement comme avant ──
  if (mode === "fast") {
    const messages = [
      { role: "system", content: sysContent },
      ...historyWithoutSystem,
      { role: "user", content: userMessage },
    ];
    const reply = await callMistral(messages, API_KEYS[0]);
    return { reply, agentCount: 1 };
  }

  // ── BALANCED : Répondeur → Critique → Juge ──
  if (mode === "balanced") {
    const baseMessages = [
      { role: "system", content: sysContent },
      ...historyWithoutSystem,
      { role: "user", content: userMessage },
    ];

    // Agent 1 — Répondeur
    console.log("[Pipeline] Agent 1: Répondeur");
    const rep1 = await callMistral(
      [{ role: "system", content: AGENT_PROMPTS.respondeur }, ...baseMessages.slice(1)],
      API_KEYS[0]
    );

    // Détection tool dès le premier agent
    const toolCheck = detectAndRunTool(rep1);
    if (toolCheck && !toolCheck.async) return { reply: toolCheck.reply, tool: toolCheck.tool, agentCount: 1 };
    if (toolCheck && toolCheck.async) return { toolResult: toolCheck, agentCount: 1 };

    // Agent 2 — Critique
    console.log("[Pipeline] Agent 2: Critique");
    const rep2 = await callMistral(
      [
        { role: "system", content: AGENT_PROMPTS.critique },
        { role: "user", content: `Question originale : "${userMessage}"\n\nRéponse initiale à améliorer :\n${rep1}` },
      ],
      API_KEYS[1]
    );

    // Agent 3 — Juge final
    console.log("[Pipeline] Agent 3: Juge");
    const rep3 = await callMistral(
      [
        { role: "system", content: AGENT_PROMPTS.juge },
        {
          role: "user",
          content: `Question : "${userMessage}"\n\nVersion 1 (initiale) :\n${rep1}\n\nVersion 2 (améliorée) :\n${rep2}\n\nProduis la réponse finale optimale.`,
        },
      ],
      API_KEYS[2]
    );

    return { reply: rep3, agentCount: 3 };
  }

  // ── THINKING : 5 agents ──
  if (mode === "thinking") {
    const baseMessages = [
      { role: "system", content: sysContent },
      ...historyWithoutSystem,
      { role: "user", content: userMessage },
    ];

    // Agent 1 — Répondeur
    console.log("[Pipeline] Agent 1: Répondeur");
    const rep1 = await callMistral(
      [{ role: "system", content: AGENT_PROMPTS.respondeur }, ...baseMessages.slice(1)],
      API_KEYS[0]
    );

    // Détection tool
    const toolCheck = detectAndRunTool(rep1);
    if (toolCheck && !toolCheck.async) return { reply: toolCheck.reply, tool: toolCheck.tool, agentCount: 1 };
    if (toolCheck && toolCheck.async) return { toolResult: toolCheck, agentCount: 1 };

    // Agent 2 — Critique
    console.log("[Pipeline] Agent 2: Critique");
    const rep2 = await callMistral(
      [
        { role: "system", content: AGENT_PROMPTS.critique },
        { role: "user", content: `Question : "${userMessage}"\n\nRéponse initiale :\n${rep1}` },
      ],
      API_KEYS[1]
    );

    // Agent 3 — Vérificateur (en parallèle avec Agent 4 pour gagner du temps)
    console.log("[Pipeline] Agents 3+4 en parallèle: Vérificateur + Alternative");
    const [rep3, rep4] = await Promise.all([
      callMistral(
        [
          { role: "system", content: AGENT_PROMPTS.verificateur },
          { role: "user", content: `Question : "${userMessage}"\n\nRéponse à vérifier :\n${rep2}` },
        ],
        API_KEYS[2]
      ),
      callMistral(
        [
          { role: "system", content: AGENT_PROMPTS.alternative },
          { role: "user", content: `Question : "${userMessage}"\n\nRéponse existante :\n${rep2}` },
        ],
        API_KEYS[3]
      ),
    ]);

    // Agent 5 — Juge final
    console.log("[Pipeline] Agent 5: Juge Final");
    const rep5 = await callMistral(
      [
        { role: "system", content: AGENT_PROMPTS.juge },
        {
          role: "user",
          content: `Question : "${userMessage}"

Version initiale :
${rep1}

Version critiquée et améliorée :
${rep2}

Version vérifiée factuellement :
${rep3}

Perspective alternative :
${rep4}

Produis LA réponse finale parfaite en fusionnant le meilleur de chaque version.`,
        },
      ],
      API_KEYS[4]
    );

    return { reply: rep5, agentCount: 5 };
  }

  // Fallback
  const messages = [
    { role: "system", content: sysContent },
    ...historyWithoutSystem,
    { role: "user", content: userMessage },
  ];
  const reply = await callMistral(messages, API_KEYS[0]);
  return { reply, agentCount: 1 };
}

// ═══════════════════════════════════════════════════════
// TOOLS
// ═══════════════════════════════════════════════════════
function toolDate() {
  const now = new Date();
  const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const dateStr = now.toLocaleDateString("fr-FR", options);
  const timeStr = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `📅 **${dateStr}** — il est **${timeStr}**`;
}

function toolCalc(expression) {
  if (!expression || expression.trim().length === 0) return "❌ Expression vide.";
  if (expression.length > 500) return "❌ Expression trop longue.";
  const safe = /^[\d\s\+\-\*\/\%\(\)\.\,MathsqrtpowlogfloorceileabsroundPIEsincostan]+$/.test(expression.replace(/\s/g, ""));
  if (!safe) return "❌ Expression non autorisée.";
  try {
    const sandbox = { Math, result: undefined };
    vm.runInNewContext(`result = (${expression})`, sandbox, { timeout: 500 });
    const r = sandbox.result;
    if (r === undefined || r === null || (typeof r === "number" && isNaN(r))) return "❌ Résultat invalide.";
    return `🧮 **${expression}** = **${r}**`;
  } catch (e) {
    return `❌ Erreur de calcul : ${e.message}`;
  }
}

function toolCodeJS(code) {
  if (!code || code.trim().length === 0) return "❌ Code vide.";
  if (code.length > 2000) return "❌ Code trop long.";
  const forbidden = ["require", "process", "__dirname", "__filename", "global", "Buffer", "eval", "Function(", "fetch", "import"];
  for (const kw of forbidden) {
    if (code.includes(kw)) return `❌ Mot-clé interdit : \`${kw}\``;
  }
  const logs = [];
  const sandbox = {
    Math, JSON, parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object,
    console: {
      log: (...args) => logs.push(args.map(a => { try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); } }).join(" ")),
      error: (...args) => logs.push("ERR: " + args.join(" ")),
    },
    result: undefined,
  };
  try {
    const r = vm.runInNewContext(`(function(){ ${code} })()`, sandbox, { timeout: 1000 });
    const output = r !== undefined ? r : null;
    let reply = "";
    if (logs.length) reply += "```\n" + logs.join("\n") + "\n```\n";
    if (output !== undefined && output !== null) {
      const out = typeof output === "object" ? JSON.stringify(output, null, 2) : String(output);
      reply += "**Résultat :** `" + out + "`";
    }
    return reply || "✅ Code exécuté (aucune sortie).";
  } catch (e) {
    return `❌ Erreur JS : \`${e.message}\``;
  }
}

function toolMermaid(input) {
  if (!input || input.trim().length === 0) return { type: "mermaid", code: "graph TD\n  A[Erreur] --> B[Input vide]" };
  return { type: "mermaid", code: input.trim() };
}

async function toolInteractive(description, apiKey) {
  console.log(`[Interactive] Génération : "${description}"`);
  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: INTERACTIVE_SYSTEM_PROMPT },
        { role: "user", content: `Génère ce composant interactif : ${description}` },
      ],
      temperature: 0.3,
      max_tokens: 4096,
    }),
  });
  if (!response.ok) throw new Error(`Mistral Interactive HTTP ${response.status}`);
  const data = await response.json();
  let html = data.choices?.[0]?.message?.content?.trim() || "";
  html = html.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();
  if (!html.includes("<")) throw new Error("HTML invalide");
  return html;
}

// ═══════════════════════════════════════════════════════
// DÉTECTION TOOL
// ═══════════════════════════════════════════════════════
function detectAndRunTool(rawReply) {
  const trimmed = rawReply.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed;
  try {
    const match = trimmed.match(/^\{[\s\S]*?\}(?=\s*$|\s*\n)/);
    parsed = JSON.parse(match ? match[0] : trimmed);
  } catch { return null; }
  if (!parsed || !parsed.tool) return null;
  const tool = parsed.tool, input = parsed.input || "", explanation = parsed.explanation || "";
  if (tool === "Search") return { async: true, asyncType: "search", query: input, explanation };
  if (tool === "Interactive") return { async: true, asyncType: "interactive", description: input, explanation };
  let toolResult = "", isMermaid = false, mermaidCode = "";
  switch (tool) {
    case "Date":    toolResult = toolDate(); break;
    case "Calcul":  toolResult = toolCalc(input); break;
    case "CodeJS":  toolResult = toolCodeJS(input); break;
    case "Mermaid": { const r = toolMermaid(input); isMermaid = true; mermaidCode = r.code; break; }
    default: return null;
  }
  if (isMermaid) {
    return { reply: (explanation ? explanation + "\n\n" : "") + "```mermaid\n" + mermaidCode + "\n```", tool };
  }
  return { reply: (explanation ? explanation + "\n\n" : "") + toolResult, tool };
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════
app.post("/restore", (req, res) => {
  const { userId, messages, memory } = req.body;
  if (!userId || !Array.isArray(messages)) return res.status(400).json({ error: "Données invalides" });
  const systemContent = memory && memory.trim()
    ? SYSTEM_PROMPT + `\n\n📌 INSTRUCTIONS PERMANENTES :\n${memory.trim()}`
    : SYSTEM_PROMPT;
  conversations[userId] = [
    { role: "system", content: systemContent },
    ...messages,
  ];
  res.json({ success: true });
});

app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId, memory, mode = "fast" } = req.body;
  const files = req.files || [];
  if (!userId) return res.status(400).json({ error: "Missing userId" });

  // Mémorise la mémoire dans l'historique si conversation nouvelle
  const memories = memory && memory.trim() ? memory.trim() : "";

  if (!conversations[userId]) {
    const systemContent = memories
      ? SYSTEM_PROMPT + `\n\n📌 INSTRUCTIONS PERMANENTES :\n${memories}`
      : SYSTEM_PROMPT;
    conversations[userId] = [{ role: "system", content: systemContent }];
  }

  let content = message || "";
  if (files.length > 0) content += `\n[Fichiers joints : ${files.map(f => f.originalname).join(", ")}]`;

  conversations[userId].push({ role: "user", content });

  // Trim historique
  if (conversations[userId].length > 42) {
    conversations[userId] = [conversations[userId][0], ...conversations[userId].slice(-40)];
  }

  try {
    // Lance le pipeline selon le mode
    const pipelineResult = await runPipeline(
      mode,
      content,
      conversations[userId],
      memories
    );

    let finalReply, usedTool = null, interactiveHtml = null;

    // Si le pipeline a renvoyé un tool async à traiter
    if (pipelineResult.toolResult) {
      const toolResult = pipelineResult.toolResult;
      if (toolResult.asyncType === "search") {
        usedTool = "Search";
        try {
          finalReply = await toolSearchAndSynthesize(toolResult.query, content, API_KEYS[0]);
        } catch (e) {
          finalReply = `❌ Erreur recherche : ${e.message}`;
        }
      } else if (toolResult.asyncType === "interactive") {
        usedTool = "Interactive";
        try {
          interactiveHtml = await toolInteractive(toolResult.description, API_KEYS[0]);
          finalReply = toolResult.explanation || "Voici ton composant interactif ✨";
        } catch (e) {
          finalReply = `❌ Erreur composant : ${e.message}`;
        }
      }
    } else {
      // Réponse texte normale — vérifier si c'est un tool sync
      const rawReply = pipelineResult.reply || "";
      const toolResult = detectAndRunTool(rawReply);
      if (toolResult && toolResult.async) {
        if (toolResult.asyncType === "search") {
          usedTool = "Search";
          try { finalReply = await toolSearchAndSynthesize(toolResult.query, content, API_KEYS[0]); }
          catch (e) { finalReply = `❌ Erreur recherche : ${e.message}`; }
        } else if (toolResult.asyncType === "interactive") {
          usedTool = "Interactive";
          try {
            interactiveHtml = await toolInteractive(toolResult.description, API_KEYS[0]);
            finalReply = toolResult.explanation || "Voici ton composant interactif ✨";
          } catch (e) { finalReply = `❌ Erreur composant : ${e.message}`; }
        }
      } else if (toolResult) {
        finalReply = toolResult.reply;
        usedTool = toolResult.tool;
      } else {
        finalReply = rawReply;
      }
    }

    if (pipelineResult.tool) usedTool = pipelineResult.tool;

    conversations[userId].push({ role: "assistant", content: finalReply });
    res.json({ reply: finalReply, tool: usedTool, interactiveHtml, mode, agentCount: pipelineResult.agentCount });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Erreur connexion Mistral – réessaie !" });
  }
});

// ═══════════════════════════════════════════════════════
// TOOL : NAVIGATION WEB (inchangé)
// ═══════════════════════════════════════════════════════
const PAGE_TIMEOUT_MS = 5000, MAX_PAGE_CHARS = 4000, PAGES_TO_BROWSE = 3;

async function browsePage(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      },
    });
    clearTimeout(timer);
    if (!response.ok) return { url, ok: false, text: "" };
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) return { url, ok: false, text: "" };
    const html = await response.text();
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|br)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ")
      .replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();
    if (text.length > MAX_PAGE_CHARS) text = text.slice(0, MAX_PAGE_CHARS) + "…";
    return { url, ok: true, text };
  } catch (e) {
    return { url, ok: false, text: "" };
  }
}

async function toolSearchAndSynthesize(query, userQuestion, apiKey) {
  const { results, method } = await duckSearch(query);
  if (!results.length) return `🔍 Aucun résultat trouvé pour **"${query}"**.`;
  const toVisit = results.slice(0, PAGES_TO_BROWSE);
  const pageResults = await Promise.all(toVisit.map(r => browsePage(r.url)));
  const successPages = pageResults.filter(p => p.ok && p.text.trim().length > 100);
  let pagesContext = successPages.length > 0
    ? successPages.map((p, i) => `[PAGE ${i+1}] Source : ${p.url}\n${p.text}`).join("\n\n---\n\n")
    : `Titres : ${results.map((r,i) => `${i+1}. ${r.title}`).join("; ")}`;
  const sourcesBlock = results.slice(0, 5).map((r, i) => `${i+1}. [${r.title}](${r.url})`).join("\n");
  const synthesisPrompt = `Tu es RokyGPT. Question : "${userQuestion}"\n\nContenu web (recherche "${query}") :\n${pagesContext}\n\nRéponds clairement en français, structuré, sans copier-coller brut.`;
  const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "mistral-small-latest", messages: [{ role: "user", content: synthesisPrompt }], temperature: 0.4, max_tokens: 1024 }),
  });
  if (!mistralRes.ok) throw new Error(`Mistral synthesis HTTP ${mistralRes.status}`);
  const mistralData = await mistralRes.json();
  const synthesis = mistralData.choices?.[0]?.message?.content?.trim() || "Synthèse indisponible.";
  return `${synthesis}\n\n---\n🔍 **Sources** :\n${sourcesBlock}`;
}

async function duckSearchHTML(query) {
  const encoded = encodeURIComponent(query);
  const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}&kl=fr-fr`, {
    headers: { "User-Agent": "Mozilla/5.0 Chrome/124.0.0.0 Safari/537.36", "Accept-Language": "fr-FR,fr;q=0.9" },
  });
  if (!response.ok) throw new Error(`DDG HTML ${response.status}`);
  const html = await response.text();
  const results = [], seen = new Set();
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 5) {
    let href = m[1];
    const rawTitle = m[2].replace(/<[^>]+>/g,"").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
    if (!rawTitle || rawTitle.length < 3) continue;
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) { try { href = decodeURIComponent(uddgMatch[1]); } catch {} }
    else if (href.startsWith("//")) href = "https:" + href;
    if (!href.startsWith("http") || href.includes("duckduckgo.com") || seen.has(href)) continue;
    seen.add(href);
    results.push({ title: rawTitle.slice(0, 120), url: href });
  }
  return results;
}

async function duckSearchJSON(query) {
  const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`, {
    headers: { "User-Agent": "RokyGPT/1.0" },
  });
  if (!response.ok) return [];
  const data = await response.json();
  const raw = [];
  if (data.AbstractURL && data.AbstractText) raw.push({ title: data.Heading || data.AbstractText.slice(0,120), url: data.AbstractURL });
  const flatten = t => t.forEach(i => i.Topics ? flatten(i.Topics) : i.FirstURL && i.Text && raw.push({ title: i.Text.replace(/<[^>]+>/g,"").slice(0,120), url: i.FirstURL }));
  if (Array.isArray(data.RelatedTopics)) flatten(data.RelatedTopics);
  const seen = new Set();
  return raw.filter(r => r.url && r.title && !seen.has(r.url) && seen.add(r.url)).slice(0, 5);
}

async function duckSearch(query) {
  let results = [], method = "html";
  try { results = await duckSearchHTML(query); } catch (e) { method = "json-fallback"; }
  if (!results.length) { try { results = await duckSearchJSON(query); method = "json-fallback"; } catch {} }
  return { results, method };
}

app.post("/duck-search", async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) return res.status(400).json({ error: "Query manquant" });
  try {
    const data = await duckSearch(query.trim());
    res.json({ results: data.results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RokyGPT sur le port ${PORT}`));
