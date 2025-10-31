import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fal } from "@fal-ai/client";
import sharp from "sharp";
import { exec } from "child_process";
import util from "util";
import ffmpegPath from "@ffmpeg-installer/ffmpeg";
import { File } from "node:buffer";

const execAsync = util.promisify(exec);

// Ensure Fal is configured here so imports elsewhere don't race it
import dotenv from "dotenv";
dotenv.config();
fal.config({ credentials: process.env.FAL_KEY });

export async function runRemovalPipeline(photoDir, combinedPath, timestamp, removePrompt) {
  (async () => {
    const normalizedPaths = [];
    try {
      console.log("🎬 Starting background nano-banana removals...");

      const compBuffer = fs.readFileSync(combinedPath);
      const compFile = new File([compBuffer], `${timestamp}.jpg`, { type: "image/jpeg" });
      const compUpload = await fal.storage.upload(compFile);
      let currentUrl = typeof compUpload === "string" ? compUpload : compUpload.file?.url;

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

      // === iterative removals ===
      for (let i = 1; i <= 3; i++) {
        console.log(`🧩 Running removal ${i}/3 using ${currentUrl} ...`);
        const result = await fal.subscribe("fal-ai/nano-banana/edit", {
          input: { prompt: removePrompt, image_urls: [currentUrl] },
          logs: true,
        });
        const outUrl = extractUrl(result);
        if (!outUrl) throw new Error(`Fal removal #${i} returned no image`);

        const buf = await fetchBuffer(outUrl);
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

      // === Normalize all images to same WxH ===
      console.log("🧮 Normalizing image sizes...");
      const { width, height } = await sharp(framePaths[0]).metadata();

      for (let i = 0; i < framePaths.length; i++) {
        const outPath = framePaths[i].replace(".jpg", "_norm.jpg");
        await sharp(framePaths[i]).resize({ width, height, fit: "cover" }).toFile(outPath);
        normalizedPaths.push(outPath);
      }

      // === FFmpeg GIF generation with PROPER chained xfade ===
      console.log("🎞️ Creating animated GIF with chained fades...");

      const gifPath = path.join(photoDir, `${timestamp}.gif`);

      // Build inputs: each still plays 2s, we’ll xfade 1s between them
      const inputs = normalizedPaths.map((p) => `-loop 1 -t 2 -i "${p}"`).join(" ");

      // Chained xfade segments: [0][1] -> [v1]; [v1][2] -> [v2]; ...
      const parts = [];
      for (let i = 1; i < normalizedPaths.length; i++) {
        const inA = i === 1 ? `[0:v]` : `[v${i - 1}]`;
        const inB = `[${i}:v]`;
        const out = `[v${i}]`;
        const offset = i * 2 - 1; // fade starts 1s before next still
        parts.push(`${inA}${inB}xfade=transition=fade:duration=1:offset=${offset}${i < normalizedPaths.length - 1 ? out + ";" : out}`);
      }

      const lastLabel = `[v${normalizedPaths.length - 1}]`;

      // 🔑 The critical fix: feed last label into format/scale/fps, then map vout
      const filter =
        parts.join("") +
        `;${lastLabel}format=yuv420p,scale=512:-1:flags=lanczos,fps=15[vout]`;

      const totalDuration = normalizedPaths.length * 2; // 2s per still

      const cmd = `${ffmpegPath.path} -y ${inputs} -filter_complex "${filter}" -map "[vout]" -t ${totalDuration} "${gifPath}"`;

      console.log("▶️ Running FFmpeg:");
      console.log(cmd);

      await execAsync(cmd);
      console.log("✅ GIF with chained fades created:", gifPath);
    } catch (err) {
      console.error("❌ Background GIF generation failed:", err);
    } finally {
      // Cleanup normalized temps even on failure
      for (const n of normalizedPaths) {
        try { fs.unlinkSync(n); } catch { }
      }
    }
  })();
}
