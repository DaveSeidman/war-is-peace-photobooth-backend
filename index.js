import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";

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

// Static serve uploaded files (optional)
app.use("/uploads", express.static(uploadDir));

app.get('/', (req, res) => {
  res.send('photo server online');
})

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
