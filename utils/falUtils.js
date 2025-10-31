import { fal } from "@fal-ai/client";
import { File } from "node:buffer";
import dotenv from "dotenv";
dotenv.config();

fal.config({ credentials: process.env.FAL_KEY });

export async function uploadAndEditFal(buffer, filename, pastPrompt, futurePrompt) {
  try {
    // === Upload image ===
    const file = new File([buffer], filename, { type: "image/jpeg" });
    const uploaded = await fal.storage.upload(file);

    const imageUrl =
      typeof uploaded === "string"
        ? uploaded
        : uploaded.file?.url || (() => { throw new Error("Fal upload failed"); })();

    if (!imageUrl) throw new Error("Fal upload returned no URL");

    console.log("✅ Uploaded resized image to Fal:", imageUrl);

    // === Helper to extract URLs from Fal responses ===
    const extractUrl = (r) => {
      const imgs = r.data?.images;
      if (!Array.isArray(imgs) || imgs.length === 0) return null;
      const first = imgs[0];
      return typeof first === "string" ? first : first?.url || null;
    };

    console.log("🚀 Sending Fal edits (past + future)...");

    // === Run both edits in parallel ===
    const [pastResult, futureResult] = await Promise.all([
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: {
          prompt: pastPrompt,
          image_urls: [imageUrl],
          num_images: 1,
          output_format: "jpeg",
        },
        logs: true,
      }),
      fal.subscribe("fal-ai/nano-banana/edit", {
        input: {
          prompt: futurePrompt,
          image_urls: [imageUrl],
          num_images: 1,
          output_format: "jpeg",
        },
        logs: true,
      }),
    ]);

    const pastUrl = extractUrl(pastResult);
    const futureUrl = extractUrl(futureResult);
    if (!pastUrl || !futureUrl) throw new Error("Missing Fal image URLs");

    console.log("✅ Fal edits complete:");
    console.log("  Past →", pastUrl);
    console.log("  Future →", futureUrl);

    return { imageUrl, pastUrl, futureUrl };

  } catch (err) {
    // === Detailed Fal error logging ===
    console.error("❌ Fal API call failed:");
    console.error("Message:", err.message);

    if (err.status) console.error("Status:", err.status);
    if (err.body) {
      console.error("Body:", JSON.stringify(err.body, null, 2));
      if (Array.isArray(err.body.detail)) {
        console.error("Details:");
        err.body.detail.forEach((d, i) => console.error(`  [${i}]`, d));
      }
    }

    throw err; // rethrow to be caught by /submit
  }
}
