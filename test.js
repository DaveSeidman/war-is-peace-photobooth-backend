import { fal } from "@fal-ai/client";
import dotenv from "dotenv";
dotenv.config();

fal.config({ credentials: process.env.FAL_KEY });

try {
  const result = await fal.subscribe("fal-ai/nano-banana", {
    input: { prompt: "a cat" },
  });
  console.log("✅ Connected to Fal successfully", result.request_id);
} catch (err) {
  console.error("❌ Fal connectivity failed", err.message);
}
