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
- "Mermaid" : pour générer un diagramme Mermaid. input = le code Mermaid complet (ex: "graph TD; A-->B")
- "Search" : pour rechercher des informations récentes sur le web via DuckDuckGo. input = la requête de recherche en français ou anglais

Si aucun tool n'est nécessaire, réponds normalement en texte ou Markdown.

Exemples :
- "Quel jour sommes nous ?" → {"tool":"Date","input":""}
- "Calcule 23 * 47" → {"tool":"Calcul","input":"23*47"}
- "Fais un diagramme de A vers B vers C" → {"tool":"Mermaid","input":"graph TD\\n  A-->B\\n  B-->C"}
- "Exécute ce code JS : [1,2,3].map(x=>x*2)" → {"tool":"CodeJS","input":"return [1,2,3].map(x=>x*2)"}
- "Cherche des infos sur Node.js" → {"tool":"Search","input":"Node.js"}
- "Quelles sont les dernières news sur l'IA ?" → {"tool":"Search","input":"latest AI news 2025"}

Ne retourne JAMAIS de JSON enveloppé dans du markdown. Seulement du JSON brut ou du texte.`;

// ═══════════════════════════════════════════════════════
// TOOLS — exécutés côté serveur, sécurisés
// ═══════════════════════════════════════════════════════

/**
 * Tool : Date/Heure
 */
function toolDate() {
  const now = new Date();
  const options = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
  const dateStr = now.toLocaleDateString("fr-FR", options);
  const timeStr = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `📅 **${dateStr}** — il est **${timeStr}**`;
}

/**
 * Tool : Calcul mathématique
 * Utilise vm.runInNewContext avec un contexte limité — pas d'accès à Node/FS/process
 */
function toolCalc(expression) {
  if (!expression || expression.trim().length === 0) return "❌ Expression vide.";
  if (expression.length > 500) return "❌ Expression trop longue.";

  // Whitelist des chars autorisés pour sécurité maximale
  const safe = /^[\d\s\+\-\*\/\%\(\)\.\,MathsqrtpowlogfloorceileabsroundPIEsincostan]+$/.test(expression.replace(/\s/g, ""));
  if (!safe) return "❌ Expression non autorisée (caractères invalides).";

  try {
    const sandbox = {
      Math,
      result: undefined
    };
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

/**
 * Tool : Code JS sandbox
 * Exécution dans un contexte vm isolé, timeout 1s, pas d'accès à require/process/fs
 */
function toolCodeJS(code) {
  if (!code || code.trim().length === 0) return "❌ Code vide.";
  if (code.length > 2000) return "❌ Code trop long (max 2000 caractères).";

  // Blocage des mots-clés dangereux
  const forbidden = ["require", "process", "__dirname", "__filename", "global", "Buffer", "eval", "Function(", "fetch", "import"];
  for (const kw of forbidden) {
    if (code.includes(kw)) return `❌ Mot-clé interdit : \`${kw}\``;
  }

  const logs = [];
  const sandbox = {
    Math,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    String,
    Number,
    Boolean,
    Array,
    Object,
    console: {
      log: (...args) => logs.push(args.map(a => {
        try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); }
      }).join(" ")),
      error: (...args) => logs.push("ERR: " + args.join(" "))
    },
    result: undefined
  };

  try {
    // Enveloppe le code dans une fonction pour capturer return
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

/**
 * Tool : Mermaid (rendu côté front — le serveur valide juste et renvoie le code)
 */
function toolMermaid(input) {
  if (!input || input.trim().length === 0) return { type: "mermaid", code: "graph TD\n  A[Erreur] --> B[Input vide]" };
  return { type: "mermaid", code: input.trim() };
}

// ═══════════════════════════════════════════════════════
// DÉTECTION ET EXÉCUTION DU TOOL
// ═══════════════════════════════════════════════════════
function detectAndRunTool(rawReply) {
  // Cherche un JSON en début de réponse (potentiellement après des espaces)
  const trimmed = rawReply.trim();

  // Tente de parser si ça ressemble à du JSON
  if (!trimmed.startsWith("{")) return null;

  let parsed;
  try {
    // Prendre uniquement le premier JSON valide (jusqu'au premier "}" fermant)
    const match = trimmed.match(/^\{[\s\S]*?\}(?=\s*$|\s*\n)/);
    parsed = JSON.parse(match ? match[0] : trimmed);
  } catch {
    return null;
  }

  if (!parsed || !parsed.tool) return null;

  const tool = parsed.tool;
  const input = parsed.input || "";
  const explanation = parsed.explanation || "";

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
    case "Search":
      // La recherche est async — on signale au caller de la gérer séparément
      return { async: true, query: input, explanation };
    default:
      return null; // tool inconnu, on laisse passer comme texte normal
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

// Restore historique depuis le client
app.post("/restore", (req, res) => {
  const { userId, messages } = req.body;
  if (!userId || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Données invalides pour restore" });
  }
  conversations[userId] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages
  ];
  res.json({ success: true });
});

// Chat principal
app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId } = req.body;
  const files = req.files || [];

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!conversations[userId]) {
    conversations[userId] = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  let content = message || "";
  if (files.length > 0) {
    content += `\n[Fichiers joints : ${files.map(f => f.originalname).join(", ")}]`;
  }

  conversations[userId].push({ role: "user", content });

  // Trim historique
  if (conversations[userId].length > 42) {
    conversations[userId] = [
      conversations[userId][0], // garde le system prompt
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

    // Tente de détecter et exécuter un tool
    const toolResult = detectAndRunTool(rawReply);
    let finalReply;
    let usedTool = null;

    if (toolResult && toolResult.async) {
      // ── Tool Search : recherche → lecture des pages → synthèse Mistral ──
      usedTool = "Search";
      try {
        finalReply = await toolSearchAndSynthesize(toolResult.query, content, API_KEY);
      } catch (e) {
        console.error("[Search] Erreur globale :", e.message);
        finalReply = `❌ Erreur lors de la recherche web : ${e.message}`;
      }
      conversations[userId].push({ role: "assistant", content: finalReply });

    } else if (toolResult) {
      finalReply = toolResult.reply;
      usedTool = toolResult.tool;
      // On stocke le résultat du tool dans l'historique (pas le JSON brut)
      conversations[userId].push({ role: "assistant", content: finalReply });
    } else {
      finalReply = rawReply;
      conversations[userId].push({ role: "assistant", content: finalReply });
    }

    res.json({ reply: finalReply, tool: usedTool });

  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Erreur connexion Mistral – réessaie !" });
  }
});

