import sharp from "sharp";
import axios from "axios";
import fs from "fs";
import FormData from "form-data";
import path from "path";

export async function sendToPrintServer(combinedPath, photoDir, timestamp) {
  try {
    const filepath = path.join(photoDir, `${timestamp}_print.jpg`);
    const singleStrip = await sharp(combinedPath)
      .resize({ width: 600, height: 1800, fit: "cover" })
      .removeAlpha()
      .jpeg({ quality: 95 })
      .toBuffer();

    await sharp({
      create: {
        width: 1200,
        height: 1800,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .composite([
        { input: singleStrip, left: 0, top: 0 },
        { input: singleStrip, left: 600, top: 0 },
      ])
      .gamma(0.8)
      .withMetadata({ density: 300 })
      .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
      .toFile(filepath);

    const form = new FormData();
    form.append("file", fs.createReadStream(filepath));
    const response = await axios.post("https://war-is-peace-print.ngrok.app/print", form, { headers: form.getHeaders() });

    console.log("✅ Print server response:", response.data);
  } catch (err) {
    console.error("❌ Print failed:", err.message);
  }
}
