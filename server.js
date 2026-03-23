// ═══════════════════════════════════════════════════════
// server.js — RokyGPT avec système de Tools internes
// ═══════════════════════════════════════════════════════
const express = require("express");
const fetch   = require("node-fetch");
const cors    = require("cors");
const multer  = require("multer");
const path    = require("path");
const vm      = require("vm"); // sandbox natif Node.js — pas de dépendance externe

const app = express();
app.use(express.json());
app.use(cors());

const conversations = {};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const API_KEY = process.env.MISTRAL_API_KEY;

// ═══════════════════════════════════════════════════════
// SYSTEM PROMPT — explique à Mistral comment utiliser les tools
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
  * Une liste de tâches / checklist / todo list (ex: "fais-moi une liste de courses", "liste des étapes pour...")
  * Un graphique interactif / chart / courbe avec des données (ex: "fais un graphique des ventes", "montre-moi une courbe sin(x)")
  * Un graphique mathématique où on peut changer les paramètres / axes (ex: "graphique de sin(x)", "courbe de y=ax²", "fonction interactive")
  * Un diagramme qu'on peut déplacer / drag & drop (ex: "diagramme interactif", "flowchart qu'on peut bouger")
  * Un tableau de données interactif / tri / filtre
  * Un formulaire ou outil interactif (calculateur, convertisseur, quiz, timer)
  * Tout composant visuel où l'utilisateur doit pouvoir cliquer, glisser, ou modifier des valeurs
  input = description précise de ce qu'il faut générer (type, données, style)

Si aucun tool n'est nécessaire, réponds normalement en texte ou Markdown.

Exemples :
- "Quel jour sommes nous ?" → {"tool":"Date","input":""}
- "Calcule 23 * 47" → {"tool":"Calcul","input":"23*47"}
- "Fais un diagramme de A vers B vers C" → {"tool":"Mermaid","input":"graph TD\\n  A-->B\\n  B-->C"}
- "Exécute ce code JS : [1,2,3].map(x=>x*2)" → {"tool":"CodeJS","input":"return [1,2,3].map(x=>x*2)"}
- "Cherche des infos sur Node.js" → {"tool":"Search","input":"Node.js"}
- "Quelles sont les dernières news sur l'IA ?" → {"tool":"Search","input":"latest AI news 2025"}
- "Fais-moi une liste de courses" → {"tool":"Interactive","input":"checklist liste de courses avec des items typiques (pain, lait, œufs, fruits, légumes, viande)"}
- "Graphique de sin(x) interactif" → {"tool":"Interactive","input":"graphique mathématique interactif de la fonction sin(x) avec slider pour amplitude et fréquence, axes déplaçables"}
- "Diagramme flowchart qu'on peut bouger" → {"tool":"Interactive","input":"diagramme flowchart drag-and-drop d'un processus de connexion utilisateur"}
- "Fais un graphique des ventes par mois" → {"tool":"Interactive","input":"graphique bar chart des ventes mensuelles sur 12 mois avec données réalistes, interactif avec tooltip"}

