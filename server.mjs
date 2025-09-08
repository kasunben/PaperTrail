import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import fetch from "node-fetch";
import sharp from "sharp";
import archiver from "archiver";
import unzipper from "unzipper";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Per-board storage helpers
function boardDir(root, id) { return path.join(root, id); }
function boardJsonPath(root, id) { return path.join(boardDir(root, id), 'board.json'); }
function boardUploadsDir(root, id) { return path.join(boardDir(root, id), 'uploads'); }

/** Helpers */
function sanitizeUrl(u, opts = { allowRelative: true }) {
  if (!u || typeof u !== "string") return "";
  const s = u.trim();

  // 1) Absolute http/https URLs
  try {
    const abs = new URL(s);
    if (abs.protocol === "http:" || abs.protocol === "https:") {
      return abs.href;
    }
    return ""; // reject javascript:, data:, etc.
  } catch {
    // not absolute; continue
  }

  // 2) Site-relative URLs (begin with "/")
  if (opts.allowRelative && s.startsWith("/")) {
    try {
      // Use a throwaway base only for parsing; then reconstruct a relative URL
      const parsed = new URL(s, "http://x");
      const rel = parsed.pathname + parsed.search + parsed.hash;
      // Allow only known safe prefixes under our app
      const allowed = ["/uploads/", "/assets/"]; // extend if needed
      if (allowed.some((p) => rel.startsWith(p))) return rel;
      return "";
    } catch {
      return "";
    }
  }

  return ""; // anything else is rejected
}

function stripDangerousHtml(html) {
  if (!html || typeof html !== "string") return "";
  // remove dangerous elements
  let out = html
    .replace(/<\/(script|style|iframe|object|embed|link|meta)[^>]*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta)[^>]*>/gi, "");
  // remove event handlers + inline styles
  out = out
    .replace(/\son[a-z]+\s*=\s*(\"[^\"]*\"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(['"])([^'"]*)\2/gi, (m, a, q, v) => {
      const safe = sanitizeUrl(v);
      return safe ? `${a}=${q}${safe}${q}` : "";
    })
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (out.length > 20000) out = out.slice(0, 20000);
  return out;
}

function normalizeTags(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let t of arr) {
    if (typeof t !== "string") continue;
    t = t.trim().replace(/^#+/, "").toLowerCase();
    if (t && out.length < 64 && !out.includes(t)) out.push(t);
  }
  return out;
}

function sanitizeNode(node, i = 0) {
  const n = {
    id: typeof node.id === "string" ? node.id : `n_${i}`,
    type: ["text", "image", "link", "imageText"].includes(node.type)
      ? node.type
      : "text",
    x: Number.isFinite(node.x) ? node.x : 100 + i * 20,
    y: Number.isFinite(node.y) ? node.y : 100 + i * 20,
    w: Number.isFinite(node.w) ? node.w : undefined,
    h: Number.isFinite(node.h) ? node.h : undefined,
    data: typeof node.data === "object" && node.data ? { ...node.data } : {},
  };
  const d = n.data;
  if (typeof d.title === "string") d.title = d.title.slice(0, 512);
  if (typeof d.text === "string") d.text = d.text.slice(0, 8000);
  if (typeof d.html === "string") d.html = stripDangerousHtml(d.html);
  if (typeof d.descHtml === "string")
    d.descHtml = stripDangerousHtml(d.descHtml);
  if (typeof d.linkUrl === "string") d.linkUrl = sanitizeUrl(d.linkUrl);
  if (typeof d.imageUrl === "string") d.imageUrl = sanitizeUrl(d.imageUrl);
  d.tags = normalizeTags(d.tags);
  return n;
}

function sanitizeEdge(edge, i = 0) {
  const e = {
    id: typeof edge.id === "string" ? edge.id : `e_${i}`,
    sourceId: String(edge.sourceId || ""),
    targetId: String(edge.targetId || ""),
  };
  if (!e.sourceId || !e.targetId || e.sourceId === e.targetId) return null;
  if (typeof edge.label === "string") e.label = edge.label.slice(0, 256);
  if (edge.dashed) e.dashed = true;
  if (typeof edge.color === "string") {
    const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
    const named =
      /^(?:red|blue|green|black|white|gray|grey|orange|purple|yellow|pink|teal|cyan|magenta|brown)$/i;
    const ok = hex.test(edge.color) || named.test(edge.color);
    if (ok) e.color = edge.color;
  }
  return e;
}