// ═══════════════════════════════════════════════════════
// TOOL : NAVIGATION WEB — browsePage + synthèse Mistral
// ═══════════════════════════════════════════════════════

/**
 * Télécharge une page web et en extrait le texte brut lisible.
 * - Supprime <script>, <style>, les balises HTML, et les espaces superflus.
 * - Respecte un timeout de 5 secondes.
 * - Limite le texte à MAX_PAGE_CHARS caractères pour ne pas exploser le contexte Mistral.
 * @param {string} url
 * @returns {Promise<{url, text, ok, error}>}
 */
const PAGE_TIMEOUT_MS  = 5000;   // timeout par page
const MAX_PAGE_CHARS   = 4000;   // caractères max extraits par page
const PAGES_TO_BROWSE  = 3;      // nombre de pages lues en parallèle

async function browsePage(url) {
  const label = `[browse] ${url}`;
  try {
    // AbortController pour le timeout
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

    // Vérifier que c'est bien du HTML
    const ct = response.headers.get("content-type") || "";
    if (!ct.includes("html") && !ct.includes("text")) {
      console.warn(`${label} → type non-HTML (${ct}), ignoré`);
      return { url, ok: false, error: "non-HTML", text: "" };
    }

    const html = await response.text();

    // ── Nettoyage HTML ──
    let text = html
      // Supprimer scripts, styles, svg, noscript en entier (contenu inclus)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      // Convertir certaines balises en sauts de ligne pour préserver la structure
      .replace(/<\/(p|div|li|h[1-6]|tr|br)[^>]*>/gi, "\n")
      // Supprimer toutes les balises restantes
      .replace(/<[^>]+>/g, " ")
      // Décoder les entités HTML courantes
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/")
      // Nettoyer espaces multiples et lignes vides
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Limiter la longueur
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

/**
 * Pipeline complet du tool Search :
 *   1. Recherche DDG  → URLs
 *   2. Browse pages   → textes
 *   3. Synthèse Mistral → réponse finale
 *
 * @param {string} query        - requête de l'utilisateur
 * @param {string} userQuestion - message original de l'utilisateur (pour le prompt)
 * @param {string} apiKey       - clé Mistral
 * @returns {Promise<string>}   - réponse markdown prête à afficher
 */
async function toolSearchAndSynthesize(query, userQuestion, apiKey) {
  // ── Étape 1 : Recherche ──────────────────────────────
  console.log(`[Search] 🔍 Recherche : "${query}"`);
  const { results, method } = await duckSearch(query);

  if (!results.length) {
    return `🔍 Aucun résultat trouvé pour **"${query}"**. Essayez une formulation différente.`;
  }

  console.log(`[Search] ${results.length} URL(s) trouvée(s) [méthode: ${method}]`);
  results.forEach((r, i) => console.log(`  ${i + 1}. ${r.url}`));

  // ── Étape 2 : Navigation des pages (3 premières en parallèle) ───
  const toVisit = results.slice(0, PAGES_TO_BROWSE);
  console.log(`[Search] 📄 Navigation de ${toVisit.length} page(s)…`);

  const pageResults = await Promise.all(toVisit.map(r => browsePage(r.url)));

  const successPages = pageResults.filter(p => p.ok && p.text.trim().length > 100);
  console.log(`[Search] ✅ ${successPages.length}/${toVisit.length} page(s) lue(s) avec succès`);

  // ── Étape 3 : Construction du prompt de synthèse ────
  let pagesContext = "";

  if (successPages.length > 0) {
    pagesContext = successPages.map((p, i) =>
      `[PAGE ${i + 1}] Source : ${p.url}\n${p.text}`
    ).join("\n\n---\n\n");
  } else {
    // Aucune page lisible → synthèse uniquement à partir des titres/URLs
    console.warn("[Search] Aucune page lisible, synthèse sur les titres uniquement");
    const titlesOnly = results.map((r, i) =>
      `${i + 1}. ${r.title} — ${r.url}`
    ).join("\n");
    pagesContext = `Aucun contenu de page n'a pu être extrait. Voici les titres des résultats :\n${titlesOnly}`;
  }

  const sourcesBlock = results
    .slice(0, 5)
    .map((r, i) => `${i + 1}. [${r.title}](${r.url})`)
    .join("\n");

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

  // ── Étape 4 : Appel Mistral pour la synthèse ────────
  console.log(`[Search] 🤖 Synthèse Mistral en cours…`);

  const mistralRes = await fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "mistral-small-latest",
      messages: [{ role: "user", content: synthesisPrompt }],
      temperature: 0.4,   // plus factuel pour une synthèse
      max_tokens: 1024
    })
  });

  if (!mistralRes.ok) {
    throw new Error(`Mistral synthesis HTTP ${mistralRes.status}`);
  }

  const mistralData = await mistralRes.json();
  const synthesis = mistralData.choices?.[0]?.message?.content?.trim()
    || "Je n'ai pas pu générer une synthèse.";

  console.log(`[Search] ✅ Synthèse générée (${synthesis.length} chars)`);

  // ── Étape 5 : Réponse finale avec sources ───────────
  const reply = `${synthesis}

---
🔍 **Sources** :
${sourcesBlock}`;

  return reply;
}

