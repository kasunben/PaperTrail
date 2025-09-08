import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import fetch from "node-fetch";
import sharp from "sharp";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const BOARD_PATH = path.join(DATA_DIR, "board.json");

// ensure data dir exists
await fs.mkdir(DATA_DIR, { recursive: true });

// create default board.json if missing
try {
  await fs.access(BOARD_PATH);
} catch {
  await fs.writeFile(
    BOARD_PATH,
    JSON.stringify(emptyBoard(), null, 2),
    "utf-8"
  );
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
    const raw = await fs.readFile(BOARD_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (e) {
    // return an empty board if file missing or malformed
    return emptyBoard();
  }
}

async function writeBoard(board) {
  const now = new Date().toISOString();
  board.updatedAt = now;

  const tmp = BOARD_PATH + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(board, null, 2), "utf-8");
  await fs.rename(tmp, BOARD_PATH);
  return board;
}

// Image Uploads
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

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

    const fileName = `${safeBase}-${hash}-${stamp}.webp`;
    const outPath = path.join(UPLOAD_DIR, fileName);
    const thumbName = `${safeBase}-${hash}-${stamp}.thumb.webp`;
    const thumbPath = path.join(UPLOAD_DIR, thumbName);

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
