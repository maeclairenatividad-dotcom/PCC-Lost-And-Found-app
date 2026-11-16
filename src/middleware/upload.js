/**
 * Image uploads: images only, 5 MB cap, five per request.
 *
 * Bytes are kept in the `upload_files` table rather than on disk. Free hosts
 * give the app an ephemeral filesystem, so a file written to public/uploads
 * disappears on the next deploy or restart and every photo 404s.
 */
const multer = require('multer');
const { run } = require('../db');

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Only JPG, PNG, WEBP or HEIC images are accepted.'));
  }
});

/** Store an uploaded image and return the web path to save in the database. */
async function saveUpload(file) {
  if (!file) return null;
  const result = await run(
    'INSERT INTO upload_files (filename, mime_type, byte_size, data) VALUES (?, ?, ?, ?)',
    [file.originalname || null, file.mimetype, file.size, file.buffer]
  );
  return `/files/${result.insertId}`;
}

module.exports = { upload, saveUpload };