Ne retourne JAMAIS de JSON enveloppé dans du markdown. Seulement du JSON brut ou du texte.`;

// ═══════════════════════════════════════════════════════
// SYSTEM PROMPT pour la génération de composants interactifs
// ═══════════════════════════════════════════════════════
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
- interact.js (drag & drop) : https://cdn.jsdelivr.net/npm/interactjs@1.10.27/dist/interact.min.js

TYPES DE COMPOSANTS À SAVOIR FAIRE PARFAITEMENT :

1. CHECKLIST / TODO :
   - Cases à cocher stylisées (pas les <input> natifs moches)
   - Animation au coche (✓ avec transition)
   - Texte barré quand coché
   - Compteur "X/Y complétés"
   - Bouton "Tout cocher" / "Réinitialiser"
   - Drag pour réorganiser les items

2. GRAPHIQUE MATHÉMATIQUE INTERACTIF :
   - Canvas ou SVG pour dessiner la courbe
   - Sliders pour modifier les paramètres (amplitude, fréquence, phase...)
   - Axes X et Y avec graduations
   - Pan (déplacer) et zoom avec la molette
   - Affichage de la formule en temps réel
   - Crosshair au survol avec coordonnées

3. CHART DE DONNÉES (Chart.js) :
   - Bar chart, line chart, pie chart selon le contexte
   - Tooltips au survol
   - Légende interactive (clic pour masquer/afficher)
   - Animation d'entrée
   - Couleurs cohérentes avec le thème sombre

4. DIAGRAMME DRAG & DROP :
   - Nœuds déplaçables avec interact.js
   - Connexions SVG qui suivent les nœuds
   - Double-clic pour éditer le texte d'un nœud
   - Bouton pour ajouter un nœud
   - Snap to grid optionnel

5. TABLEAU INTERACTIF :
   - Tri par colonne (clic header)
   - Filtre/recherche en temps réel
   - Pagination
   - Export CSV

6. OUTILS (calculateur, timer, quiz...) :
   - Interface soignée et intuitive
   - Feedback visuel immédiat
   - Animations et transitions

STYLE OBLIGATOIRE :
\`\`\`css
* { margin: 0; padding: 0; box-sizing: border-box; }
body { 
  background: #1a1a1a; 
  color: #ececec; 
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  padding: 12px;
  min-height: 100vh;
}
\`\`\`

Génère maintenant le composant demandé. UNIQUEMENT le HTML, rien d'autre.`;

// ═══════════════════════════════════════════════════════
// TOOLS — exécutés côté serveur, sécurisés
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
  if (!safe) return "❌ Expression non autorisée (caractères invalides).";

  try {
    const sandbox = { Math, result: undefined };
    const code = `result = (${expression})`;
    vm.runInNewContext(code, sandbox, { timeout: 500 });
    const r = sandbox.result;
    if (r === undefined || r === null || (typeof r === "number" && isNaN(r))) {
      return "❌ Le calcul n'a pas produit de résultat valide.";
    }
    return `🧮 **${expression}** = **${r}**`;
  } catch (e) {
    return `❌ Erreur de calcul : ${e.message}`;
  }
}

