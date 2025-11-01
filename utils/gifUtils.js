import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import { exec } from "child_process";
import util from "util";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { File } from "node:buffer";
import dotenv from "dotenv";

dotenv.config();
fal.config({ credentials: process.env.FAL_KEY });

const execAsync = util.promisify(exec);

export async function runRemovalPipeline(photoDir, combinedPath, timestamp, removePrompt) {
  const normalizedPaths = [];
  try {
    console.log("🎬 Starting fast 2-pass background removals...");

    // === Downscale to speed up upload & FAL processing ===
    const smallBuffer = await sharp(combinedPath)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const smallFile = new File([smallBuffer], `${timestamp}_base.jpg`, { type: "image/jpeg" });
    const upload = await fal.storage.upload(smallFile);
    let currentUrl = typeof upload === "string" ? upload : upload.file?.url;

    // === Frame paths: start with the original ===
    const framePaths = [combinedPath];

    const extractUrl = (r) => {
      const imgs = r.data?.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return null;
      const first = imgs[0];
      return typeof first === "string" ? first : first?.url || null;
    };

    const fetchBuffer = async (url) => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Failed to fetch image: ${url}`);
      return Buffer.from(await resp.arrayBuffer());
    };

    const uploadBufferToFal = async (buf, name) => {
      const f = new File([buf], name, { type: "image/jpeg" });
      const up = await fal.storage.upload(f);
      return typeof up === "string" ? up : up.file?.url || null;
    };

    // === Run two removal passes ===
    for (let i = 1; i <= 2; i++) {
      console.log(`🧩 Removal ${i}/2: ${currentUrl}`);
      const result = await fal.subscribe("fal-ai/nano-banana/edit", {
        input: { prompt: removePrompt, image_urls: [currentUrl] },
        logs: false,
      });

      const outUrl = extractUrl(result);
      if (!outUrl) throw new Error(`Removal #${i} returned no image`);

      const buf = await fetchBuffer(outUrl);
      const framePath = path.join(photoDir, `${timestamp}_remove${i}.jpg`);
      fs.writeFileSync(framePath, buf);
      framePaths.push(framePath);
      console.log(`✅ Saved removal #${i}: ${framePath}`);

      // Short pause for FAL API cooldown
      await new Promise((r) => setTimeout(r, 400));
      currentUrl = await uploadBufferToFal(buf, `${timestamp}_remove${i}.jpg`);
    }

    console.log("🎉 Two-pass removal pipeline complete.");

    // === Normalize all images to same WxH ===
    console.log("🧮 Normalizing images...");
    const { width, height } = await sharp(framePaths[0]).metadata();

    for (const p of framePaths) {
      const out = p.replace(".jpg", "_norm.jpg");
      await sharp(p).resize({ width, height, fit: "cover" }).toFile(out);
      normalizedPaths.push(out);
    }

    // === Create GIF ===
    console.log("🎞️ Creating animated GIF...");
    const gifPath = path.join(photoDir, `${timestamp}.gif`);
    const inputs = normalizedPaths.map((p) => `-loop 1 -t 1 -i "${p}"`).join(" ");
    const filter = `[0:v][1:v]blend=all_expr='A*(1-T/0.5)+B*(T/0.5)',fps=15[vout]`;

    const cmd = `${ffmpegPath.path} -y ${inputs} -filter_complex "${filter}" -map "[vout]" "${gifPath}"`;
    await execAsync(cmd);
    console.log("✅ GIF created:", gifPath);

  } catch (err) {
    console.error("❌ Removal pipeline failed:", err);
  } finally {
    // Cleanup normalized temp files
    for (const n of normalizedPaths) {
      try { fs.unlinkSync(n); } catch { }
    }
  }
}
