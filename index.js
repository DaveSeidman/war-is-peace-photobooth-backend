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
import sharp from "sharp";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

dotenv.config();
fal.config({ credentials: process.env.FAL_KEY });

const app = express();
const PORT = process.env.PORT || 8000;

// The frontend will fetch these and send them back along with photo submissions giving us the ability to override them at runtime
const prompts = {
  past: "keep all the people the same, but make it look like the photo was taken in the wild wild west (late 1800's) add some light wrinkling and weathering at the edges, use sepia tones. Cowboys and cowgirls. do not change the framing",
  future: "keep all the people the same, but make it look like the photo was taken in the future. Star Trek style clothing. Cyber styling, futuristic, humans look like androids, skin is metallic, chrome, embedded LEDs. do not change the framing",
  remove: "remove two random people in this photo and leave the rest unchanged"
};

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

app.get("/", (req, res) => res.json({ status: "ok" }));

app.get('/prompts', (req, res) => res.json(prompts))

app.post("/submit", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ success: false, message: "No file uploaded" });

    const timestamp = Date.now();
    const originalPath = req.file.path;
    const { pastPrompt, futurePrompt, removePrompt } = req.body;

    console.log(`📸 Received file: ${originalPath}`);
    console.log("📋 Received prompts:");
    console.log({ pastPrompt, futurePrompt, removePrompt });
    const originalBuffer = fs.readFileSync(originalPath);

    // Resize to 512px width max
    const resizedBuffer = await sharp(originalBuffer)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const file = new File([resizedBuffer], req.file.filename, { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);
    const imageUrl =
      typeof uploaded === "string"
        ? uploaded
        : uploaded.file?.url || (() => { throw new Error("Fal upload failed"); })();

    console.log(`✅ Uploaded resized image to Fal: ${imageUrl}`);


    console.log("🚀 Sending both Fal edits (past + future)...");

    const [pastResult, futureResult] = await Promise.all([
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: { prompt: pastPrompt, image_urls: [imageUrl] },
        logs: true,
      }),
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: { prompt: futurePrompt, image_urls: [imageUrl] },
        logs: true,
      }),
    ]);

    const extractUrl = (r) => {
      const imgs = r.data?.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return null;
      const first = imgs[0];
      if (typeof first === "string") return first;
      return first?.url || null;
    };

    const pastUrl = extractUrl(pastResult);
    const futureUrl = extractUrl(futureResult);
    if (!pastUrl || !futureUrl) throw new Error("Missing Fal image URLs");

    console.log("✅ Fal edits complete:");
    console.log("  Past →", pastUrl);
    console.log("  Future →", futureUrl);

    // === Compose the three images ===
    console.log("🖼️ Compositing images...");

    const loadRemoteImage = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch image: ${url}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      return await loadImage(buf);
    };

    const imgOriginal = await loadImage(originalPath);
    const imgPast = await loadRemoteImage(pastUrl);
    const imgFuture = await loadRemoteImage(futureUrl);

    const width = Math.max(imgOriginal.width, imgPast.width, imgFuture.width);
    const height = Math.max(imgOriginal.height, imgPast.height, imgFuture.height);
    const canvas = createCanvas(width, height * 3);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(imgPast, 0, 0, width, height);
    ctx.drawImage(imgOriginal, 0, height, width, height);
    ctx.drawImage(imgFuture, 0, height * 2, width, height);

    const combinedPath = path.join(photoDir, `${timestamp}.jpg`);
    const out = fs.createWriteStream(combinedPath);
    const stream = canvas.createJPEGStream({ quality: 0.9 });
    stream.pipe(out);
    await new Promise((resolve) => out.on("finish", resolve));
    console.log("✅ Saved composite image:", combinedPath);

    // === respond immediately ===
    res.json({
      success: true,
      input: `/uploads/${req.file.filename}`,
      output: { past: pastUrl, future: futureUrl, photoId: timestamp },
    });

    // === background async task ===
    ; (async () => {
      try {
        console.log("🎬 Starting background nano-banana removals...");

        const compBuffer = fs.readFileSync(combinedPath);
        const compFile = new File([compBuffer], `${timestamp}.jpg`, { type: "image/jpeg" });
        const compUpload = await fal.storage.upload(compFile);
        let currentUrl =
          typeof compUpload === "string"
            ? compUpload
            : compUpload.file?.url || (() => { throw new Error("Composite upload failed"); })();

        const fetchToBuffer = async (url) => {
          const resp = await fetch(url);
          if (!resp.ok) throw new Error(`Failed to fetch image: ${url}`);
          return Buffer.from(await resp.arrayBuffer());
        };

        const uploadBufferToFal = async (buf, name) => {
          const f = new File([buf], name, { type: "image/jpeg" });
          const up = await fal.storage.upload(f);
          return typeof up === "string" ? up : up.file?.url || null;
        };

        const extractUrl = (r) => {
          const imgs = r.data?.images;
          if (!Array.isArray(imgs) || imgs.length === 0) return null;
          const first = imgs[0];
          return typeof first === "string" ? first : first?.url || null;
        };

        const framePaths = [combinedPath];
        for (let i = 1; i <= 3; i++) {
          console.log(`🧩 Running removal ${i}/3 using ${currentUrl} ...`);
          const result = await fal.subscribe("fal-ai/nano-banana/edit", {
            input: { prompt: removePrompt, image_urls: [currentUrl] },
            logs: true,
          });
          const outUrl = extractUrl(result);
          if (!outUrl) throw new Error(`Fal removal #${i} returned no image`);

          const buf = await fetchToBuffer(outUrl);
          const framePath = path.join(photoDir, `${timestamp}_remove${i}.jpg`);
          fs.writeFileSync(framePath, buf);
          framePaths.push(framePath);
          console.log(`✅ Saved removal #${i}:`, framePath);

          await new Promise((resolve) => setTimeout(resolve, 1500));
          const nextUrl = await uploadBufferToFal(buf, `${timestamp}_remove${i}.jpg`);
          if (!nextUrl) throw new Error(`Upload of removal #${i} failed`);
          currentUrl = nextUrl;
        }

        console.log("🎉 Removal pipeline complete.");
        console.log("✅ All frames:", framePaths);

        console.log("🎞️ Creating animated GIF with fades...");
        const normalizedPaths = [];

        // normalize all images to same width/height
        const { width, height } = await sharp(framePaths[0]).metadata();
        for (let i = 0; i < framePaths.length; i++) {
          const outPath = framePaths[i].replace(".jpg", "_norm.jpg");
          await sharp(framePaths[i])
            .resize({ width, height, fit: "cover" })
            .toFile(outPath);
          normalizedPaths.push(outPath);
        }

        const gifPath = path.join(photoDir, `${timestamp}.gif`);

        // Each still lasts 2 s, fades are 1 s
        // Use xfade transitions chained together
        // build input list
        const inputs = normalizedPaths.map(p => `-loop 1 -t 2 -i "${p}"`).join(" ");

        // Build chained xfade filters
        // e.g. [0][1]xfade=transition=fade:duration=1:offset=1[v1];[v1][2]xfade=...
        let filter = "";
        let lastLabel = `[0:v]`;
        for (let i = 1; i < normalizedPaths.length; i++) {
          const inLabelA = i === 1 ? `[0:v]` : `[v${i - 1}]`;
          const inLabelB = `[${i}:v]`;
          const outLabel = i === normalizedPaths.length - 1 ? "" : `[v${i}]`;
          const offset = i * 2 - 1; // start fade at end of prior still
          filter += `${inLabelA}${inLabelB}xfade=transition=fade:duration=1:offset=${offset}${outLabel ? outLabel + ";" : ""}`;
        }

        const totalDuration = normalizedPaths.length * 2;
        const cmd = `${ffmpegPath.path} -y ${inputs} -filter_complex "${filter},format=yuv420p,scale=512:-1:flags=lanczos,fps=15" -t ${totalDuration} "${gifPath}"`;

        console.log("▶️ Running:", cmd);
        await execAsync(cmd);
        console.log("✅ GIF with fades created:", gifPath);

      } catch (err) {
        console.error("❌ Background GIF generation failed:", err);
      }
    })();
  } catch (err) {
    console.error("❌ Error in /submit route:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
