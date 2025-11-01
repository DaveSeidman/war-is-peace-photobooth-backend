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

    // === Downscale before upload for faster FAL ===
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

    // === Run one fast FAL removal pass ===
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

    // === Normalize all images to same WxH ===
    console.log("🧮 Normalizing images…");
    const { width, height } = await sharp(framePaths[0]).metadata();
    for (const p of framePaths) {
      const out = p.replace(".jpg", "_norm.jpg");
      await sharp(p).resize({ width, height, fit: "cover" }).toFile(out);
      normalizedPaths.push(out);
    }

    // === Build GIF (square pixels + palette; FFmpeg 4.4+ safe) ===
    console.log("🎞️ Creating animated GIF with 2 s hold → 2 s fade → 2 s hold…");

    const gifPath = path.join(photoDir, `${timestamp}.gif`);
    const holdFirst = 2; // seconds
    const fade = 2;      // seconds
    const holdLast = 2;  // seconds
    const total = holdFirst + fade + holdLast;

    const cmd = `${ffmpegPath.path} -y \
      -loop 1 -t ${holdFirst} -i "${normalizedPaths[0]}" \
      -loop 1 -t ${fade}      -i "${normalizedPaths[0]}" \
      -loop 1 -t ${fade}      -i "${normalizedPaths[1]}" \
      -loop 1 -t ${holdLast}  -i "${normalizedPaths[1]}" \
      -filter_complex "
        [1:v][2:v]blend=all_expr='A*(1-T/${fade})+B*(T/${fade})'[vfade];
        [0:v][vfade][3:v]concat=n=3:v=1:a=0,
          setsar=1,setdar=1,         /* force square pixels */
          fps=15,
          scale=iw:ih:flags=lanczos, /* keep size, clean resample */
          split[v1][v2];
        [v1]palettegen=stats_mode=single[p];
        [v2][p]paletteuse=new=1:dither=sierra2_4a[vout]
      " \
      -map "[vout]" -t ${total} "${gifPath}"`;

    console.log("▶️ Running FFmpeg…");
    await execAsync(cmd);
    console.log("✅ GIF created with correct aspect:", gifPath);
  } catch (err) {
    console.error("❌ Removal pipeline failed:", err);
    if (err.stderr) console.error(err.stderr);
  } finally {
    for (const n of normalizedPaths) {
      try { fs.unlinkSync(n); } catch { }
    }
  }
}