function toolCodeJS(code) {
  if (!code || code.trim().length === 0) return "❌ Code vide.";
  if (code.length > 2000) return "❌ Code trop long (max 2000 caractères).";

  const forbidden = ["require", "process", "__dirname", "__filename", "global", "Buffer", "eval", "Function(", "fetch", "import"];
  for (const kw of forbidden) {
    if (code.includes(kw)) return `❌ Mot-clé interdit : \`${kw}\``;
  }

  const logs = [];
  const sandbox = {
    Math, JSON, parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object,
    console: {
      log: (...args) => logs.push(args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); }
      }).join(" ")),
      error: (...args) => logs.push("ERR: " + args.join(" "))
    },
    result: undefined
  };

  try {
    const wrapped = `(function(){ ${code} })()`;
    const r = vm.runInNewContext(wrapped, sandbox, { timeout: 1000 });
    const output = r !== undefined ? r : (logs.length ? null : undefined);
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

// ═══════════════════════════════════════════════════════
// TOOL : INTERACTIVE — génère un composant HTML interactif via Mistral
// ═══════════════════════════════════════════════════════
async function toolInteractive(description, apiKey) {
  console.log(`[Interactive] Génération : "${description}"`);

  const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [
        { role: "system", content: INTERACTIVE_SYSTEM_PROMPT },
        { role: "user", content: `Génère ce composant interactif : ${description}` }
      ],
      temperature: 0.3,
      max_tokens: 4096
    })
  });

  if (!response.ok) throw new Error(`Mistral Interactive HTTP ${response.status}`);

  const data = await response.json();
  let html = data.choices?.[0]?.message?.content?.trim() || "";

  // Nettoyer si Mistral a quand même mis des backticks
  html = html.replace(/^```html\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/, "").trim();

  if (!html.includes("<")) {
    throw new Error("La réponse ne contient pas de HTML valide");
  }

  console.log(`[Interactive] ✅ HTML généré (${html.length} chars)`);
  return html;
}

// ═══════════════════════════════════════════════════════
// DÉTECTION ET EXÉCUTION DU TOOL
// ═══════════════════════════════════════════════════════
function detectAndRunTool(rawReply) {
  const trimmed = rawReply.trim();
  if (!trimmed.startsWith("{")) return null;

  let parsed;
  try {
    const match = trimmed.match(/^\{[\s\S]*?\}(?=\s*$|\s*\n)/);
    parsed = JSON.parse(match ? match[0] : trimmed);
  } catch {
    return null;
  }

  if (!parsed || !parsed.tool) return null;

  const tool = parsed.tool;
  const input = parsed.input || "";
  const explanation = parsed.explanation || "";

  // Tools async
  if (tool === "Search") return { async: true, asyncType: "search", query: input, explanation };
  if (tool === "Interactive") return { async: true, asyncType: "interactive", description: input, explanation };

  // Tools sync
  let toolResult = "";
  let isMermaid = false;
  let mermaidCode = "";

  switch (tool) {
    case "Date":
      toolResult = toolDate();
      break;
    case "Calcul":
      toolResult = toolCalc(input);
      break;
    case "CodeJS":
      toolResult = toolCodeJS(input);
      break;
    case "Mermaid": {
      const r = toolMermaid(input);
      isMermaid = true;
      mermaidCode = r.code;
      break;
    }
    default:
      return null;
  }

  if (isMermaid) {
    const reply = (explanation ? explanation + "\n\n" : "") + "```mermaid\n" + mermaidCode + "\n```";
    return { reply, tool };
  }

  const reply = (explanation ? explanation + "\n\n" : "") + toolResult;
  return { reply, tool };
}

// ═══════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════

app.post("/restore", (req, res) => {
  const { userId, messages, memory } = req.body;
  if (!userId || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Données invalides pour restore" });
  }
  const systemContent = memory && memory.trim()
    ? SYSTEM_PROMPT + `\n\n📌 INSTRUCTIONS PERMANENTES DE L'UTILISATEUR (à respecter absolument) :\n${memory.trim()}`
    : SYSTEM_PROMPT;
  conversations[userId] = [
    { role: "system", content: systemContent },
    ...messages
  ];
  res.json({ success: true });
});

app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId, memory } = req.body;
  const files = req.files || [];

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!conversations[userId]) {
    const systemContent = memory && memory.trim()
      ? SYSTEM_PROMPT + `\n\n📌 INSTRUCTIONS PERMANENTES DE L'UTILISATEUR (à respecter absolument) :\n${memory.trim()}`
      : SYSTEM_PROMPT;
    conversations[userId] = [{ role: "system", content: systemContent }];
  }

  let content = message || "";
  if (files.length > 0) {
    content += `\n[Fichiers joints : ${files.map(f => f.originalname).join(", ")}]`;
  }

  conversations[userId].push({ role: "user", content });

  if (conversations[userId].length > 42) {
    conversations[userId] = [
      conversations[userId][0],
      ...conversations[userId].slice(-40)
    ];
  }

  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: conversations[userId],
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    if (!response.ok) throw new Error(`Mistral error ${response.status}`);

    const data = await response.json();
    let rawReply = data.choices?.[0]?.message?.content || "Désolé, je n'ai pas compris...";

    const toolResult = detectAndRunTool(rawReply);
    let finalReply;
    let usedTool = null;
    let interactiveHtml = null;

    if (toolResult && toolResult.async) {

      if (toolResult.asyncType === "search") {
        // ── Tool Search ──
        usedTool = "Search";
        try {
          finalReply = await toolSearchAndSynthesize(toolResult.query, content, API_KEY);
        } catch (e) {
          console.error("[Search] Erreur globale :", e.message);
          finalReply = `❌ Erreur lors de la recherche web : ${e.message}`;
        }
        conversations[userId].push({ role: "assistant", content: finalReply });

      } else if (toolResult.asyncType === "interactive") {
        // ── Tool Interactive ──
        usedTool = "Interactive";
        try {
          interactiveHtml = await toolInteractive(toolResult.description, API_KEY);
          finalReply = toolResult.explanation || "Voici ton composant interactif ✨";
        } catch (e) {
          console.error("[Interactive] Erreur :", e.message);
          finalReply = `❌ Erreur lors de la génération du composant : ${e.message}`;
          interactiveHtml = null;
        }
        conversations[userId].push({ role: "assistant", content: finalReply });
      }

    } else if (toolResult) {
      finalReply = toolResult.reply;
      usedTool = toolResult.tool;
      conversations[userId].push({ role: "assistant", content: finalReply });
    } else {
      finalReply = rawReply;
      conversations[userId].push({ role: "assistant", content: finalReply });
    }

    res.json({ reply: finalReply, tool: usedTool, interactiveHtml });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Erreur connexion Mistral – réessaie !" });
  }
});

