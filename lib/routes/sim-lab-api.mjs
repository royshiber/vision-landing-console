/**
 * Sim lab API — parse telemetry logs for replay; optional MANUAL_CONTROL passthrough;
 * stub upload for aircraft photos / GLB (see docs/SITL_AND_SIM_LAB.md).
 */

import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { buildReplaySamplesFromBuffer } from '../sim-lab-tlog.mjs';
import { getActiveConnection } from '../mavlink-connection.mjs';
import { logger } from '../logger.mjs';
import { DEFAULT_RELEASES } from '../jetson-releases.mjs';
import { uploadsDir } from '../db.mjs';
import { publicUploadUrlFromAbsolute, storedRelativePathFromAbsolute } from '../upload-path.mjs';

const memUpload = multer({
  storage: multer.memoryStorage(),
  limits:    { fileSize: 85 * 1024 * 1024 },
});

/** אותן בדיקות טענה כמו בלקוח (`applyAircraftGlbUrl` / TextureLoader) למניעת SSRF בשטח ההעלאה. */
export function isSafeUploadsRelativeUrl(url) {
  if (typeof url !== 'string') return false;
  const u = url.trim();
  return u.startsWith('/uploads/') && !u.includes('..') && !u.includes('\\');
}

/**
 * MIME + שם קובץ (מטא מהלקוח) — מאותת עבור טסטים.
 * `application/octet-stream` עם תמונה בלי סיומת כנראה נגזר מה־sniff מהדיסק.
 * @returns {'photo'|'glb'|'gltf_zip'|'other'}
 */
export function classifyAircraftUpload(file) {
  const mime = String(file?.mimetype || '').toLowerCase().trim();
  const name = String(file?.originalname || '');
  const lower = name.toLowerCase();
  if (mime === 'model/gltf-binary' || lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.gltf') || lower.endsWith('.zip')) return 'gltf_zip';
  if (mime.startsWith('image/')) return 'photo';
  if (/\.(jpe?g|png|gif|webp|heic|heif|bmp|tif|tiff|avif|svg)$/i.test(name)) return 'photo';
  if (mime === 'application/octet-stream' || mime === 'binary/octet-stream') return 'other';
  if (!mime && lower) return 'other';
  return 'other';
}

/**
 * @param {Buffer} head
 * @returns {'photo'|'glb'|'gltf_zip'|null}
 */
export function sniffAircraftKindFromBuffer(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) return null;

  /** JPEG */
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'photo';
  /** PNG */
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (head.length >= 8 && head.subarray(0, 8).equals(pngSig)) return 'photo';
  /** BMP */
  if (head[0] === 0x42 && head[1] === 0x4d) return 'photo';
  /** GIF */
  if (
    head.length >= 6 &&
    (head.subarray(0, 6).equals(Buffer.from('GIF87a')) || head.subarray(0, 6).equals(Buffer.from('GIF89a')))
  ) {
    return 'photo';
  }
  /** WebP (RIFF … WEBP) */
  if (
    head.length >= 12 &&
    head.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    head.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return 'photo';
  }
  /** GLB */
  if (head.subarray(0, 4).equals(Buffer.from('glTF'))) return 'glb';
  /** ZIP (גלילת glTF מהדיסק נשמר כ־ZIP) */
  if (head[0] === 0x50 && head[1] === 0x4b && (head[2] === 3 || head[2] === 5 || head[2] === 7) && (head[3] === 4 || head[3] === 6 || head[3] === 8)) {
    return 'gltf_zip';
  }

  /** HEIC / HEIF / AVIF: ‎ISO BMFF עם ‎ftyp‎ (מותג ראשון בלבד — לא כל סוגי הווידאו) */
  if (head.length >= 12 && head.subarray(4, 8).equals(Buffer.from('ftyp'))) {
    const meta = head.subarray(8, Math.min(head.length, 32)).toString('ascii');
    const major = meta
      .slice(0, 4)
      .toLowerCase()
      .replace(/\0/g, '')
      .trim();
    if (['heic', 'heix', 'heim', 'heis', 'heif', 'mif1', 'msf1', 'avif', 'hev1'].includes(major)) return 'photo';
  }

  return null;
}

