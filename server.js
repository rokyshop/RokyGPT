import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());
app.use(cors());

// Config pour fichiers upload
const upload = multer({ dest: "uploads/" });

// Clé Mistral
const API_KEY = process.env.MISTRAL_API_KEY;

// Mémoire persistante
const MEMORY_FILE = "conversations.json";
let conversations = {};
if (fs.existsSync(MEMORY_FILE)) {
  conversations = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
}

function saveMemory() {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(conversations));
}

// Endpoint chat
app.post("/chat", upload.array("files"), async (req, res) => {
  const { message, userId } = req.body;
  const files = req.files || [];

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  if (!conversations[userId]) {
    conversations[userId] = [
      {
        role: "system",
        content: "Tu es un assistant appelé RokyGPT. Tu peux répondre à du code, analyser des fichiers et générer des logigrammes."
      }
    ];
  }

  let content = message || "";

  if (files.length > 0) {
    const fileNames = files.map(f => f.originalname).join(", ");
    content += `\nFichiers envoyés : ${fileNames}`;
  }

  conversations[userId].push({ role: "user", content });

  // Limite mémoire
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
        messages: conversations[userId]
      })
    });
    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "Je n'ai pas compris, peux-tu reformuler ?";

    conversations[userId].push({ role: "assistant", content: reply });
    saveMemory();

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.json({ reply: "Erreur serveur lors de l'appel à Mistral" });
  }
});

// Frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Uploads statiques
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur lancé sur ${PORT}`));
