import express from "express";
import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import multer from "multer";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
const BOARD_PATH = path.join(DATA_DIR, "board.json");

// ensure data dir exists
await fs.mkdir(DATA_DIR, { recursive: true });

function emptyBoard() {
  const now = new Date().toISOString();
  return {
    id: "board-1",
    title: "My Evidence Board",
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now
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
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
await fs.mkdir(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_\\.]/g, "_");
    const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    cb(null, `${base}-${stamp}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// API
app.get("/api/board", async (_req, res) => {
  const board = await readBoard();
  res.json(board);
});

app.post("/api/board", async (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== "object") {
    return res.status(400).json({ error: "Invalid board payload" });
  }
  // extremely light validation
  incoming.id = "board-1";
  if (!Array.isArray(incoming.nodes) || !Array.isArray(incoming.edges)) {
    return res.status(400).json({ error: "nodes and edges must be arrays" });
  }
  const saved = await writeBoard(incoming);
  res.json(saved);
});

app.post("/api/upload", upload.single("image"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  res.json({
    url: "/uploads/" + req.file.filename,
    name: req.file.originalname,
    size: req.file.size,
    type: req.file.mimetype
  });
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
        "user-agent": "EvidenceBoard/1.0 (+https://local)"
      }
    }).catch(err => {
      clearTimeout(to);
      throw err;
    });
    clearTimeout(to);

    if (!resp || !resp.ok) {
      return res.status(502).json({ error: `Upstream error: ${resp ? resp.status : 'no-response'}` });
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!/text\/html/i.test(contentType)) {
      return res.json({
        url: parsed.toString(),
        title: parsed.hostname,
        description: "",
        siteName: parsed.hostname,
        image: null,
        icon: new URL("/favicon.ico", parsed).toString()
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
      try { return new URL(u, parsed).toString(); } catch { return null; }
    };

    // Title
    const ogTitle =
      pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      pick(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["'][^>]*>/i);
    const title = ogTitle || pick(/<title[^>]*>([^<]*)<\/title>/i) || parsed.hostname;

    // Description
    const ogDesc =
      pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      pick(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["'][^>]*>/i);

    // Site name
    const siteName =
      pick(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["'][^>]*>/i) ||
      parsed.hostname;

    // Image
    const ogImg = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);

    // Icon
    const iconHref =
      pick(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["'][^>]*>/i) ||
      pick(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/i);

    res.json({
      url: parsed.toString(),
      title,
      description: ogDesc || "",
      siteName,
      image: abs(ogImg),
      icon: abs(iconHref) || new URL("/favicon.ico", parsed).toString()
    });
  } catch (err) {
    console.error("/api/link-preview error", err);
    res.status(500).json({ error: "Preview failed" });
  }
});

const PORT = process.env.PORT || 5173;
app.listen(PORT, () => {
  console.log(`Evidence Board running at http://localhost:${PORT}`);
});