function readUploadedFileHead(absPath, maxLen = 128) {
  try {
    const buf = Buffer.alloc(maxLen);
    const fd = fs.openSync(absPath, 'r');
    try {
      const n = fs.readSync(fd, buf, 0, maxLen, 0);
      return buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * דיסק: ‎destination+filename‎ אם אין path (תאימות קשיחה עם גרסאות נשלחות למולטר).
 */
function aircraftUploadDiskAbsolutePath(file) {
  const p = file?.path;
  if (typeof p === 'string' && p.length > 0) return p;
  const dest = file?.destination;
  const fname = file?.filename;
  if (typeof dest === 'string' && typeof fname === 'string' && dest.length && fname.length) {
    return path.join(dest, fname);
  }
  if (typeof fname === 'string' && fname.length) return path.join(uploadsDir, fname);
  return null;
}

/**
 * אחרי שמולטר כתב לדיסק: מטא‑דאטה קודמת, עם התאמת מגנט לפי ערכת הבייטס הראשונים.
 */
function classifyAircraftUploadedFile(file) {
  let kind = classifyAircraftUpload(file);
  if (kind !== 'other') return kind;
  const abs = aircraftUploadDiskAbsolutePath(file);
  if (!abs) return 'other';
  const head = readUploadedFileHead(abs);
  if (!head) return 'other';
  return sniffAircraftKindFromBuffer(head) || 'other';
}

function multerAircraftReply(err, res) {
  const code = err?.code ? String(err.code) : '';
  if (code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({
      ok: false,
      code,
      message: 'הקובץ גדול מדי מהמגבלה בשרת (עד כ־80MB) — הקטין או דחוס לפני העלאה.',
    });
  }
  if (code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({
      ok: false,
      code,
      message: 'שם שדה מצורף לא צפוי — השתמש בשדה ‎file‎ בלבד.',
    });
  }
  if (typeof multer.MulterError === 'function' && err instanceof multer.MulterError) {
    return res.status(400).json({
      ok: false,
      code: err.code,
      message: err.message || `שגיאת העלאת קובץ: ${code || 'לא ידוע'}`,
    });
  }
  if (err?.name === 'MulterError' && typeof err.code === 'string') {
    return res.status(400).json({
      ok: false,
      code: err.code,
      message: err.message || `שגיאת העלאת קובץ: ${err.code}`,
    });
  }
  return res.status(400).json({
    ok: false,
    code: code || 'UPLOAD_PARSE_ERROR',
    message: typeof err?.message === 'string' ? err.message : 'שגיאה בעיבוד ההעלאה — נסה קובץ אחר או טען מחדש.',
  });
}

function meshProvidersConfigured() {
  return Boolean(
    process.env.MESHY_API_KEY ||
      process.env.TRIPO_API_KEY ||
      process.env.LUMA_API_KEY ||
      process.env.PHOTO_MESH_API_URL,
  );
}

/**
 * @param {import('express').Application} app
 * @param {{ db?: import('better-sqlite3').Database; upload?: import('multer').Multer }} [ctx]
 */
export function registerSimLabApi(app, ctx = {}) {
  const { db, upload } = ctx;

  app.get('/api/sim-lab/stack-presets', (_req, res) => {
    res.json({
      ok: true,
      arduPlane: [
        { id: 'ap44', label: 'ArduPlane 4.4.x (מוכן לייצור)', short: '4.4.x' },
        { id: 'ap45', label: 'ArduPlane 4.5.x', short: '4.5.x' },
        { id: 'ap46', label: 'ArduPlane 4.6 / master', short: '4.6/dev' },
        { id: 'custom', label: 'גרסה מותאמת…', short: 'custom' },
      ],
      jetson: DEFAULT_RELEASES.map((r) => ({
        version: r.version,
        channel: r.channel,
        label:   `${r.version} (${r.channel})`,
      })),
    });
  });

  app.get('/api/sim-lab/rc-capability', (_req, res) => {
    res.json({
      ok: true,
      manualControlAllowed: process.env.ALLOW_BROWSER_MANUAL_CONTROL === '1',
    });
  });

  app.get('/api/sim-lab/capabilities', (_req, res) => {
    res.json({
      ok: true,
      aircraftUpload: Boolean(db && upload),
      photoMeshEnvConfigured: meshProvidersConfigured(),
    });
  });

  app.get('/api/sim-lab/aircraft-models', (_req, res) => {
    if (!db) {
      return res.json({ ok: true, items: [], dbConfigured: false });
    }
    try {
      const rows = db
        .prepare(
          `SELECT id, original_name, asset_kind, mime, size_bytes, stored_path, processing_job_id, created_at
           FROM aircraft_model_assets ORDER BY datetime(created_at) DESC LIMIT 120`,
        )
        .all();
      const items = rows.map((r) => {
        const base = path.basename(r.stored_path);
        return {
          id: r.id,
          originalName: r.original_name,
          assetKind: r.asset_kind,
          mime: r.mime,
          sizeBytes: r.size_bytes,
          url: `/uploads/${encodeURIComponent(base)}`,
          processingJobId: r.processing_job_id || null,
          createdAt: r.created_at || null,
        };
      });
      res.json({ ok: true, dbConfigured: true, items });
    } catch (err) {
      logger.error({ err }, '[sim-lab] aircraft-models list failed');
      res.status(500).json({ ok: false, message: err?.message || 'list failed' });
    }
  });

  /** P3 stub: validates asset + env; full SaaS submit remains future work. */
  app.post('/api/sim-lab/mesh-job', (req, res) => {
    if (!db) return res.status(503).json({ ok: false, message: 'מסד נתונים לא זמין — לא ניתן לתור משימת mesh' });
    const assetId = Number(req.body?.assetId);
    if (!Number.isFinite(assetId) || assetId <= 0) {
      return res.status(400).json({ ok: false, message: 'חסר assetId מספרי' });
    }
    const row = db.prepare('SELECT id, asset_kind, original_name FROM aircraft_model_assets WHERE id = ?').get(assetId);
    if (!row) return res.status(404).json({ ok: false, message: 'נכס לא נמצא' });
    if (row.asset_kind !== 'photo') {
      return res.status(400).json({ ok: false, message: 'משימת mesh מיועדת לנכס מסוג תמונה בלבד' });
    }
    if (!meshProvidersConfigured()) {
      return res.status(503).json({
        ok: false,
        code: 'mesh_env_missing',
        message:
          'לא הוגדר מפתח ספק mesh בסביבה — ראו .env.example (‎MESHY_API_KEY / TRIPO_API_KEY / LUMA_API_KEY‎ או ‎PHOTO_MESH_API_URL‎).',
      });
    }
    return res.status(501).json({
      ok: false,
      code: 'not_implemented',
      message:
        'צינור העלאה לספק חיצוני מתוכנן (P3); השרת מאמת נכס וסביבה בלבד. השלב הבא: קריאת API ספק ועדכון processing_job_id.',
      assetId: row.id,
      assetKind: row.asset_kind,
    });
  });

  if (db && upload) {
    app.post('/api/aircraft-model/upload', (req, res) => {
      upload.single('file')(req, res, (multerErr) => {
        if (multerErr) return multerAircraftReply(multerErr, res);
        try {
          const f = req.file;
          const absDisk = aircraftUploadDiskAbsolutePath(f);
          if (!f || !absDisk) {
            return res.status(400).json({ ok: false, message: 'חסר קובץ בשדה ‎file‎ — בחר תמונה, GLB, או ZIP/GLTF.' });
          }

          let assetKind = classifyAircraftUploadedFile(f);

          /** אחרי מאות מגנט תעדכן MIME ליחידת שמירה אם הגיע מהממשק עם octet-stream */
          let storedMime =
            typeof f.mimetype === 'string' && f.mimetype.trim()
              ? f.mimetype.trim()
              : assetKind === 'photo'
                ? 'image/jpeg'
                : assetKind === 'glb'
                  ? 'model/gltf-binary'
                  : 'application/octet-stream';
          if (assetKind === 'photo' && (storedMime === 'application/octet-stream' || storedMime === 'binary/octet-stream')) {
            storedMime =
              /\.png$/i.test(String(f.originalname || ''))
                ? 'image/png'
                : /\.webp$/i.test(String(f.originalname || ''))
                  ? 'image/webp'
                  : /\.gif$/i.test(String(f.originalname || ''))
                    ? 'image/gif'
                    : /\.(bmp|dib)$/i.test(String(f.originalname || ''))
                      ? 'image/bmp'
                      : /\.tif{1,2}$/i.test(String(f.originalname || ''))
                        ? 'image/tiff'
                        : 'image/jpeg';
          }

          if (assetKind === 'other') {
            try {
              fs.unlinkSync(absDisk);
            } catch {
              /* ignore */
            }
            return res.status(415).json({
              ok: false,
              code: 'unsupported_type',
              message:
                'סוג קובץ לא נתמך — העלה תמונה (‎JPEG/PNG/WebP‎ וכוʼ), או ‎GLB‎, או ‎ZIP/GLTF‎. אם מהטלפון אין תוספת בסוף הקובץ, נסה לשמור מחדש עם סיומת או לייצא כ־JPEG.',
            });
          }

          const rel = storedRelativePathFromAbsolute(absDisk);
          const notes = String(req.body?.notes ?? '').trim().slice(0, 2000);
          const info = db
            .prepare(
              `INSERT INTO aircraft_model_assets (original_name, stored_path, mime, size_bytes, asset_kind, notes)
               VALUES (?,?,?,?,?,?)`,
            )
            .run((f.originalname || f.filename || 'upload').slice(0, 512), rel, storedMime, f.size ?? null, assetKind, notes || null);
          const id = Number(info.lastInsertRowid);
          const fileName = path.basename(absDisk);
          const downloadEnc = publicUploadUrlFromAbsolute(absDisk);
          res.json({
            ok: true,
            id,
            assetKind,
            sizeBytes: f.size ?? null,
            storedFile: fileName,
            downloadUrl: downloadEnc,
            /** כפילות בשם ידידותי לממשק; תמיד אותו נתיג כמו ‎downloadUrl‎ */
            url: downloadEnc,
          });
        } catch (err) {
          logger.error({ err }, '[sim-lab] aircraft-model upload failed');
          res.status(500).json({
            ok: false,
            code: 'storage_error',
            message: err?.message || 'כשל בהעלאה — בדוק נפח דיסק, הרשאות לכתיבה לנתיב data/uploads והרץ מחדש.',
          });
        }
      });
    });
  } else {
    logger.warn('[sim-lab] aircraft-model upload disabled — missing db or upload in route context');
  }

  app.post('/api/sim-lab/parse-tlog', memUpload.single('file'), (req, res) => {
    try {
      const f = req.file;
      if (!f?.buffer?.length) {
        return res.status(400).json({ ok: false, message: 'חסר קובץ (field file)' });
      }
      const name = String(f.originalname || 'log').toLowerCase();
      if (!name.endsWith('.tlog') && !name.endsWith('.bin') && !name.endsWith('.log')) {
        logger.warn({ name }, '[sim-lab] unexpected extension — trying anyway');
      }
      const parsed = buildReplaySamplesFromBuffer(f.buffer, { maxSamples: 22000, minStepMs: 70 });
      if (!parsed.samples?.length) {
        return res.status(422).json({
          ok:      false,
          message: 'לא נמצאו דגימות ATTITUDE/GPS בקובץ — ודא שזה ‎.tlog‎ של Mission Planner או זרם MAVLink תקין.',
          frameCount: parsed.frameCount ?? 0,
        });
      }
      res.json({
        ok:           true,
        samples:      parsed.samples,
        replayEvents: parsed.replayEvents ?? [],
        durationMs:   parsed.durationMs,
        frameCount:   parsed.frameCount,
        originalName: f.originalname || null,
      });
    } catch (err) {
      logger.error({ err }, '[sim-lab] parse-tlog failed');
      res.status(500).json({ ok: false, message: err?.message || 'parse failed' });
    }
  });

  app.post('/api/mavlink/manual-control', (req, res) => {
    if (process.env.ALLOW_BROWSER_MANUAL_CONTROL !== '1') {
      return res.status(403).json({
        ok:      false,
        code:    'disabled',
        message: 'שליחת שליטה מהדפדפן כבויה — הגדר ALLOW_BROWSER_MANUAL_CONTROL=1 בשרת (סיכון בטיחותי).',
      });
    }
    const mavConn = getActiveConnection?.();
    if (!mavConn?.connected) {
      return res.status(409).json({ ok: false, message: 'אין חיבור MAVLink פעיל' });
    }
    const body = req.body || {};
    const x = Number(body.x);
    const y = Number(body.y);
    const z = Number(body.z);
    const r = Number(body.r);
    const buttons = Number(body.buttons) || 0;
    try {
      mavConn.sendManualControl({ x, y, z, r, buttons });
      res.json({ ok: true });
    } catch (err) {
      logger.warn({ err: err?.message }, '[sim-lab] manual-control failed');
      res.status(500).json({ ok: false, message: err?.message || 'send failed' });
    }
  });
}