function sanitizeBoard(incoming) {
  const out = {
    id: "board-1",
    title:
      typeof incoming.title === "string"
        ? incoming.title.slice(0, 256)
        : "My Evidence Board",
    createdAt: incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
  };
  const nodes = Array.isArray(incoming.nodes)
    ? incoming.nodes.slice(0, 5000)
    : [];
  out.nodes = nodes.map(sanitizeNode);
  const edges = Array.isArray(incoming.edges)
    ? incoming.edges.slice(0, 20000)
    : [];
  for (let i = 0; i < edges.length; i++) {
    const e = sanitizeEdge(edges[i], i);
    if (!e) continue;
    if (!out.nodes.find((n) => n.id === e.sourceId)) continue;
    if (!out.nodes.find((n) => n.id === e.targetId)) continue;
    out.edges.push(e);
  }
  return out;
}
/** end of Helpers */

const app = express();

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
  // Relax CSP for inline scripts (quick fix)
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "connect-src 'self'",
      "frame-ancestors 'self'"
    ].join("; ")
  );
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
await fs.mkdir(DATA_DIR, { recursive: true });

// Detect and migrate old layout if needed: data/board.json and data/uploads -> data/board-1/{board.json,uploads}
let currentBoardId = 'board-1';
const OLD_BOARD_PATH = path.join(DATA_DIR, 'board.json');
const OLD_UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const NEW_BOARD_JSON = boardJsonPath(DATA_DIR, currentBoardId);

try {
  await fs.access(OLD_BOARD_PATH);
  // Old layout detected; migrate
  let oldBoard = emptyBoard();
  try { oldBoard = JSON.parse(await fs.readFile(OLD_BOARD_PATH, 'utf-8')); } catch {}
  const migratedId = (oldBoard && typeof oldBoard.id === 'string' && oldBoard.id.trim()) ? oldBoard.id.trim() : currentBoardId;
  currentBoardId = migratedId;
  const targetDir = boardDir(DATA_DIR, currentBoardId);
  await fs.mkdir(targetDir, { recursive: true });
  const targetJson = boardJsonPath(DATA_DIR, currentBoardId);
  // Move board.json
  await fs.rename(OLD_BOARD_PATH, targetJson).catch(async () => {
    // If rename fails (cross-device), write instead
    await fs.writeFile(targetJson, JSON.stringify(oldBoard || emptyBoard(), null, 2), 'utf-8');
    await fs.unlink(OLD_BOARD_PATH).catch(() => {});
  });
  // Move uploads dir if present
  try {
    await fs.access(OLD_UPLOADS_DIR);
    const targetUploads = boardUploadsDir(DATA_DIR, currentBoardId);
    await fs.mkdir(targetUploads, { recursive: true });
    // simple move: read filenames and rename into new dir
    const files = await fs.readdir(OLD_UPLOADS_DIR);
    for (const f of files) {
      await fs.rename(path.join(OLD_UPLOADS_DIR, f), path.join(targetUploads, f)).catch(() => {});
    }
    // try remove old dir
    try { await fs.rmdir(OLD_UPLOADS_DIR); } catch {}
  } catch {}
} catch {
  // No old single-file layout; ensure new layout exists
  const defaultJson = boardJsonPath(DATA_DIR, currentBoardId);
  try {
    await fs.access(defaultJson);
  } catch {
    await fs.mkdir(boardDir(DATA_DIR, currentBoardId), { recursive: true });
    await fs.writeFile(defaultJson, JSON.stringify(emptyBoard(), null, 2), 'utf-8');
  }
}

function emptyBoard() {
  const now = new Date().toISOString();
  return {
    id: "board-1",
    title: "My Evidence Board",
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

async function readBoard() {
  try {
    const p = boardJsonPath(DATA_DIR, currentBoardId);
    const raw = await fs.readFile(p, 'utf-8');
    const b = JSON.parse(raw);
    // If the on-disk board has a different id, honor it
    if (b && typeof b.id === 'string' && b.id.trim()) {
      currentBoardId = b.id.trim();
    }
    return b;
  } catch (e) {
    // return an empty board if file missing or malformed (and create it)
    const b = emptyBoard();
    await ensureBoardFiles(b);
    return b;
  }
}

async function ensureBoardFiles(board) {
  const id = (board && typeof board.id === 'string' && board.id.trim()) ? board.id.trim() : 'board-1';
  await fs.mkdir(boardDir(DATA_DIR, id), { recursive: true });
  await fs.mkdir(boardUploadsDir(DATA_DIR, id), { recursive: true });
  const p = boardJsonPath(DATA_DIR, id);
  try { await fs.access(p); } catch { await fs.writeFile(p, JSON.stringify(board, null, 2), 'utf-8'); }
}

async function writeBoard(board) {
  const now = new Date().toISOString();
  const id = (board && typeof board.id === 'string' && board.id.trim()) ? board.id.trim() : 'board-1';
  board.id = id;
  board.updatedAt = now;

  await fs.mkdir(boardDir(DATA_DIR, id), { recursive: true });
  await fs.mkdir(boardUploadsDir(DATA_DIR, id), { recursive: true });

  const p = boardJsonPath(DATA_DIR, id);
  const tmp = p + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(board, null, 2), 'utf-8');
  await fs.rename(tmp, p);

  currentBoardId = id;
  return board;
}

app.get(/^\/uploads\/(.+)$/, async (req, res) => {
  try {
    const relRaw = req.params[0] || '';
    // Normalize and prevent directory traversal
    const rel = path.posix.normalize('/' + relRaw).replace(/^\/+/, '');
    if (rel.includes('..')) return res.status(400).end();

    const base = boardUploadsDir(DATA_DIR, currentBoardId);
    const filePath = path.join(base, rel);
    return res.sendFile(filePath);
  } catch (e) {
    return res.status(404).end();
  }
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/api/board", async (_req, res) => {
  const board = await readBoard();
  res.json(board);
});

app.post("/api/board", async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object") {
      return res.status(400).json({ error: "Invalid board payload" });
    }
    const clean = sanitizeBoard(req.body);
    const saved = await writeBoard(clean);
    res.json(saved);
  } catch (err) {
    console.error("save board error", err);
    res.status(500).json({ error: "Save failed" });
  }
});

