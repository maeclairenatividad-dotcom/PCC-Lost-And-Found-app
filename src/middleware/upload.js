/** Image uploads: disk storage under public/uploads, images only, 5 MB cap. */
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
  }
});

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP or HEIC images are accepted.'));
  }
});

/** Turn a multer file into the web path stored in the database. */
const webPath = (file) => (file ? `/uploads/${file.filename}` : null);

module.exports = { upload, webPath, UPLOAD_DIR };