// ═══════════════════════════════════════════════════════
// TOOL : NAVIGATION WEB
// ═══════════════════════════════════════════════════════
const PAGE_TIMEOUT_MS  = 5000;
const MAX_PAGE_CHARS   = 4000;
const PAGES_TO_BROWSE  = 3;

async function browsePage(url) {
  const label = `[browse] ${url}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8"
      }
    });
    clearTimeout(timer);

    if (!response.ok) {
      console.warn(`${label} → HTTP ${response.status} (ignoré)`);
      return { url, ok: false, error: `HTTP ${response.status}`, text: "" };
    }

    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) {
      console.warn(`${label} → type non-HTML (${ct}), ignoré`);
      return { url, ok: false, error: "non-HTML", text: "" };
    }

    const html = await response.text();

    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|br)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (text.length > MAX_PAGE_CHARS) {
      text = text.slice(0, MAX_PAGE_CHARS) + "…";
    }

    console.log(`${label} → ✅ ${text.length} caractères extraits`);
    return { url, ok: true, text };

  } catch (e) {
    const reason = e.name === "AbortError" ? "timeout (5s)" : e.message;
    console.warn(`${label} → ❌ ${reason}`);
    return { url, ok: false, error: reason, text: "" };
  }
}

async function toolSearchAndSynthesize(query, userQuestion, apiKey) {
  console.log(`[Search] 🔍 Recherche : "${query}"`);
  const { results, method } = await duckSearch(query);

  if (!results.length) {
    return `🔍 Aucun résultat trouvé pour **"${query}"**. Essayez une formulation différente.`;
  }

  console.log(`[Search] ${results.length} URL(s) trouvée(s) [méthode: ${method}]`);

  const toVisit = results.slice(0, PAGES_TO_BROWSE);
  const pageResults = await Promise.all(toVisit.map(r => browsePage(r.url)));
  const successPages = pageResults.filter(p => p.ok && p.text.trim().length > 100);

  let pagesContext = "";
  if (successPages.length > 0) {
    pagesContext = successPages.map((p, i) =>
      `[PAGE ${i + 1}] Source : ${p.url}\n${p.text}`
    ).join("\n\n---\n\n");
  } else {
    const titlesOnly = results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}`).join("\n");
    pagesContext = `Aucun contenu de page n'a pu être extrait. Voici les titres des résultats :\n${titlesOnly}`;
  }

  const sourcesBlock = results.slice(0, 5).map((r, i) => `${i + 1}. [${r.title}](${r.url})`).join("\n");

  const synthesisPrompt = `Tu es RokyGPT. Un utilisateur t'a posé la question suivante :
"${userQuestion}"

Pour y répondre, voici le contenu extrait de plusieurs pages web (recherche : "${query}") :

${pagesContext}

---

En te basant sur ces informations, réponds à la question de l'utilisateur de façon :
- Claire et synthétique (pas de copier-coller brut)
- Structurée avec des titres ou bullet points si utile
- En français
- En indiquant si l'information est récente ou non quand c'est pertinent

Ne mentionne pas explicitement les pages ou leur structure. Réponds directement à la question.`;

  const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: synthesisPrompt }],
      temperature: 0.4,
      max_tokens: 1024
    })
  });

  if (!mistralRes.ok) throw new Error(`Mistral synthesis HTTP ${mistralRes.status}`);

  const mistralData = await mistralRes.json();
  const synthesis = mistralData.choices?.[0]?.message?.content?.trim() || "Je n'ai pas pu générer une synthèse.";

  return `${synthesis}\n\n---\n🔍 **Sources** :\n${sourcesBlock}`;
}

