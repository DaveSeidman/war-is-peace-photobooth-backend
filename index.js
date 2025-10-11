import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import { File } from "node:buffer"; // ✅ Needed for Fal uploads in Node

dotenv.config();

// Configure Fal.ai client
fal.config({
  credentials: process.env.FAL_KEY,
});

// Ensure uploads dir exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

// === Multer setup ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `photo_${timestamp}${ext}`);
  },
});
const upload = multer({ storage });

// === Upload endpoint ===
app.post("/upload", upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

  console.log(`📸 Saved file: ${req.file.path}`);

  res.json({
    success: true,
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
  });
});

// Serve uploaded files
app.use("/uploads", express.static(uploadDir));

app.get("/test/:type", async (req, res) => {
  try {
    const inputPath = path.join(uploadDir, "test.jpg");
    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "uploads/test.jpg not found" });
    }

    const buffer = fs.readFileSync(inputPath);
    const file = new File([buffer], path.basename(inputPath), { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);
    console.log("Fal upload response:", uploaded);

    // Fallback logic to extract URL
    let imageUrl;
    if (typeof uploaded === "string") {
      imageUrl = uploaded;
    } else if (uploaded.file && typeof uploaded.file.url === "string") {
      imageUrl = uploaded.file.url;
    } else {
      throw new Error("Fal upload failed: no usable URL returned");
    }

    console.log("✅ Uploaded image URL:", imageUrl);

    const prompts = {
      past: "1955 portrait in Hill Valley diner style, warm pastel tones, film grain, vintage clothes, Kodak photo look",
      future: "Retro-futuristic 2015 Hill Valley, neon glow, chrome hoverboards, holograms, glossy sci-fi photo aesthetic",
      remove: "Remove a random person from this photo and fill the background naturally",
      banana: "put a banana over each person's face"
    };

    const prompt = `make an image of a ${prompts[req.params.type]}`;
    if (!prompt) return res.status(400).json({ error: "Invalid type parameter" });

    console.log("🚀 Sending to nano-banana edit...");
    const result = await fal.subscribe("fal-ai/nano-banana/edit", {
      input: {
        prompt: prompt,
        image_urls: [imageUrl],
      },
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS") {
          update.logs.map((l) => l.message).forEach(console.log);
        }
      },
    });

    console.log("Result data:", result.data);
    const outUrls = result.data?.images;
    const outputUrl = Array.isArray(outUrls) && outUrls.length > 0 ? outUrls[0] : null;
    if (!outputUrl) {
      throw new Error("nano-banana returned no images");
    }

    res.json({
      success: true,
      input: `/uploads/${path.basename(inputPath)}`,
      output: outputUrl,
    });
  } catch (err) {
    console.error("❌ Error in nano-banana route:", err);
    res.status(500).json({ error: err.message });
  }
});
// Root
app.get("/", (req, res) => {
  res.send("photo server (Fal.ai version)");
});

app.post('/edit/:type', upload.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  console.log(`📸 Saved file for type "${req.params.type}": ${req.file.path}`);

  // Return a simple response
  res.json({ status: "ok", filename: req.file.filename });
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