// ═══════════════════════════════════════════════════════
// TOOL : RECHERCHE WEB
// ═══════════════════════════════════════════════════════
// Stratégie en 2 étapes :
//   1. Scraping HTML de html.duckduckgo.com  (vrais résultats de recherche web)
//   2. Fallback : API JSON de api.duckduckgo.com (instant answers / Wikipedia)
// L'API JSON ne renvoie rien pour les actualités — c'est la cause du bug.
// Le scraping HTML lui couvre toutes les requêtes comme un vrai moteur.
// ═══════════════════════════════════════════════════════

/**
 * Extrait les résultats depuis la page HTML de DuckDuckGo.
 * DDG HTML renvoie des balises <a class="result__a"> avec les titres
 * et des <a class="result__url"> ou l'attribut href avec l'URL réelle.
 *
 * On parse avec des regex légères — pas besoin de cheerio.
 */
async function duckSearchHTML(query) {
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}&kl=fr-fr`;

  const response = await fetch(url, {
    headers: {
      // User-Agent réaliste pour éviter les blocages
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });

  if (!response.ok) throw new Error(`DDG HTML HTTP ${response.status}`);

  const html = await response.text();

  const results = [];
  const seen = new Set();

  // Pattern 1 : liens de résultat principaux
  // <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=...">Titre</a>
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null && results.length < 5) {
    let href = m[1];
    const rawTitle = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&#x27;/g,"'").replace(/&quot;/g,'"').trim();
    if (!rawTitle || rawTitle.length < 3) continue;

    // DDG HTML encode les URLs via un redirect /l/?uddg=<encodedURL>
    const uddgMatch = href.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try { href = decodeURIComponent(uddgMatch[1]); } catch {}
    } else if (href.startsWith("//")) {
      href = "https:" + href;
    }

    // Filtrer les liens internes DDG
    if (!href.startsWith("http") || href.includes("duckduckgo.com")) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    results.push({ title: rawTitle.slice(0, 120), url: href });
  }

  // Pattern 2 (fallback si Pattern 1 vide) : href directs dans les résultats
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

/**
 * Fallback : API JSON DuckDuckGo (instant answers / Wikipedia uniquement).
 * Fonctionne bien pour les entités connues, pas pour l'actualité.
 */
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

/**
 * Fonction principale : essaie le HTML d'abord, puis le JSON en fallback.
 */
async function duckSearch(query) {
  let results = [];
  let method = "html";

  try {
    results = await duckSearchHTML(query);
  } catch (e) {
    console.warn(`[duck-search] HTML scraping échoué (${e.message}), tentative JSON…`);
    method = "json-fallback";
  }

  // Si le HTML n'a rien donné, tenter le JSON
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

// ── Route POST /duck-search ──────────────────────────────
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

// Servir le front
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RokyGPT tourne sur le port ${PORT}`));
