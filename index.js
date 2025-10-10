import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI, { toFile } from "openai";
import dotenv from "dotenv";

dotenv.config();
// Ensure uploads directory exists
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const app = express();
const PORT = 8000;

// Allow all origins for localhost testing
app.use(cors());

// Multer setup to handle file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `photo_${timestamp}${ext}`);
  },
});

const upload = multer({ storage });

// Parse JSON (for non-file routes)
app.use(express.json());

// Upload endpoint
app.post("/upload", upload.single("photo"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  console.log(`Saved file: ${req.file.path}`);

  res.json({
    success: true,
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
  });
});

// Static serve uploaded files
app.use("/uploads", express.static(uploadDir));

app.get("/test", async (req, res) => {
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_KEY });

    const inputPath = path.join(uploadDir, "test.jpg"); // change to .png/.webp if needed
    const outputPath = path.join(uploadDir, "test_edited.jpg");

    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ error: "uploads/test.jpg not found" });
    }

    // Pick the right MIME based on extension
    const ext = path.extname(inputPath).toLowerCase();
    const mime =
      ext === ".jpg" || ext === ".jpeg"
        ? "image/jpeg"
        : ext === ".png"
          ? "image/png"
          : ext === ".webp"
            ? "image/webp"
            : null;

    if (!mime) {
      return res.status(400).json({ error: "Unsupported image type. Use JPG/PNG/WebP." });
    }

    // IMPORTANT: wrap the stream so the SDK sends a proper multipart with Content-Type
    const imageFile = await toFile(fs.createReadStream(inputPath), path.basename(inputPath), {
      type: mime,
    });

    console.log("🧠 Sending image to GPT for editing...");
    const response = await client.images.edit({
      model: "gpt-image-1",
      image: [imageFile], // can be a single File or an array
      prompt: "Remove one random person from this photo and fill the background naturally.",
      size: "1024x1024",
    });

    const editedBase64 = response.data[0].b64_json;
    fs.writeFileSync(outputPath, Buffer.from(editedBase64, "base64"));

    console.log("✅ Saved edited image:", outputPath);

    res.json({
      success: true,
      output: `/uploads/${path.basename(outputPath)}`,
    });
  } catch (err) {
    console.error("❌ Error editing image:", err);
    res.status(500).json({ error: err.message });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("photo server");
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
