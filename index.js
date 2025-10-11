import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import { File } from "node:buffer";

dotenv.config();

fal.config({
  credentials: process.env.FAL_KEY,
});

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

// === Setup uploads folder ===
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// === Multer setup ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `photo_${req.params.type || "generic"}_${timestamp}${ext}`);
  },
});
const upload = multer({ storage });

// === Serve uploads statically ===
app.use("/uploads", express.static(uploadDir));

/**
 * 🧪 TEST ROUTE (kept as-is)
 */
app.get("/test/:type", async (req, res) => {
  try {
    const inputPath = path.join(uploadDir, "test.jpg");
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "uploads/test.jpg not found" });
    }

    const buffer = fs.readFileSync(inputPath);
    const file = new File([buffer], path.basename(inputPath), { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);

    const imageUrl =
      typeof uploaded === "string"
        ? uploaded
        : uploaded.file?.url || (() => { throw new Error("Fal upload failed"); })();

    const prompts = {
      past: "1955 portrait in Hill Valley diner style, warm pastel tones, film grain, vintage clothes, Kodak photo look",
      future: "Retro-futuristic 2015 Hill Valley, neon glow, chrome hoverboards, holograms, glossy sci-fi photo aesthetic",
      remove: "Remove a random person from this photo and fill the background naturally",
      banana: "put a banana over each person's face",
    };

    const prompt = `make an image of a ${prompts[req.params.type]}`;
    if (!prompt) return res.status(400).json({ error: "Invalid type parameter" });

    console.log("🚀 Sending to nano-banana edit...");
    const result = await fal.subscribe("fal-ai/nano-banana/edit", {
      input: { prompt, image_urls: [imageUrl] },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          update.logs.map((l) => l.message).forEach(console.log);
        }
      },
    });

    const outUrls = result.data?.images;
    const outputUrl = Array.isArray(outUrls) && outUrls.length > 0 ? outUrls[0] : null;
    if (!outputUrl) throw new Error("nano-banana returned no images");

    res.json({
      success: true,
      input: `/uploads/${path.basename(inputPath)}`,
      output: outputUrl,
    });
  } catch (err) {
    console.error("❌ Error in nano-banana test route:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 🎨 EDIT ROUTE — does everything dynamically
 */
app.post("/edit/:type", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    console.log(`📸 Received file for "${req.params.type}": ${req.file.path}`);

    // Upload to Fal storage
    const buffer = fs.readFileSync(req.file.path);
    const file = new File([buffer], req.file.filename, { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);

    const imageUrl =
      typeof uploaded === "string"
        ? uploaded
        : uploaded.file?.url || (() => { throw new Error("Fal upload failed"); })();

    console.log("✅ Uploaded to Fal:", imageUrl);

    const prompts = {
      past: "1955 portrait in Hill Valley diner style, warm pastel tones, film grain, vintage clothes, Kodak photo look",
      future: "Retro-futuristic 2015 Hill Valley, neon glow, chrome hoverboards, holograms, glossy sci-fi photo aesthetic",
      banana: "put a banana over each person's face",
    };

    const prompt = `make an image of a ${prompts[req.params.type]}`;
    if (!prompt) return res.status(400).json({ error: "Invalid type parameter" });

    console.log("🚀 Sending to nano-banana edit...");
    const result = await fal.subscribe("fal-ai/nano-banana/edit", {
      input: { prompt, image_urls: [imageUrl] },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          update.logs.map((l) => l.message).forEach(console.log);
        }
      },
    });

    const outUrls = result.data?.images;
    const outputUrl = Array.isArray(outUrls) && outUrls.length > 0 ? outUrls[0] : null;
    if (!outputUrl) throw new Error("nano-banana returned no images");

    console.log("✅ nano-banana complete:", outputUrl);

    res.json({
      success: true,
      input: `/uploads/${req.file.filename}`,
      output: outputUrl,
    });
  } catch (err) {
    console.error("❌ Error in /edit route:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("photo server (Fal nano-banana mode)"));

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