app.post("/api/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    if (!/^image\//i.test(req.file.mimetype || "")) {
      return res.status(400).json({ error: "Only image uploads are allowed" });
    }

    const buf = req.file.buffer;
    // Generate a stable name based on content hash + short stamp
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
    const stamp = Date.now().toString(36).slice(-6);
    const safeBase = (req.file.originalname || "upload")
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9-_\.]/g, "_")
      .slice(0, 40) || "img";

    const UP_DIR = boardUploadsDir(DATA_DIR, currentBoardId);
    await fs.mkdir(UP_DIR, { recursive: true });
    const fileName = `${safeBase}-${hash}-${stamp}.webp`;
    const outPath = path.join(UP_DIR, fileName);
    const thumbName = `${safeBase}-${hash}-${stamp}.thumb.webp`;
    const thumbPath = path.join(UP_DIR, thumbName);

    // Transcode to WebP (auto-rotate by EXIF) and make a thumbnail
    const img = sharp(buf).rotate();
    const info = await img
      .webp({ quality: 75 })
      .withMetadata({ exif: undefined, icc: undefined }) // strip metadata
      .toFile(outPath);

    await sharp(buf)
      .rotate()
      .resize({ width: 320, withoutEnlargement: true })
      .webp({ quality: 70 })
      .withMetadata({ exif: undefined, icc: undefined }) // strip metadata
      .toFile(thumbPath);

    return res.json({
      url: "/uploads/" + fileName,
      thumbUrl: "/uploads/" + thumbName,
      width: info.width,
      height: info.height,
      type: "image/webp",
      originalName: req.file.originalname,
    });
  } catch (e) {
    console.error("/api/upload error", e);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// --- Export current board as ZIP (board.json + uploads/)
app.get("/api/board/export", async (req, res) => {
  try {
    const b = await readBoard();
    const base = (b.title || b.id || "board")
      .toString()
      .replace(/[^a-z0-9-_]+/gi, "_");
    const name = `${base}-${b.id || "board"}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => {
      throw err;
    });
    archive.pipe(res);

    // board.json at zip root
    archive.file(boardJsonPath(DATA_DIR, b.id), { name: "board.json" });

    // uploads/ if present
    try {
      await fs.access(boardUploadsDir(DATA_DIR, b.id));
      archive.directory(boardUploadsDir(DATA_DIR, b.id), "uploads");
    } catch {
      /* no uploads yet */
    }

    await archive.finalize();
  } catch (e) {
    console.error("export error", e);
    if (!res.headersSent) res.status(500).json({ error: "Export failed" });
  }
});

// --- Import board from ZIP (expects board.json at root; optional uploads/)
const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post("/api/board/importZip", importUpload.single("bundle"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    // Create a temp workspace
    const tmpDir = path.join(
      DATA_DIR,
      ".import-" + crypto.randomBytes(4).toString("hex")
    );
    await fs.mkdir(tmpDir, { recursive: true });

    const tmpZip = tmpDir + ".zip";
    await fs.writeFile(tmpZip, req.file.buffer);

    // Extract (unzipper enforces extraction under tmpDir)
    await new Promise((resolve, reject) => {
      const s = unzipper.Extract({ path: tmpDir });
      s.on("close", resolve);
      s.on("error", reject);
      import("node:fs").then(({ createReadStream }) =>
        createReadStream(tmpZip).pipe(s)
      );
    });

    // Locate board.json (root or single inner folder)
    async function findBoardJson(root) {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name === "board.json") return path.join(root, e.name);
      }
      const dirs = entries.filter((e) => e.isDirectory());
      if (dirs.length === 1) {
        const inner = path.join(root, dirs[0].name);
        try {
          await fs.access(path.join(inner, "board.json"));
          return path.join(inner, "board.json");
        } catch {}
      }
      return null;
    }

    const bj = await findBoardJson(tmpDir);
    if (!bj) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return res.status(400).json({ error: "board.json not found in zip" });
    }

    // Read + sanitize board.json
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(bj, "utf-8"));
    } catch {
      parsed = null;
    }
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      return res.status(400).json({ error: "Invalid board.json" });
    }

    const clean = sanitizeBoard(parsed);
    const targetId =
      clean.id && typeof clean.id === "string" && clean.id.trim()
        ? clean.id.trim()
        : "board-1";

    // Write board.json into the per-board directory
    const targetDir = boardDir(DATA_DIR, targetId);
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(
      boardJsonPath(DATA_DIR, targetId),
      JSON.stringify(clean, null, 2),
      "utf-8"
    );

    // Copy uploads if present
    async function copyUploads(fromDir) {
      const up = path.join(fromDir, "uploads");
      try {
        await fs.access(up);
      } catch {
        return;
      }
      const dest = boardUploadsDir(DATA_DIR, targetId);
      await fs.mkdir(dest, { recursive: true });
      const files = await fs.readdir(up);
      for (const f of files) {
        const src = path.join(up, f);
        const dst = path.join(dest, f);
        try {
          await fs.copyFile(src, dst);
        } catch {}
      }
    }
    await copyUploads(path.dirname(bj));
    if (path.dirname(bj) !== tmpDir) await copyUploads(tmpDir);

    // Cleanup + switch current board
    await fs.rm(tmpDir, { recursive: true, force: true });
    currentBoardId = targetId;

    const saved = await readBoard();
    res.json(saved);
  } catch (e) {
    console.error("importZip error", e);
    res.status(500).json({ error: "Import failed" });
  }
});

// --- Link preview endpoint ---
// POST /api/link-preview { url: string }
app.post("/api/link-preview", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Missing url" });
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return res.status(400).json({ error: "Invalid URL" });
    }

    // Fetch the page with a simple timeout
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(parsed.toString(), {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "EvidenceBoard/1.0 (+https://local)",
      },
    }).catch((err) => {
      clearTimeout(to);
      throw err;
    });
    clearTimeout(to);

    if (!resp || !resp.ok) {
      return res.status(502).json({
        error: `Upstream error: ${resp ? resp.status : "no-response"}`,
      });
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!/text\/html/i.test(contentType)) {
      return res.json({
        url: parsed.toString(),
        title: parsed.hostname,
        description: "",
        siteName: parsed.hostname,
        image: null,
        icon: new URL("/favicon.ico", parsed).toString(),
      });
    }

    const html = await resp.text();

    // Helpers
    const pick = (re) => {
      const m = html.match(re);
      return m ? (m[1] || m[2] || m[3] || "").toString().trim() : "";
    };
    const abs = (u) => {
      if (!u) return null;
      try {
        return new URL(u, parsed).toString();
      } catch {
        return null;
      }
    };

    // Title
    const ogTitle =
      pick(
        /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i
      ) ||
      pick(
        /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i
      );
    const title =
      ogTitle || pick(/<title[^>]*>([^<]*)<\/title>/i) || parsed.hostname;

    // Description
    const ogDesc =
      pick(
        /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i
      ) ||
      pick(
        /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i
      ) ||
      pick(
        /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i
      );

    // Site name
    const siteName =
      pick(
        /<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i
      ) || parsed.hostname;

    // Image
    const ogImg = pick(
      /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i
    );

    // Icon
    const iconHref =
      pick(
        /<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["'][^>]*>/i
      ) ||
      pick(
        /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/i
      );

    const cleanTitle = String(title || "")
      .replace(/[\\r\\n\\t]+/g, " ")
      .slice(0, 256);
    const cleanDesc = String(ogDesc || "")
      .replace(/<[^>]*>/g, "")
      .replace(/[\\r\\n\\t]+/g, " ")
      .slice(0, 512);
    const cleanSite = String(siteName || "")
      .replace(/[\\r\\n\\t]+/g, " ")
      .slice(0, 128);

    res.json({
      url: parsed.toString(),
      title: cleanTitle,
      description: cleanDesc,
      siteName: cleanSite,
      image: abs(ogImg),
      icon: abs(iconHref) || new URL("/favicon.ico", parsed).toString(),
    });
  } catch (err) {
    console.error("/api/link-preview error", err);
    res.status(500).json({ error: "Preview failed" });
  }
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => {
  console.log(`PaperTrail running at http://localhost:${PORT}`);
});
