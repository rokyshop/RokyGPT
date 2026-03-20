import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

// 🔑 Utilise ta clé Mistral dans Render (variables d'environnement)
const API_KEY = process.env.MISTRAL_API_KEY;

// mémoire par utilisateur
let conversations = {};

// Endpoint pour chat
app.post("/chat", async (req, res) => {
  const { message, userId } = req.body;

  if (!conversations[userId]) {
    conversations[userId] = [
      {
        role: "system",
        content: "Tu es un assistant expert en développement Node.js et Roblox Lua. Réponds clairement et efficacement."
      }
    ];
  }

  conversations[userId].push({ role: "user", content: message });

  try {
    const response = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "mistral-small-latest",
        messages: conversations[userId]
      })
    });

    const data = await response.json();
    const reply = data.choices[0].message.content;

    conversations[userId].push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur API Mistral" });
  }
});
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sert index.html directement sur la racine
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
// Render définit PORT automatiquement
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur ${PORT}`));
