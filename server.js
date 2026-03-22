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

Si aucun tool n'est nécessaire, réponds normalement en texte ou Markdown.

Exemples :
- "Quel jour sommes nous ?" → {"tool":"Date","input":""}
- "Calcule 23 * 47" → {"tool":"Calcul","input":"23*47"}
- "Fais un diagramme de A vers B vers C" → {"tool":"Mermaid","input":"graph TD\\n  A-->B\\n  B-->C"}
- "Exécute ce code JS : [1,2,3].map(x=>x*2)" → {"tool":"CodeJS","input":"return [1,2,3].map(x=>x*2)"}

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

    if (toolResult) {
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

// Servir le front
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 RokyGPT tourne sur le port ${PORT}`));
