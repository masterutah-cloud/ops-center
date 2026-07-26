require("dotenv").config();
const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const basicAuth = require("express-basic-auth");
const multer = require("multer");
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");

const app = express();

// Railway's internal Postgres URLs don't need SSL; most external Postgres hosts do.
// This handles both without needing separate config.
const useSSL = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("railway.internal");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false,
});

// S3-compatible client — works with Cloudflare R2, AWS S3, or any S3-compatible
// bucket. See README for the (one-time) R2 setup steps.
const s3Configured = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);
const s3 = s3Configured
  ? new S3Client({
      region: "auto",
      endpoint: process.env.S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    })
  : null;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB cap

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ops_data (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    INSERT INTO ops_data (id, data) VALUES ('singleton', '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
}

app.use(express.json({ limit: "2mb" }));

// Optional shared-password gate. Set OPS_USER / OPS_PASS to enable.
if (process.env.OPS_USER && process.env.OPS_PASS) {
  app.use(
    basicAuth({
      users: { [process.env.OPS_USER]: process.env.OPS_PASS },
      challenge: true,
      realm: "Ops Center",
    })
  );
}

// GET /api/jobs — returns the current job list. A real network/server failure
// returns a non-200 status, so the frontend can tell "empty" apart from "broken"
// (this is the ambiguity the artifact version couldn't resolve).
app.get("/api/jobs", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT data FROM ops_data WHERE id = 'singleton'");
    res.json(rows[0]?.data ?? []);
  } catch (e) {
    console.error("Failed to load jobs:", e);
    res.status(500).json({ error: "Failed to load jobs" });
  }
});

// PUT /api/jobs — overwrites the whole job list. Simple and matches the shape
// the frontend already works with; safe for a small team's data volume.
app.put("/api/jobs", async (req, res) => {
  const jobs = req.body;
  if (!Array.isArray(jobs)) return res.status(400).json({ error: "Expected an array of jobs" });
  try {
    await pool.query(
      `INSERT INTO ops_data (id, data, updated_at) VALUES ('singleton', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = $1::jsonb, updated_at = now()`,
      [JSON.stringify(jobs)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("Failed to save jobs:", e);
    res.status(500).json({ error: "Failed to save jobs" });
  }
});

// POST /api/upload — accepts one file (receipt photo, project photo, or document),
// uploads it to the configured bucket, and returns its public URL. The frontend
// stores that URL on the job's expense/file record — the file itself never
// touches Postgres, so large photos don't bloat the database.
app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!s3Configured) return res.status(503).json({ error: "File storage isn't configured yet (see README: S3_ENDPOINT / S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY)" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const ext = (req.file.originalname.match(/\.[a-zA-Z0-9]+$/) || [""])[0];
    const key = `uploads/${Date.now()}-${crypto.randomBytes(6).toString("hex")}${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    const publicBase = (process.env.S3_PUBLIC_URL_BASE || "").replace(/\/$/, "");
    res.json({ key, url: `${publicBase}/${key}`, name: req.file.originalname, type: req.file.mimetype });
  } catch (e) {
    console.error("Upload failed:", e);
    res.status(500).json({ error: "Upload failed" });
  }
});

// DELETE /api/upload/:key — removes a file from the bucket (used when someone
// deletes an expense/photo that had a receipt attached, to avoid orphaned files).
app.delete("/api/upload/*", async (req, res) => {
  if (!s3Configured) return res.status(503).json({ error: "File storage isn't configured" });
  const key = req.params[0];
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    res.json({ ok: true });
  } catch (e) {
    console.error("Delete failed:", e);
    res.status(500).json({ error: "Delete failed" });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const port = process.env.PORT || 3000;
ensureSchema()
  .then(() => app.listen(port, () => console.log(`Ops Center running on port ${port}${s3Configured ? "" : " (file uploads not configured — see README)"}`)))
  .catch((err) => {
    console.error("Failed to set up database schema:", err);
    process.exit(1);
  });
