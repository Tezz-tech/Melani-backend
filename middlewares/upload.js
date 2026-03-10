const multer = require('multer');
const sharp  = require('sharp');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');
const AppError = require('../utils/apperror');

const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Multer config — store in memory first, then process ───────
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new AppError('Only JPEG, PNG, and WebP images are accepted.', 400), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '10')) * 1024 * 1024 },
});

// ── Sharp processor: resize + compress + save ─────────────────
const processScanImage = async (req, res, next) => {
  if (!req.file) return next();

  const filename  = `scan-${uuidv4()}.jpg`;
  const filepath  = path.join(UPLOAD_DIR, filename);

  await sharp(req.file.buffer)
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 88, progressive: true })
    .toFile(filepath);

  req.file.filename = filename;
  req.file.filepath = filepath;
  req.file.path     = filepath;

  next();
};

module.exports = { upload, processScanImage };