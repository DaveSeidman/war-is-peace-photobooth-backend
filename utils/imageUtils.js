import sharp from "sharp";
import fetch from "node-fetch";
import fs from "fs";
import path from "path";



/**
 * Resize an image from disk.
 */
export async function resizeImage(filepath, width) {
  return sharp(filepath)
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}
export async function composeImages(originalPath, pastUrl, futureUrl, outputDir, timestamp) {
  const backgroundPath = path.join(process.cwd(), "assets", "background.png");

  const fetchBuffer = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
    return Buffer.from(await res.arrayBuffer());
  };

  // === Load source buffers ===
  const bufPast = await fetchBuffer(pastUrl);
  const bufFuture = await fetchBuffer(futureUrl);
  const bufOriginal = fs.readFileSync(originalPath);

  // === Fixed layout ===
  const BG_WIDTH = 600;
  const BG_HEIGHT = 1800;
  const PHOTO_WIDTH = 540;
  const PHOTO_HEIGHT = 440; // 🔹 fixed height
  const SIDE_MARGIN = 30;
  const TOP_MARGIN = 40;
  const BOTTOM_MARGIN = 200;
  const VERTICAL_GAP = 60;

  // === Resize all photos to fixed size ===
  const images = [bufPast, bufOriginal, bufFuture];
  const resized = await Promise.all(
    images.map((img) =>
      sharp(img)
        .resize({
          width: PHOTO_WIDTH,
          height: PHOTO_HEIGHT,
          fit: "cover",
          position: "center",
        })
        .jpeg({ quality: 90 })
        .toBuffer()
    )
  );

  // === Prepare exact background ===
  const bgBuffer = await sharp(backgroundPath)
    .resize({
      width: BG_WIDTH,
      height: BG_HEIGHT,
      fit: "cover",
      position: "center",
    })
    .toBuffer();

  // === Calculate positions ===
  const composites = resized.map((input, i) => ({
    input,
    left: SIDE_MARGIN,
    top: TOP_MARGIN + i * (PHOTO_HEIGHT + VERTICAL_GAP),
  }));

  const combinedPath = path.join(outputDir, `${timestamp}.jpg`);

  await sharp(bgBuffer)
    .composite(composites)
    .jpeg({ quality: 90 })
    .toFile(combinedPath);

  console.log("✅ Saved composite image with fixed 440px photos:", combinedPath);
  console.log(`   Background: ${BG_WIDTH}x${BG_HEIGHT}`);
  console.log(`   Each photo: ${PHOTO_WIDTH}x${PHOTO_HEIGHT}`);
  console.log(`   Margins: top=${TOP_MARGIN}, bottom=${BOTTOM_MARGIN}, gap=${VERTICAL_GAP}`);

  return combinedPath;
}
