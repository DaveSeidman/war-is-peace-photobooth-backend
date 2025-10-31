import fs from "fs";
import multer from "multer";
import path from "path";

export const ensureDirs = (dirs) => {
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  });
};

export const createMulterUpload = (uploadDir) => {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `photo_${timestamp}${ext}`);
    },
  });
  return multer({ storage });
};
