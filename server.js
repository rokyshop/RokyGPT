import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(express.json());
app.use(cors());

const API_KEY = "TA_CLE_MISTRAL";

let conversations = {}; // mémoire par utilisateur simple

app.post("/chat", async (req, res) => {
  const { message, userId } = req.body;

  if (!conversations[userId]) {
    conversations[userId] = [
      {
        role: "system",
        content: "Tu es un expert en développement (Node.js, Roblox Lua). Tu réponds clairement et efficacement."
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
    res.status(500).json({ error: "Erreur API" });
  }
});

app.listen(3000, () => console.log("Serveur lancé sur 3000"));
