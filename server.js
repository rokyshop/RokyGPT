// server.js
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const app = express();

app.use(express.json());
app.use(cors());

// ───────────────────────────────────────────────
//  IMPORTANT : stockage en RAM uniquement (Render-friendly)
// ───────────────────────────────────────────────
const conversations = {}; // plus de fichier json persistant

// Option : si tu veux vraiment persister → utiliser Redis / Upstash / MongoDB
// pour l'instant → mémoire volatile par instance (reset au redémarrage)

// Configuration multer → stockage temporaire en mémoire (RAM)
const upload = multer({
  storage: multer.memoryStorage(), // ← très important : pas de disque !
  limits: { fileSize: 10 * 1024 * 1024 } // 10 Mo max par fichier par ex.
});

// Tu peux aussi garder diskStorage SI tu ajoutes un Disk payant sur Render
// mais pour commencer → memoryStorage est plus simple & gratuit

const API_KEY = process.env.MISTRAL_API_KEY;

app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId } = req.body;
  const files = req.files || [];

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!conversations[userId]) {
    conversations[userId] = [{ role: "system", content: "Tu es RokyGPT." }];
  }

  let content = message || "";

  // Option A : ne rien faire avec les fichiers (juste le nom)
  if (files.length > 0) {
    const fileNames = files.map(f => f.originalname).join(", ");
    content += `\nFichiers envoyés : ${fileNames}`;
  }

  // Option B : si tu veux envoyer le contenu des fichiers texte au LLM
  // (seulement pour petits fichiers texte)
  /*
  for (const file of files) {
    if (file.mimetype.startsWith("text/")) {
      const textContent = file.buffer.toString("utf-8");
      content += `\n\nContenu du fichier ${file.originalname} :\n${textContent}`;
    }
  }
  */

  conversations[userId].push({ role: "user", content });

  // limite de contexte (très utile)
  if (conversations[userId].length > 30) {
    conversations[userId] = conversations[userId].slice(-30);
  }

  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: conversations[userId],
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      throw new Error(`Mistral HTTP ${response.status}`);
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Je n'ai pas compris";

    conversations[userId].push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Erreur serveur Mistral" });
  }
});

// Servir la page d'accueil
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Plus besoin de servir /uploads si on utilise memoryStorage
// app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur port ${PORT}`));
