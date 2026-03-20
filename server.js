// server.js (inchangé sauf un petit détail : on renvoie aussi le reply pour fluidité)
const express = require("express");
const fetch = require("node-fetch");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());

const conversations = {}; // RAM only – conversations par userId (éphémère sur Render)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const API_KEY = process.env.MISTRAL_API_KEY;

app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId } = req.body;
  const files = req.files || [];

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!conversations[userId]) {
    conversations[userId] = [{ role: "system", content: "Tu es RokyGPT, un assistant utile, concis et un peu fun." }];
  }

  let content = message || "";
  if (files.length > 0) {
    const fileNames = files.map(f => f.originalname).join(", ");
    content += `\nFichiers joints : ${fileNames}`;
  }

  conversations[userId].push({ role: "user", content });

  if (conversations[userId].length > 40) { // un peu plus large
    conversations[userId] = conversations[userId].slice(-40);
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
        temperature: 0.75,
        max_tokens: 2048
      })
    });

    if (!response.ok) throw new Error(`Mistral error ${response.status}`);

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Désolé, je n'ai pas compris...";

    conversations[userId].push({ role: "assistant", content: reply });

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ reply: "Erreur connexion Mistral – réessaie !" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`RokyGPT tourne sur port ${PORT}`));