// ═══════════════════════════════════════════════════════
// TOOL : RECHERCHE WEB (DuckDuckGo)
// ═══════════════════════════════════════════════════════
async function duckSearchHTML(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}&kl=fr-fr`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) throw new Error(`DDG HTML HTTP ${response.status}`);

  const html = await response.text();
  const results = [];
  const seen = new Set();

  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 5) {
    let href = m[1];
    const rawTitle = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x27;/g,"'").replace(/&quot;/g,'"').trim();
    if (!rawTitle || rawTitle.length < 3) continue;

    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try { href = decodeURIComponent(uddgMatch[1]); } catch {}
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }

    if (!href.startsWith("http") || href.includes("duckduckgo.com")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    results.push({ title: rawTitle.slice(0, 120), url: href });
  }

  if (results.length === 0) {
    const re2 = /<a[^>]+href="(https?:\/\/(?!duckduckgo)[^"]+)"[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = re2.exec(html)) !== null && results.length < 5) {
      const href = m[1];
      const rawTitle = m[2].replace(/<[^>]+>/g, "").trim();
      if (!rawTitle || rawTitle.length < 3 || seen.has(href)) continue;
      seen.add(href);
      results.push({ title: rawTitle.slice(0, 120), url: href });
    }
  }

  return results;
}

async function duckSearchJSON(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;

  const response = await fetch(url, {
    headers: { "User-Agent": "RokyGPT/1.0", "Accept-Language": "fr-FR,fr;q=0.9" }
  });
  if (!response.ok) return [];

  const data = await response.json();
  const raw = [];

  if (data.AbstractURL && data.AbstractText) {
    raw.push({ title: (data.Heading || data.AbstractText).slice(0, 120), url: data.AbstractURL });
  }

  const flattenTopics = (topics) => {
    for (const item of topics) {
      if (item.Topics) flattenTopics(item.Topics);
      else if (item.FirstURL && item.Text) {
        raw.push({ title: item.Text.replace(/<[^>]+>/g,"").slice(0,120), url: item.FirstURL });
      }
    }
  };
  if (Array.isArray(data.RelatedTopics)) flattenTopics(data.RelatedTopics);
  if (Array.isArray(data.Results)) {
    data.Results.forEach(r => r.FirstURL && r.Text &&
      raw.push({ title: r.Text.replace(/<[^>]+>/g,"").slice(0,120), url: r.FirstURL }));
  }

  const seen = new Set();
  return raw.filter(r => {
    if (!r.url || !r.title || seen.has(r.url)) return false;
    seen.add(r.url); return true;
  }).slice(0, 5);
}

async function duckSearch(query) {
  let results = [];
  let method = "html";

  try {
    results = await duckSearchHTML(query);
  } catch (e) {
    console.warn(`[duck-search] HTML scraping échoué (${e.message}), tentative JSON…`);
    method = "json-fallback";
  }

  if (results.length === 0) {
    try {
      results = await duckSearchJSON(query);
      method = results.length ? "json-fallback" : "empty";
    } catch (e) {
      console.warn(`[duck-search] JSON fallback aussi échoué : ${e.message}`);
    }
  }

  return { results, method };
}

app.post("/duck-search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return res.status(400).json({ error: "Paramètre 'query' manquant ou vide." });
  }

  const q = query.trim();
  console.log(`[duck-search] Requête reçue : "${q}"`);

  try {
    const data = await duckSearch(q);
    console.log(`[duck-search] "${q}" → ${data.results.length} résultat(s) [méthode: ${data.method}]`);
    res.json({ results: data.results });
  } catch (err) {
    console.error(`[duck-search] Erreur pour "${q}" :`, err.message);
    res.status(500).json({ error: `Erreur lors de la recherche : ${err.message}` });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RokyGPT tourne sur le port ${PORT}`));
