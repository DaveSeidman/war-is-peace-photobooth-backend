import express from "express";
import cors from "cors";
import path from "path";
import { ensureDirs, createMulterUpload } from "./utils/fileUtils.js";
import { uploadAndEditFal } from "./utils/falUtils.js";
import { composeImages, resizeImage } from "./utils/imageUtils.js";
import { sendToPrintServer } from "./utils/printUtils.js";
import { runRemovalPipeline } from "./utils/gifUtils.js";

const app = express();
const PORT = process.env.PORT || 8000;

const prompts = {
  past: "keep all the peopleRecreate the SOURCE IMAGE without any change to framing, crop, zoom level, or perspective — keep every person in exactly the same size and position within the frame as in the source. Maintain identical composition, poses, facial expressions, and camera distance. Only restyle the clothing, background, and lighting to match the American Old West (late 1800s). Reinterpret any modern or themed costumes as authentic period equivalents. Use monochrome sepia tone, soft film grain, light vignette, and gentle aging texture to evoke an antique photograph. The scene must look as if the original image were time-shifted, not re-shot, so framing and proportions remain perfectly constant. the same, but make it look like the photo was taken in the wild wild west (late 1800's) add some light wrinkling and weathering at the edges, use sepia tones. Cowboys and cowgirls. do not change the framing or composition",
  future: "Recreate the SOURCE IMAGE with identical framing, crop, composition, poses, and facial expressions. Do not alter camera angle or zoom. Transform the scene into a futuristic spaceship interior with curved metallic walls, glowing panels, and soft ambient light. Replace all clothing with advanced materials and sculpted futuristic designs. Modify every hairstyle into visibly futuristic versions — metallic sheen, luminous streaks, gravity-defying shapes — while keeping faces recognizable. Add tasteful cybernetic or biological augmentations such as subtle implants or light patterns, maintaining realism and identical body proportions. do not change the framing or proportions",
  remove: "“Erase one person entirely from the photo and restore the missing background so it looks natural. Keep lighting, colors, and composition identical."
};

app.use(cors());
app.use(express.json());

const uploadDir = path.join(process.cwd(), "uploads");
const photoDir = path.join(process.cwd(), "photos");
ensureDirs([uploadDir, photoDir]);

const upload = createMulterUpload(uploadDir);
app.use("/uploads", express.static(uploadDir));
app.use("/photos", express.static(photoDir));

app.get("/", (req, res) => res.json({ status: "ok" }));
app.get("/prompts", (req, res) => res.json(prompts));

app.post("/submit", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const timestamp = Date.now();
    const originalPath = req.file.path;
    const { pastPrompt, futurePrompt, removePrompt } = req.body;

    const resizedBuffer = await resizeImage(originalPath, 512);
    const { pastUrl, futureUrl, imageUrl } = await uploadAndEditFal(resizedBuffer, req.file.filename, pastPrompt, futurePrompt);

    const combinedPath = await composeImages(originalPath, pastUrl, futureUrl, photoDir, timestamp);
    res.json({
      success: true,
      input: `/uploads/${req.file.filename}`,
      output: { past: pastUrl, future: futureUrl, photoId: timestamp },
    });

    await sendToPrintServer(combinedPath, photoDir, timestamp);
    console.log('start removal pipeline');
    runRemovalPipeline(photoDir, combinedPath, timestamp, removePrompt);
  } catch (err) {
    console.error("❌ Error in /submit:", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
