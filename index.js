import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fal } from "@fal-ai/client";
import { File } from "node:buffer";
import fetch from "node-fetch";
import { createCanvas, loadImage } from "canvas";

dotenv.config();

fal.config({
  credentials: process.env.FAL_KEY,
});

const app = express();
const PORT = 8000;

app.use(cors());
app.use(express.json());

// === Setup folders ===
const uploadDir = path.join(process.cwd(), "uploads");
const photoDir = path.join(process.cwd(), "photos");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir);

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

// === Serve folders statically ===
app.use("/uploads", express.static(uploadDir));
app.use("/photos", express.static(photoDir));

app.post("/submit", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const timestamp = Date.now();
    const originalPath = req.file.path;
    console.log(`📸 Received file: ${originalPath}`);

    // Upload original to Fal storage
    const buffer = fs.readFileSync(originalPath);
    const file = new File([buffer], req.file.filename, { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);

    const imageUrl =
      typeof uploaded === "string"
        ? uploaded
        : uploaded.file?.url || (() => { throw new Error("Fal upload failed"); })();

    console.log("✅ Uploaded to Fal:", imageUrl);

    const prompts = {
      past: "1955 portrait in Hill Valley diner style, warm pastel tones, film grain, vintage clothes, Kodak photo look",
      future:
        "keep all the people the same, but make it look like the photo was taken in the future. Cyber styling, futuristic, humans look like androids, skin is metallic, chrome, embedded LEDs",
    };

    console.log("🚀 Sending both Fal edits (past + future)...");

    // Run both Fal generations in parallel
    const [pastResult, futureResult] = await Promise.all([
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: { prompt: prompts.past, image_urls: [imageUrl] },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS")
            update.logs.map((l) => l.message).forEach((m) => console.log("[past]", m));
        },
      }),
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: { prompt: prompts.future, image_urls: [imageUrl] },
        logs: true,
        onQueueUpdate: (update) => {
          if (update.status === "IN_PROGRESS")
            update.logs.map((l) => l.message).forEach((m) => console.log("[future]", m));
        },
      }),
    ]);

    // ✅ Extract proper URLs from Fal responses
    const extractUrl = (r) => {
      const imgs = r.data?.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return null;

      const first = imgs[0];
      if (typeof first === "string") return first;
      if (first?.url) return first.url;
      return null;
    };

    const pastUrl = extractUrl(pastResult);
    const futureUrl = extractUrl(futureResult);

    if (!pastUrl || !futureUrl) {
      console.error("❌ Fal result missing URLs:", { pastUrl, futureUrl });
      throw new Error("One or both Fal edits failed to return valid URLs");
    }

    console.log("✅ Fal edits complete:");
    console.log("  Past  →", pastUrl);
    console.log("  Future →", futureUrl);

    // === Compose the three images ===
    console.log("🖼️ Compositing images...");

    const loadRemoteImage = async (url) => {
      if (!/^https?:\/\//.test(url)) throw new Error(`Invalid image URL: ${url}`);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch image: ${url}`);
      const arrayBuffer = await resp.arrayBuffer();
      return await loadImage(Buffer.from(arrayBuffer));
    };

    console.log("Loading original...");
    const imgOriginal = await loadImage(originalPath);
    console.log("Loading past...");
    const imgPast = await loadRemoteImage(pastUrl);
    console.log("Loading future...");
    const imgFuture = await loadRemoteImage(futureUrl);

    const width = Math.max(imgOriginal.width, imgPast.width, imgFuture.width);
    const height = Math.max(imgOriginal.height, imgPast.height, imgFuture.height);
    const canvas = createCanvas(width, height * 3);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(imgPast, 0, 0, width, height);
    ctx.drawImage(imgOriginal, 0, height * 1, width, height);
    ctx.drawImage(imgFuture, 0, height * 2, width, height);

    const combinedPath = path.join(photoDir, `${timestamp}.jpg`);
    const out = fs.createWriteStream(combinedPath);
    const stream = canvas.createJPEGStream({ quality: 0.9 });
    stream.pipe(out);
    await new Promise((resolve) => out.on("finish", resolve));

    console.log("✅ Saved composite image:", combinedPath);

    res.json({
      success: true,
      input: `/uploads/${req.file.filename}`,
      output: {
        past: pastUrl,
        future: futureUrl,
        photoId: timestamp,
      },
    });
  } catch (err) {
    console.error("❌ Error in /submit route:", err);
    res.status(500).json({ error: err.message });
  }
});


app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
