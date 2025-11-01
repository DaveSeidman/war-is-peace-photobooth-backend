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
    console.log("🎬 Starting single-pass background removal…");

    // Downscale before upload for faster FAL
    const smallBuffer = await sharp(combinedPath)
      .resize({ width: 512, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    const smallFile = new File([smallBuffer], `${timestamp}_base.jpg`, { type: "image/jpeg" });
    const upload = await fal.storage.upload(smallFile);
    let currentUrl = typeof upload === "string" ? upload : upload.file?.url;

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

    // One fast FAL removal pass
    console.log("🧩 Running single removal with FAL…");
    const result = await fal.subscribe("fal-ai/nano-banana/edit", {
      input: { prompt: removePrompt, image_urls: [currentUrl] },
      logs: false,
    });

    const outUrl = extractUrl(result);
    if (!outUrl) throw new Error("FAL removal returned no image.");

    const buf = await fetchBuffer(outUrl);
    const framePath = path.join(photoDir, `${timestamp}_remove1.jpg`);
    fs.writeFileSync(framePath, buf);
    framePaths.push(framePath);
    console.log(`✅ Saved removal image: ${framePath}`);

    // Normalize both images to same WxH
    console.log("🧮 Normalizing images…");
    const { width, height } = await sharp(framePaths[0]).metadata();
    for (const p of framePaths) {
      const out = p.replace(".jpg", "_norm.jpg");
      await sharp(p).resize({ width, height, fit: "cover" }).toFile(out);
      normalizedPaths.push(out);
    }

    // Build GIF (2s hold → 2s fade → 2s hold) with square pixels + palette
    // === Create GIF ===
    console.log("🎞️ Creating animated GIF...");
    const gifPath = path.join(photoDir, `${timestamp}.gif`);

    // Make each frame show for 1s, then crossfade over 0.5s
    const stillDuration = 1;
    const fadeDuration = 0.5;

    const inputs = normalizedPaths.map((p) => `-loop 1 -t ${stillDuration} -i "${p}"`).join(" ");

    // Build a simple two-stage crossfade for up to 3 images
    // ffmpeg’s xfade filter is cleaner than manually using blend
    let filter;
    if (normalizedPaths.length === 2) {
      filter = `[0:v][1:v]xfade=transition=fade:duration=${fadeDuration}:offset=${stillDuration - fadeDuration},format=yuv420p[vout]`;
    } else if (normalizedPaths.length === 3) {
      filter = `[0:v][1:v]xfade=transition=fade:duration=${fadeDuration}:offset=${stillDuration - fadeDuration}[tmp];` +
        `[tmp][2:v]xfade=transition=fade:duration=${fadeDuration}:offset=${2 * (stillDuration - fadeDuration)},format=yuv420p[vout]`;
    } else {
      throw new Error(`Unexpected frame count: ${normalizedPaths.length}`);
    }

    const cmd = `${ffmpegPath.path} -y ${inputs} -filter_complex "${filter}" -map "[vout]" -r 15 "${gifPath}"`;

    console.log("▶️ Running FFmpeg:\n", cmd);
    await execAsync(cmd);
    console.log("✅ GIF created:", gifPath);

  } catch (err) {
    console.error("❌ Removal pipeline failed:", err);
    if (err.stderr) console.error(err.stderr);
  } finally {
    for (const n of normalizedPaths) {
      try { fs.unlinkSync(n); } catch { }
    }
  }
}

/**
 * Render.com notes:
 * - Using @ffmpeg-installer/ffmpeg is fine. Alternatively install system ffmpeg in build step.
 * - Verify filters:  ffmpeg -filters | grep -E "blend|palettegen|paletteuse"
 */
