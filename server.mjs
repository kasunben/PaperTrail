import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

import archiver from "archiver";
import argon2 from "argon2";
import cookieParser from "cookie-parser";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { engine as hbsEngine } from "express-handlebars";
import multer from "multer";
import fetch from "node-fetch";
import sharp from "sharp";
import unzipper from "unzipper";

import "dotenv/config";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/** $Global Vars */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __templatedir = path.join(__dirname, "public");
const __datadir = path.resolve(process.env.__datadir || path.join(process.cwd(), "data"));

// Fetch appVersion  and schemaVersion (from package.json)
const appVersion = pkg.version;
const schemaVersion = pkg.schemaVersion;

// Ensure data + uploads root exist at startup
await fs.mkdir(__datadir, { recursive: true });
await fs.mkdir(path.join(__datadir, "uploads"), { recursive: true });

// Guest login feature flags
const GUEST_LOGIN_ENABLED = process.env.GUEST_LOGIN_ENABLED === "true";
const GUEST_LOGIN_ENABLED_BYPASS_LOGIN = process.env.GUEST_LOGIN_ENABLED_BYPASS_LOGIN === "true";

/** $DB.Prisma (SQLite/PostgreSQL) */
const prisma = new PrismaClient();

// Handle Prisma connection errors and graceful shutdown
async function connectPrisma() {
  try {
    await prisma.$connect();
    console.log("Connected to the database.");
  } catch (err) {
    console.error("Failed to connect to the database:", err);
    process.exit(1);
  }
}

// Graceful shutdown
async function gracefulShutdown(signal) {
  console.log(`Received ${signal}. Closing database connection...`);
  try {
    await prisma.$disconnect();
    console.log("Database connection closed.");
  } catch (err) {
    console.error("Error during disconnect:", err);
  } finally {
    process.exit(0);
  }
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// > Immediately connect to the database on startup

// Helper to wait for a given number of milliseconds
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isIgnorableFsError(error) {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function logFsWarning(context, error) {
  if (isIgnorableFsError(error)) return;
  console.warn(context, error);
}

async function extractZipToDir(zipPath, destDir) {
  const { createReadStream } = await import("node:fs");

  await new Promise((resolve, reject) => {
    const stream = unzipper.Extract({ path: destDir });
    stream.on("close", resolve);
    stream.on("error", reject);
    createReadStream(zipPath).on("error", reject).pipe(stream);
  });
}

// Retry logic for connecting to Prisma
async function connectPrismaWithRetry(maxRetries = 5, delayMs = 2000) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      await connectPrisma();
      return;
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) {
        console.error(`Failed to connect to the database after ${maxRetries} attempts. Exiting.`);
        process.exit(1);
      }
      console.warn(
        `Database connection failed (attempt ${attempt}/${maxRetries}). Retrying in ${delayMs}ms...`,
        err
      );
      await sleep(delayMs);
    }
  }
}

await connectPrismaWithRetry();
/**  eof::$DB.Prisma -- */

// Guest user helpers (needed for guest login + bypass)
async function createRandomGuestUser() {
  while (true) {
    const suffix = crypto.randomBytes(4).toString("hex");
    const handler = `guest_${suffix}`;
    const email = `guest+${suffix}@guest.local`;
    const existing = await prisma.user.findFirst({
      where: { OR: [{ handler }, { email }] },
      select: { id: true },
    });
    if (existing) continue;
    const passwordHash = await hashPassword(randomToken(12));
    return prisma.user.create({
      data: { handler, email, passwordHash },
    });
  }
}
async function getOrCreateSingletonGuestUser() {
  let user = await prisma.user.findFirst({ where: { handler: "guest" } });
  if (user) return user;
  // Attempt to create singleton; handle race by retry fetch
  try {
    const passwordHash = await hashPassword(randomToken(16));
    user = await prisma.user.create({
      data: {
        handler: "guest",
        email: "guest@guest.local",
        passwordHash,
      },
    });
    return user;
  } catch {
    // Another request likely created it; fetch again
    return prisma.user.findFirst({ where: { handler: "guest" } });
  }
}

/** $Route.Middlewares */
async function requireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = await getSessionWithUser(token);
  if (!session) {
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = { id: session.userId, email: session.user.email };
  req.sessionToken = token;
  next();
}

// HTML-only: redirect to login if not authed
async function htmlRequireAuth(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = await getSessionWithUser(token);
  if (!session) {
    if (GUEST_LOGIN_ENABLED && GUEST_LOGIN_ENABLED_BYPASS_LOGIN) {
      // Auto guest login (singleton)
      const guest = await getOrCreateSingletonGuestUser();
      await createSession(res, guest, req);
      req.user = { id: guest.id, email: guest.email };
      return next();
    }
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    const returnTo = encodeURIComponent(req.originalUrl || "/");
    return res.redirect(302, `/login?return_to=${returnTo}`);
  }
  req.user = { id: session.userId, email: session.user.email };
  req.sessionToken = token;
  next();
}

// HTML-only: block login/register for already authed users
async function disallowIfAuthed(req, res, next) {
  const token = req.cookies?.[SESSION_COOKIE];
  const session = await getSessionWithUser(token);
  if (session) {
    const rt = typeof req.query.return_to === "string" ? req.query.return_to : "";
    const dest = rt && rt.startsWith("/") ? rt : "/";
    return res.redirect(302, dest);
  }
  if (GUEST_LOGIN_ENABLED && GUEST_LOGIN_ENABLED_BYPASS_LOGIN) {
    // Skip login page entirely, auto guest
    const guest = await getOrCreateSingletonGuestUser();
    await createSession(res, guest, req);
    return res.redirect(302, "/");
  }
  next();
}
/** -- eof::$Route.Middlewares -- */

/** $Route.Handlers */
const miscHandler = {
  fetchLinkPreview: async (req, res) => {
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

      // Helpers up-front
      const minimal = (overrides = {}) => ({
        url: parsed.toString(),
        title: parsed.hostname,
        description: "",
        siteName: parsed.hostname,
        image: null,
        icon: new URL("/favicon.ico", parsed).toString(),
        ...overrides,
      });

      // Fetch the page with a strict timeout
      const controller = new AbortController();
      const timeoutMs = 8000;
      const to = setTimeout(() => controller.abort(), timeoutMs);

      let resp;
      try {
        resp = await fetch(parsed.toString(), {
          redirect: "follow",
          signal: controller.signal,
          headers: { "user-agent": "EvidenceBoard/1.0 (+https://local)" },
        });
      } catch (err) {
        clearTimeout(to);
        if (err && (err.name === "AbortError" || err.type === "aborted")) {
          // Upstream took too long – treat as gateway timeout
          return res.status(504).json({ error: "Upstream timeout" });
        }
        // Generic upstream failure (DNS, TLS, network reset, etc.)
        return res.status(502).json({ error: "Upstream fetch failed" });
      } finally {
        clearTimeout(to);
      }

      if (!resp || !resp.ok) {
        return res.status(502).json({
          error: `Upstream error: ${resp ? resp.status : "no-response"}`,
        });
      }

      const contentType = (resp.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html")) {
        return res.json(minimal());
      }

      // Try to read HTML; if it fails (too large/stream error), fall back
      let html = "";
      try {
        html = await resp.text();
      } catch {
        return res.json(minimal());
      }

      // Parsing helpers
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
        pick(
          /<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*href=["']([^"']+)["'][^>]*>/i
        ) ||
        pick(
          /<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]*>/i
        );

      const cleanTitle = String(title || "")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 256);
      const cleanDesc = String(ogDesc || "")
        .replace(/<[^>]*>/g, "")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 512);
      const cleanSite = String(siteName || "")
        .replace(/[\r\n\t]+/g, " ")
        .slice(0, 128);

      return res.json({
        url: parsed.toString(),
        title: cleanTitle,
        description: cleanDesc,
        siteName: cleanSite,
        image: abs(ogImg),
        icon: abs(iconHref) || new URL("/favicon.ico", parsed).toString(),
      });
    } catch (err) {
      // Last-resort safety: never crash the app from this handler
      console.warn("/api/link-preview unexpected error", err?.message || err);
      return res.status(502).json({ error: "Preview failed" });
    }
  },
};

const boardHandler = {
  exportBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });
      const b = await readBoardFromDb(id);
      if (!b) return res.status(404).json({ error: "Board not found" });
      const base = (b.title || b.id || "board").toString().replace(/[^a-z0-9-_]+/gi, "_");
      const name = `${base}-${b.id || "board"}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      // board.json at zip root
      archive.append(JSON.stringify(b, null, 2), { name: "board.json" });

      // uploads/if present
      try {
        await fs.access(boardUploadsDir(__datadir, b.id));
        archive.directory(boardUploadsDir(__datadir, b.id), "uploads");
      } catch (error) {
        logFsWarning("No uploads found for export", error);
      }

      await archive.finalize();
    } catch (e) {
      console.error("export error", e);
      if (!res.headersSent) res.status(500).json({ error: "Export failed" });
    }
  },
  importBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });
      if (!req.file) return res.status(400).json({ error: "No file" });

      // Create a temp workspace
      const tmpDir = path.join(__datadir, ".import-" + crypto.randomBytes(4).toString("hex"));
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpZip = path.join(tmpDir, "bundle.zip");
      await fs.writeFile(tmpZip, req.file.buffer);

      try {
        // Extract (unzipper enforces extraction under tmpDir)
        await extractZipToDir(tmpZip, tmpDir);

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
            } catch (error) {
              logFsWarning("Nested board.json access check failed", error);
            }
          }
          return null;
        }

        const bj = await findBoardJson(tmpDir);
        if (!bj) {
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
          return res.status(400).json({ error: "Invalid board.json" });
        }

        const clean = sanitizeBoard(parsed);
        // Enforce auth only if the incoming board is private
        if (clean.visibility === "private") {
          const token = req.cookies?.[SESSION_COOKIE];
          const session = await getSessionWithUser(token);
          if (!session)
            return res.status(401).json({ error: "Login required for importing private boards" });
          req.user = { id: session.userId, email: session.user.email };
        }
        const targetId = id;

        // Persist into DB
        await writeBoardToDb({ ...clean, id: targetId }, req.user?.id || null);

        // Copy uploads if present
        async function copyUploads(fromDir) {
          const up = path.join(fromDir, "uploads");
          try {
            await fs.access(up);
          } catch (error) {
            logFsWarning("Uploads directory access failed", error);
            return;
          }
          const dest = boardUploadsDir(__datadir, targetId);
          await fs.mkdir(dest, { recursive: true });
          const files = await fs.readdir(up);
          for (const f of files) {
            const src = path.join(up, f);
            const dst = path.join(dest, f);
            try {
              await fs.copyFile(src, dst);
            } catch (error) {
              logFsWarning(`Failed to copy upload from ${src} to ${dst}`, error);
            }
          }
        }
        await copyUploads(path.dirname(bj));
        if (path.dirname(bj) !== tmpDir) await copyUploads(tmpDir);

        const saved = await readBoardFromDb(id);
        return res.json(saved);
      } finally {
        // Always clean temp zip and directory
        try {
          await fs.unlink(tmpZip);
        } catch (error) {
          logFsWarning("Failed to remove temporary zip", error);
        }
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (error) {
          logFsWarning("Failed to remove temporary directory", error);
        }
      }
    } catch (e) {
      console.error("importZip error", e);
      res.status(500).json({ error: "Import failed" });
    }
  },
  validateBoardBeforeImport: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });
      if (!req.file) return res.status(400).json({ error: "No file" });

      const tmpDir = path.join(__datadir, ".probe-" + crypto.randomBytes(4).toString("hex"));
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpZip = path.join(tmpDir, "bundle.zip");
      await fs.writeFile(tmpZip, req.file.buffer);

      try {
        // Extract into tmpDir
        await extractZipToDir(tmpZip, tmpDir);

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
            } catch (error) {
              logFsWarning("Nested board.json access check failed", error);
            }
          }
          return null;
        }

        const bj = await findBoardJson(tmpDir);
        if (!bj) {
          return res.status(400).json({ error: "board.json not found in zip" });
        }

        let parsed;
        try {
          parsed = JSON.parse(await fs.readFile(bj, "utf-8"));
        } catch {
          parsed = null;
        }
        if (!parsed || typeof parsed !== "object") {
          return res.status(400).json({ error: "Invalid board.json" });
        }

        // Detect uploads next to board.json
        let hasUploads = false;
        try {
          const up = path.join(path.dirname(bj), "uploads");
          await fs.access(up);
          const list = await fs.readdir(up);
          hasUploads = list.length > 0;
        } catch (error) {
          logFsWarning("Uploads directory probe failed", error);
        }

        return res.json({
          boardId:
            parsed.id && typeof parsed.id === "string" && parsed.id.trim()
              ? parsed.id.trim()
              : "board-1",
          title: typeof parsed.title === "string" ? parsed.title : "",
          hasUploads,
        });
      } finally {
        // Always clean temp zip and directory
        try {
          await fs.unlink(tmpZip);
        } catch (error) {
          logFsWarning("Failed to remove temporary zip", error);
        }
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch (error) {
          logFsWarning("Failed to remove temporary directory", error);
        }
      }
    } catch (e) {
      console.error("probeZip error", e);
      return res.status(500).json({ error: "Probe failed" });
    }
  },
  uploadImage: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });
      const vis = await getBoardVisibility(id);
      if (vis === "private") {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (!session)
          return res.status(401).json({ error: "Login required for uploads to private boards" });
        req.user = { id: session.userId, email: session.user.email };
      }

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      if (!/^image\//i.test(req.file.mimetype || "")) {
        return res.status(400).json({ error: "Only image uploads are allowed" });
      }

      const buf = req.file.buffer;
      // Generate a stable name based on content hash + short stamp
      const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
      const stamp = Date.now().toString(36).slice(-6);
      const safeBase =
        (req.file.originalname || "upload")
          .replace(/\.[^.]+$/, "")
          .replace(/[^0-9A-Za-z_.-]/g, "_")
          .slice(0, 40) || "img";

      const UP_DIR = boardUploadsDir(__datadir, id);
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
        url: "/uploads/" + id + "/" + fileName,
        thumbUrl: "/uploads/" + id + "/" + thumbName,
        width: info.width,
        height: info.height,
        type: "image/webp",
        originalName: req.file.originalname,
      });
    } catch (e) {
      console.error("/api/upload error", e);
      return res.status(500).json({ error: "Upload failed" });
    }
  },
  createBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid board payload" });
      }
      // If incoming board is private, enforce auth (public boards can be saved without auth)
      if (String(req.body?.visibility || "").toLowerCase() === "private" && !req.user) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (!session) return res.status(401).json({ error: "Login required for private boards" });
        req.user = { id: session.userId, email: session.user.email };
      }
      const clean = sanitizeBoard(req.body, id);
      const saved = await writeBoardToDb(clean, req.user?.id || null);
      return res.json(saved);
    } catch (err) {
      console.error("save board error", err);
      if (err && err.status === 401) {
        return res.status(401).json({ error: err.message || "Unauthorized" });
      }
      return res.status(500).json({ error: "Save failed" });
    }
  },
  getBoardById: async (req, res) => {
    const id = String(req.params.id || "").trim();
    if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });

    try {
      if (!req.user) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (session) req.user = { id: session.userId, email: session.user.email };
      }
    } catch (error) {
      console.warn("Failed to hydrate session before board fetch", error);
    }

    const meta = await prisma.board.findUnique({
      where: { id },
      select: { id: true, userId: true, visibility: true },
    });
    if (!meta) return res.status(404).json({ error: "Board not found" });

    if (meta.visibility === "private" && meta.userId && meta.userId !== req.user?.id) {
      return res.status(404).json({ error: "Board not found" });
    }

    const board = await readBoardFromDb(id);
    if (!board) return res.status(404).json({ error: "Board not found" });
    return res.json(board);
  },
  updateMeta: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });

      if (!req.user) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (session) req.user = { id: session.userId, email: session.user.email };
      }
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const meta = await prisma.board.findUnique({
        where: { id },
        select: { id: true, userId: true, visibility: true, status: true, title: true },
      });
      if (!meta) return res.status(404).json({ error: "Board not found" });
      // Authorization: only the existing owner may update
      if (!meta.userId || meta.userId !== req.user.id) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const { visibility, status, title } = req.body || {};
      let nextVisibility;
      if (typeof visibility === "string") {
        const v = visibility.toLowerCase();
        if (v !== "public" && v !== "private")
          return res.status(400).json({ error: "Bad visibility" });
        nextVisibility = v;
      }
      let nextStatus;
      if (typeof status === "string") {
        const s = status.toLowerCase();
        if (s !== "draft" && s !== "published")
          return res.status(400).json({ error: "Bad status" });
        nextStatus = s;
      }
      let nextTitle;
      if (typeof title === "string") nextTitle = title.trim().slice(0, 256);

      const data = {};
      if (nextVisibility) data.visibility = nextVisibility;
      if (nextStatus) data.status = nextStatus;
      if (typeof nextTitle === "string") data.title = nextTitle || "Untitled Board";
      // Ownership: preserve owner even if board is public so the creator still controls it.
      if (nextVisibility === "private") data.userId = req.user.id;

      if (Object.keys(data).length === 0)
        return res.json({
          ok: true,
          id,
          visibility: meta.visibility,
          status: meta.status,
          title: meta.title,
        });

      const updated = await prisma.board.update({ where: { id }, data });
      return res.json({
        ok: true,
        id,
        visibility: updated.visibility,
        status: updated.status,
        title: updated.title,
      });
    } catch (e) {
      console.error("updateMeta error", e);
      return res.status(500).json({ error: "Update failed" });
    }
  },
  deleteBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id)) return res.status(400).json({ error: "Invalid board id" });

      if (!req.user) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (session) req.user = { id: session.userId, email: session.user.email };
      }
      if (!req.user) return res.status(401).json({ error: "Unauthorized" });

      const meta = await prisma.board.findUnique({
        where: { id },
        select: { id: true, userId: true },
      });
      if (!meta) return res.status(404).json({ error: "Board not found" });
      if (!meta.userId || meta.userId !== req.user.id)
        return res.status(403).json({ error: "Forbidden" });

      const { confirm, confirmId } = req.body || {};
      if (!(confirm === true || confirm === "true" || confirmId === id)) {
        return res.status(400).json({ error: "Confirmation required" });
      }

      await prisma.$transaction(async (tx) => {
        await tx.board.delete({ where: { id } });
      });

      try {
        const dir = boardUploadsDir(__datadir, id);
        await fs.rm(dir, { recursive: true, force: true });
      } catch (err) {
        logFsWarning("Failed to remove uploads dir", err);
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error("deleteBoard error", e);
      return res.status(500).json({ error: "Delete failed" });
    }
  },
};

const fileHandler = {
  serveUpload: async (req, res) => {
    try {
      const relRaw = req.params[0] || "";
      // Normalize and prevent directory traversal
      const rel = path.posix.normalize("/" + relRaw).replace(/^\/+/, "");
      if (rel.includes("..")) return res.status(400).end();

      const uploadsRoot = path.join(__datadir, "uploads");

      let filePath;
      if (!rel.includes("/")) {
        // Require board-scoped path: <boardId>/<filename>
        return res.status(404).end();
      }
      // e.g. rel = "<boardId>/filename.webp"
      filePath = path.join(uploadsRoot, rel);

      return res.sendFile(filePath);
    } catch (error) {
      console.warn("Failed to serve upload", error);
      return res.status(404).end();
    }
  },
};

const uiHandler = {
  viewIndexPage: async (req, res) => {
    try {
      // Only list boards:
      // - owned by current user (userId = req.user.id)
      // - or global boards (userId == null)
      const rows = await prisma.board.findMany({
        where: {
          OR: [{ userId: null }, { userId: req.user?.id || "__none__" }],
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          visibility: true,
          status: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const boards = rows.map((b) => ({
        id: b.id,
        title: b.title,
        visibility: b.visibility,
        status: b.status,
        createdAt:
          b.createdAt instanceof Date
            ? b.createdAt.toISOString()
            : new Date(b.createdAt).toISOString(),
        updatedAt:
          b.updatedAt instanceof Date
            ? b.updatedAt.toISOString()
            : new Date(b.updatedAt).toISOString(),
        owned: !!b.userId && b.userId === req.user?.id,
        global: !b.userId,
        url: `/b/${b.id}`,
      }));

      let handler = "";
      if (req.user) {
        try {
          const u = await prisma.user.findUnique({
            where: { id: req.user.id },
            select: { handler: true },
          });
          if (u) handler = u.handler;
        } catch (error) {
          console.warn("Failed to load user handler", error);
        }
      }
      const showUserMenu = !(GUEST_LOGIN_ENABLED && GUEST_LOGIN_ENABLED_BYPASS_LOGIN);
      return res.render("index", {
        boards,
        handler,
        show_user_menu: showUserMenu,
      });
    } catch (err) {
      return res.status(500).render("error", {
        code: 500,
        message: "Oops!",
        description: "Failed to load boards",
        error: err?.message || String(err),
      });
    }
  },
  viewLoginPage: async (req, res) => {
    if (GUEST_LOGIN_ENABLED && GUEST_LOGIN_ENABLED_BYPASS_LOGIN) {
      return res.redirect(302, "/");
    }
    const justRegistered = String(req.query.registered || "") === "1";
    const justReset = String(req.query.reset || "") === "1";
    const returnTo = typeof req.query.return_to === "string" ? req.query.return_to : "";
    const forgotMode = String(req.query.forgot || "") === "1";
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const resetMode = !!token;
    return res.render("login", {
      success: justRegistered
        ? "Account created. Please sign in."
        : justReset
          ? "Password updated. Please sign in."
          : null,
      return_to: returnTo,
      forgot_mode: forgotMode && !resetMode,
      reset_mode: resetMode,
      token,
      guest_enabled: GUEST_LOGIN_ENABLED && !GUEST_LOGIN_ENABLED_BYPASS_LOGIN,
    });
  },
  viewRegisterPage: async (_, res) => {
    return res.render("register");
  },
  viewBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();

      if (!isValidBoardId(id)) {
        return res.status(404).render("error", {
          code: 404,
          message: "Board not found",
          description: "The board you’re looking for doesn’t exist or may have been moved.",
        });
      }

      const meta = await prisma.board.findUnique({
        where: { id },
        select: { id: true, userId: true, visibility: true, status: true, title: true },
      });
      if (!meta) {
        return res.status(404).render("error", {
          code: 404,
          message: "Board not found",
          description: "The board you’re looking for doesn’t exist or may have been moved.",
        });
      }

      // Private boards: only owner may view
      if (meta.visibility === "private" && meta.userId && meta.userId !== req.user?.id) {
        return res.status(404).render("error", {
          code: 404,
          message: "Board not found",
          description: "The board you’re looking for doesn’t exist or may have been moved.",
        });
      }

      const showUserMenu = !(GUEST_LOGIN_ENABLED && GUEST_LOGIN_ENABLED_BYPASS_LOGIN);
      const isOwner = !!meta.userId && meta.userId === req.user?.id;
      return res.render("board", {
        app_version: appVersion,
        schema_version: schemaVersion,
        board_id: id,
        board_title: meta.title,
        board_visibility: meta.visibility,
        board_status: meta.status,
        show_user_menu: showUserMenu,
        is_owner: isOwner,
        // default status; fetch actual via DB to avoid extra call if needed
        // but we only selected visibility above, so select status too
      });
    } catch (err) {
      console.error("route /b/:id error", err);
      return res.status(500).render("error", {
        code: 500,
        message: "Oops!",
        description: "Something went wrong",
        error: err?.message || String(err),
      });
    }
  },
  createNewBoard: async (req, res) => {
    try {
      const id = uuid("b-");
      const userId = req.user?.id || null;

      await prisma.board.create({
        data: { id, schemaVersion, userId },
        select: { id: true },
      });
      return res.redirect(302, `/b/${id}`);
    } catch (err) {
      console.error("createNewBoard error", err);
      return res.status(500).render("error", {
        code: 500,
        message: "Oops!",
        description: "Failed to create a new board.",
        error: err?.message || String(err),
      });
    }
  },
};

const authHandler = {
  resetPassword: async (req, res) => {
    try {
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      const { token, password, confirm_password } = req.body || {};
      const tkn = typeof token === "string" ? token : "";
      const pwd = typeof password === "string" ? password : "";

      if (!tkn) {
        if (isFormContent) {
          return res.status(400).render("login", {
            error: "Missing or invalid reset token.",
            reset_mode: true,
            token: "",
          });
        }
        return res.status(400).json({ error: "Invalid" });
      }
      if (pwd.length < 6 || !/[A-Za-z]/.test(pwd) || !/\d/.test(pwd)) {
        if (isFormContent) {
          return res.status(400).render("login", {
            error: "Password must be at least 6 characters and include a letter and a number.",
            reset_mode: true,
            token: tkn,
          });
        }
        return res.status(400).json({ error: "Weak password" });
      }
      if (isFormContent && typeof confirm_password === "string" && pwd !== confirm_password) {
        return res.status(400).render("login", {
          error: "Passwords do not match.",
          reset_mode: true,
          token: tkn,
        });
      }

      const t = await prisma.passwordResetToken.findUnique({
        where: { token: tkn },
      });
      if (!t || t.expiresAt < new Date()) {
        if (isFormContent) {
          return res.status(400).render("login", {
            error: "Invalid or expired reset link.",
            reset_mode: false,
            forgot_mode: true,
          });
        }
        return res.status(400).json({ error: "Invalid/expired token" });
      }

      const passwordHash = await hashPassword(pwd);
      await prisma.user.update({
        where: { id: t.userId },
        data: { passwordHash },
      });
      await prisma.passwordResetToken.delete({ where: { token: tkn } });

      if (isFormContent) {
        return res.redirect(302, "/login?reset=1");
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error("/auth/password/reset error", e);
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      if (isFormContent) {
        return res.status(500).render("login", {
          error: "Failed to reset password. Please try again.",
          reset_mode: true,
          token: String(req.body?.token || ""),
        });
      }
      res.status(500).json({ error: "Failed" });
    }
  },
  forgotPassword: async (req, res) => {
    try {
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      const { email } = req.body || {};
      const emailNorm = typeof email === "string" ? email.trim().toLowerCase() : "";

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
        if (isFormContent) {
          return res.status(400).render("login", {
            error: "Please enter a valid email address.",
            forgot_mode: true,
            values: { email: emailNorm },
            return_to: "",
          });
        }
        return res.status(400).json({ error: "Invalid" });
      }

      let devResetUrl = "";
      const user = await prisma.user.findUnique({
        where: { email: emailNorm },
      });
      if (user) {
        const token = randomToken(32);
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            token,
            expiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30m
          },
        });
        // In development, expose the reset link to speed up testing
        if (process.env.NODE_ENV !== "production") {
          devResetUrl = `/login?token=${token}`;
        }
        // TODO: send reset link `${process.env.APP_URL || ""}/login?token=${token}`
      }

      if (isFormContent) {
        return res.status(200).render("login", {
          success: "If that email exists, we've sent a reset link.",
          forgot_mode: true,
          dev_reset_url: devResetUrl,
          values: { email: emailNorm },
          return_to: "",
        });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error("/auth/password/forgot error", e);
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      if (isFormContent) {
        return res.status(500).render("login", {
          error: "Failed to process request.",
          forgot_mode: true,
          values: { email: String(req.body?.email || "").toLowerCase() },
          return_to: "",
        });
      }
      res.status(500).json({ error: "Failed" });
    }
  },
  verifyToken: async (req, res) => {
    try {
      const token = String(req.query.token || "");
      if (!token) return res.status(400).json({ error: "Missing token" });

      const vt = await prisma.verificationToken.findUnique({
        where: { token },
      });
      if (!vt || vt.expiresAt < new Date() || vt.purpose !== "email-verify") {
        return res.status(400).json({ error: "Invalid/expired token" });
      }
      await prisma.user.update({
        where: { id: vt.userId },
        data: { emailVerifiedAt: new Date() },
      });
      await prisma.verificationToken.delete({ where: { token } });
      res.json({ ok: true });
    } catch (e) {
      console.error("/auth/verify error", e);
      res.status(500).json({ error: "Verify failed" });
    }
  },
  getCurrentUser: async (req, res) => {
    return res.json({ user: req.user });
  },
  logout: async (req, res) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (token) {
        try {
          await prisma.session.delete({ where: { token } });
        } catch (error) {
          console.warn("Failed to delete session during logout", error);
        }
        res.clearCookie(SESSION_COOKIE, cookieOpts);
      }
    } catch (error) {
      console.error("Logout handler failed", error);
    }
    return res.redirect(302, "/login");
  },
  login: async (req, res) => {
    try {
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");

      const { email, password, return_to } = req.body || {};
      const emailNorm = typeof email === "string" ? email.trim().toLowerCase() : "";
      const pwd = typeof password === "string" ? password : "";

      // Basic validations
      if (typeof emailNorm !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm) || !pwd) {
        if (isFormContent) {
          return res.status(400).render("login", {
            error: "Please enter a valid email and password.",
            values: { email: emailNorm },
            return_to: typeof return_to === "string" ? return_to : "",
          });
        }
        return res.status(400).json({ error: "Invalid payload" });
      }

      const user = await prisma.user.findUnique({
        where: { email: emailNorm },
      });
      if (!user) {
        if (isFormContent) {
          return res.status(401).render("login", {
            error: "Invalid email or password.",
            values: { email: emailNorm },
            return_to: typeof return_to === "string" ? return_to : "",
          });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const ok = await verifyPassword(user.passwordHash, pwd);
      if (!ok) {
        if (isFormContent) {
          return res.status(401).render("login", {
            error: "Invalid email or password.",
            values: { email: emailNorm },
            return_to: typeof return_to === "string" ? return_to : "",
          });
        }
        return res.status(401).json({ error: "Invalid credentials" });
      }

      await createSession(res, user, req);

      if (isFormContent) {
        const dest = typeof return_to === "string" && return_to.startsWith("/") ? return_to : "/";
        return res.redirect(302, dest);
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error("/auth/login error", e);
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      if (isFormContent) {
        return res.status(500).render("login", {
          error: "Login failed. Please try again.",
          values: { email: String(req.body?.email || "").toLowerCase() },
          return_to: String(req.body?.return_to || ""),
        });
      }
      return res.status(500).json({ error: "Login failed" });
    }
  },
  register: async (req, res) => {
    try {
      // Decide response mode: HTML form vs JSON API
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");

      // Pull fields (form may pass additional fields like confirm_password)
      const { handler, email, password, confirm_password } = req.body || {};

      // Normalize inputs
      const h = typeof handler === "string" ? handler.trim() : "";
      const emailNorm = typeof email === "string" ? email.trim().toLowerCase() : "";

      // Validate handler/username (required)
      // Rules: 3–24 chars, starts with a letter, then letters/numbers/._-
      const handlerOk = typeof h === "string" && /^[A-Za-z][A-Za-z0-9._-]{2,23}$/.test(h || "");
      if (!handlerOk) {
        if (isFormContent) {
          return res.status(400).render("register", {
            error:
              "Choose a username (3–24 chars). Start with a letter; use letters, numbers, dot, underscore or hyphen.",
            values: { handler: h, email: emailNorm },
          });
        }
        return res.status(400).json({ error: "Invalid username", code: "BAD_HANDLER" });
      }

      // Validate email
      if (typeof emailNorm !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailNorm)) {
        if (isFormContent) {
          return res.status(400).render("register", {
            error: "Please enter a valid email address.",
            values: { handler: h, email: emailNorm },
          });
        }
        return res.status(400).json({ error: "Invalid email" });
      }

      // Validate password: length ≥ 6 AND contains at least one letter and one number
      const passStr = typeof password === "string" ? password : "";
      if (passStr.length < 6 || !/[A-Za-z]/.test(passStr) || !/\d/.test(passStr)) {
        if (isFormContent) {
          return res.status(400).render("register", {
            error: "Password must be at least 6 characters and include a letter and a number.",
            values: { handler: h, email: emailNorm },
          });
        }
        return res.status(400).json({ error: "Password too weak" });
      }

      // Confirm password (only checked for form flow; API clients can omit)
      if (isFormContent && typeof confirm_password === "string" && passStr !== confirm_password) {
        return res.status(400).render("register", {
          error: "Passwords do not match.",
          values: { handler: h, email: emailNorm },
        });
      }

      // Uniqueness checks
      const [existingEmail, existingHandler] = await Promise.all([
        prisma.user.findUnique({ where: { email: emailNorm } }).catch(() => null),
        prisma.user.findFirst({ where: { handler: h } }).catch(() => null),
      ]);
      if (existingHandler) {
        if (isFormContent) {
          return res.status(409).render("register", {
            error: "That username is taken. Please choose another.",
            values: { handler: h, email: emailNorm },
          });
        }
        return res.status(409).json({ error: "Username already registered" });
      }
      if (existingEmail) {
        if (isFormContent) {
          return res.status(409).render("register", {
            error: "That email is already registered.",
            values: { handler: h, email: emailNorm },
          });
        }
        return res.status(409).json({ error: "Email already registered" });
      }

      const passwordHash = await hashPassword(passStr);
      const user = await prisma.user.create({
        data: { handler: h, email: emailNorm, passwordHash },
        select: { id: true },
      });

      // Optional: email verification token (kept consistent with existing API)
      const token = randomToken(32);
      await prisma.verificationToken.create({
        data: {
          userId: user.id,
          token,
          purpose: "email-verify",
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h
        },
      });

      if (isFormContent) {
        // HTML form flow → redirect to login with banner
        return res.redirect(302, "/login?registered=1");
      }
      // JSON API flow
      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error("/auth/register error", e);
      const accept = String(req.headers["accept"] || "");
      const isFormContent =
        req.is("application/x-www-form-urlencoded") || accept.includes("text/html");
      if (isFormContent) {
        return res.status(500).render("register", {
          error: "Registration failed. Please try again.",
          values: {
            handler: String(req.body?.handler || ""),
            email: String(req.body?.email || "").toLowerCase(),
          },
        });
      }
      return res.status(500).json({ error: "Register failed" });
    }
  },
  guestLogin: async (req, res) => {
    if (!(GUEST_LOGIN_ENABLED && !GUEST_LOGIN_ENABLED_BYPASS_LOGIN)) {
      return res.status(404).json({ error: "Disabled" });
    }
    try {
      const guest = await createRandomGuestUser();
      await createSession(res, guest, req);
      return res.redirect(302, "/");
    } catch (e) {
      console.error("guestLogin error", e);
      return res.status(500).json({ error: "Guest login failed" });
    }
  },
};
/** -- eof::$Route.Handlers -- */

/** $Utils */
// $Utils.Sanitizers
function sanitizeBoard(incoming, fallbackId) {
  const out = {
    id: ensureBoardId(incoming.id, fallbackId),
    title: typeof incoming.title === "string" ? incoming.title.slice(0, 256) : "Untitled",
    visibility:
      typeof incoming.visibility === "string" && incoming.visibility.toLowerCase() === "private"
        ? "private"
        : "public",
    createdAt: incoming.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
    edges: [],
  };
  const nodes = Array.isArray(incoming.nodes) ? incoming.nodes.slice(0, 5000) : [];
  out.nodes = nodes.map(sanitizeNode);
  const edges = Array.isArray(incoming.edges) ? incoming.edges.slice(0, 20000) : [];
  for (let i = 0; i < edges.length; i++) {
    const e = sanitizeEdge(edges[i], i);
    if (!e) continue;
    if (!out.nodes.find((n) => n.id === e.sourceId)) continue;
    if (!out.nodes.find((n) => n.id === e.targetId)) continue;
    out.edges.push(e);
  }
  out.schemaVersion = schemaVersion;
  return out;
}
function sanitizeEdge(edge, i = 0) {
  const e = {
    id: typeof edge.id === "string" ? edge.id : `e-${i}`,
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
function sanitizeNode(node, i = 0) {
  const n = {
    id: typeof node.id === "string" ? node.id : `n-${i}`,
    type: ["text", "image", "link", "imageText"].includes(node.type) ? node.type : "text",
    x: Number.isFinite(node.x) ? node.x : 100 + i * 20,
    y: Number.isFinite(node.y) ? node.y : 100 + i * 20,
    w: Number.isFinite(node.w) ? node.w : undefined,
    h: Number.isFinite(node.h) ? node.h : undefined,
    data: typeof node.data === "object" && node.data ? { ...node.data } : {},
  };
  const d = n.data;
  if (typeof d.title === "string") d.title = d.title.slice(0, 512);
  if (typeof d.text === "string") d.text = d.text.slice(0, 8000);
  if (typeof d.html === "string") {
    d.html = stripDangerousHtml(d.html.slice(0, 8000));
  }
  if (typeof d.descHtml === "string") {
    d.descHtml = stripDangerousHtml(d.descHtml.slice(0, 8000));
  }
  if (typeof d.linkUrl === "string") d.linkUrl = sanitizeUrl(d.linkUrl);
  if (typeof d.imageUrl === "string") d.imageUrl = sanitizeUrl(d.imageUrl);
  d.tags = normalizeTags(d.tags);
  return n;
}
function stripDangerousHtml(html) {
  if (!html || typeof html !== "string") return "";
  // remove dangerous elements
  let out = html
    .replace(/<\/(script|style|iframe|object|embed|link|meta)[^>]*>/gi, "")
    .replace(/<(script|style|iframe|object|embed|link|meta)[^>]*>/gi, "");
  // remove event handlers + inline styles
  out = out
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
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

// $Utils.Ids
function uuid(prefix = "", salt = "") {
  // Target: total length ≤ 32, allowed chars [A-Za-z0-9_-]
  const maxTotal = 32;
  const ts = Date.now().toString(36); // ~8–9 chars
  const rand = crypto.randomBytes(4).toString("base64url"); // 6 chars, url-safe

  // Optional short digest from salt to add entropy while keeping it compact
  const extra = salt
    ? crypto
        .createHash("sha1")
        .update(salt + ts + rand)
        .digest("base64url")
        .slice(0, 6)
    : "";

  // Build core and ensure only allowed characters, then clamp to budget
  const maxCore = Math.max(3, maxTotal - String(prefix).length);
  const core = `${ts}${rand}${extra}`.replace(/[^A-Za-z0-9_-]/g, "").slice(0, maxCore);

  return `${prefix}${core}`.trim();
}

function isValidBoardId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(v);
}
function ensureBoardId(candidate, fallbackCurrent) {
  if (isValidBoardId(candidate)) return candidate;
  if (isValidBoardId(fallbackCurrent)) return fallbackCurrent;
  return uuid("b-");
}

// Per-board storage helpers
function boardUploadsDir(root, id) {
  return path.join(root, "uploads", id);
}

// Visibility helper ---
async function getBoardVisibility(id) {
  const b = await prisma.board.findUnique({
    where: { id },
    select: { visibility: true },
  });
  if (!b) return "public";
  return (b.visibility || "public").toString().toLowerCase();
}

// $Utils.DB
async function readBoardFromDb(boardId) {
  const b = await prisma.board.findUnique({
    where: { id: boardId },
    include: {
      nodes: { include: { tags: { include: { tag: true } } } },
      edges: true,
    },
  });
  if (!b) return null;
  return {
    schemaVersion: b.schemaVersion ?? schemaVersion,
    id: b.id,
    visibility: (b.visibility || "public").toString().toLowerCase(),
    title: b.title,
    createdAt: (b.createdAt instanceof Date ? b.createdAt : new Date(b.createdAt)).toISOString(),
    updatedAt: (b.updatedAt instanceof Date ? b.updatedAt : new Date(b.updatedAt)).toISOString(),
    nodes: b.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      x: n.x,
      y: n.y,
      w: n.w ?? undefined,
      h: n.h ?? undefined,
      data: {
        title: n.title ?? undefined,
        text: n.text ?? undefined,
        html: n.html ?? undefined,
        descHtml: n.descHtml ?? undefined,
        linkUrl: n.linkUrl ?? undefined,
        imageUrl: n.imageUrl ?? undefined,
        tags: n.tags.map((t) => t.tag.name),
      },
    })),
    edges: b.edges.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? undefined,
      dashed: e.dashed || undefined,
      color: e.color ?? undefined,
    })),
  };
}
async function writeBoardToDb(cleanBoard, ownerUserId = null) {
  const { id, title, nodes, edges } = cleanBoard;
  await prisma.$transaction(async (tx) => {
    await tx.board.upsert({
      where: { id },
      create: {
        id,
        title,
        schemaVersion,
        visibility: cleanBoard.visibility === "private" ? "private" : "public",
        // On create, if there is an authenticated user, record ownership regardless of visibility.
        userId: ownerUserId ?? null,
      },
      update: {
        title,
        schemaVersion,
        visibility: cleanBoard.visibility === "private" ? "private" : "public",
        // Preserve existing owner when toggling to public.
        // Only set owner when switching to private and caller provided an ownerUserId.
        ...(cleanBoard.visibility === "private" && ownerUserId ? { userId: ownerUserId } : {}),
      },
    });

    await Promise.all([
      tx.nodeTag.deleteMany({ where: { node: { boardId: id } } }),
      tx.node.deleteMany({ where: { boardId: id } }),
      tx.edge.deleteMany({ where: { boardId: id } }),
    ]);

    for (const n of nodes) {
      await tx.node.create({
        data: {
          id: n.id,
          boardId: id,
          type: n.type,
          x: Math.trunc(n.x),
          y: Math.trunc(n.y),
          w: Number.isFinite(n.w) ? Math.trunc(n.w) : null,
          h: Number.isFinite(n.h) ? Math.trunc(n.h) : null,
          title: n.data?.title ?? null,
          text: n.data?.text ?? null,
          html: n.data?.html ?? null,
          descHtml: n.data?.descHtml ?? null,
          linkUrl: n.data?.linkUrl ?? null,
          imageUrl: n.data?.imageUrl ?? null,
        },
      });

      const tags = Array.isArray(n.data?.tags) ? n.data.tags : [];
      for (const raw of tags) {
        const name = String(raw).trim().replace(/^#+/, "").toLowerCase();
        if (!name) continue;
        const tag = await tx.tag.upsert({
          where: { name },
          create: { id: uuid("tag_"), name },
          update: {},
        });
        await tx.nodeTag.create({ data: { nodeId: n.id, tagId: tag.id } });
      }
    }

    for (const e of edges) {
      await tx.edge.create({
        data: {
          id: e.id,
          boardId: id,
          sourceId: e.sourceId,
          targetId: e.targetId,
          label: e.label ?? null,
          dashed: !!e.dashed,
          color: e.color ?? null,
        },
      });
    }
  });

  return readBoardFromDb(id);
}

// $Utils.Auth
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME || "pt_session";
const sessionTtlMs = 1000 * 60 * 60 * Number(process.env.SESSION_TTL_HOURS ?? 720); // 30 days default
const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production", // HTTPS in prod
  sameSite: "lax",
  path: "/",
  maxAge: sessionTtlMs,
};

async function hashPassword(pwd) {
  return argon2.hash(pwd, {
    type: argon2.argon2id,
    memoryCost: Number(process.env.ARGON2_MEMORY ?? 19456),
    timeCost: Number(process.env.ARGON2_ITERATIONS ?? 2),
    parallelism: Number(process.env.ARGON2_PARALLELISM ?? 1),
  });
}
function verifyPassword(hash, pwd) {
  return argon2.verify(hash, pwd);
}
function randomToken(bytes = 48) {
  return crypto.randomBytes(bytes).toString("hex");
}
function hashIp(ip) {
  return crypto
    .createHash("sha256")
    .update(ip ?? "")
    .digest("hex");
}
async function createSession(res, user, req) {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + sessionTtlMs);
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      userAgent: req.get("user-agent") || undefined,
      ipHash: hashIp(req.ip),
      expiresAt,
    },
  });
  res.cookie(SESSION_COOKIE, token, { ...cookieOpts, expires: expiresAt });
}
async function getSessionWithUser(token) {
  if (!token) return null;
  const s = await prisma.session.findUnique({
    where: { token },
    include: { user: true },
  });
  if (!s || s.expiresAt < new Date()) {
    if (s) {
      try {
        await prisma.session.delete({ where: { token } });
      } catch (error) {
        console.warn("Failed to delete expired session", error);
      }
    }
    return null;
  }
  return s;
}

/** $Utils::eof -- */

// Bootstrap the app ---
const app = express();

// Template engine: Handlebars using .html files under /public
app.engine(
  "html",
  hbsEngine({
    extname: ".html",
    defaultLayout: false,
    // You can enable these later if you add folders:
    // partialsDir: path.join(__dirname, "public", "partials"),
    // layoutsDir: path.join(__dirname, "public", "layouts"),
  })
);
app.set("view engine", "html");
app.set("views", __templatedir);

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
      "frame-ancestors 'self'",
    ].join("; ")
  );
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Block direct access to template files under /public (e.g., *.html, *.hbs)
app.use((req, res, next) => {
  if (/\.(html|hbs|handlebars)$/i.test(req.path)) {
    return res.status(404).render("error", {
      code: 404,
      message: "Page not found",
      description: "The page you’re looking for doesn’t exist or may have been moved.",
    });
  }
  next();
});
// Serve static assets (CSS/JS/images/fonts, etc.) without directory index
app.use(express.static(__templatedir, { index: false }));

app.get(/^\/uploads\/(.+)$/, fileHandler.serveUpload);

// $Routes.Views
app.get("/", htmlRequireAuth, uiHandler.viewIndexPage);
app.get("/login", disallowIfAuthed, uiHandler.viewLoginPage);
app.get("/register", disallowIfAuthed, uiHandler.viewRegisterPage);
app.get("/logout", authHandler.logout);
app.get("/b/create-new", htmlRequireAuth, uiHandler.createNewBoard);
app.get("/b/:id", htmlRequireAuth, uiHandler.viewBoard);

// $Routes.Auth
app.post("/auth/register", authHandler.register);
app.post("/auth/login", authHandler.login);
app.get("/auth/guest", authHandler.guestLogin);
app.post("/auth/logout", authHandler.logout);
app.get("/auth/me", requireAuth, authHandler.getCurrentUser);
app.get("/auth/verify", authHandler.verifyToken); // Request /?token=...
app.post("/auth/password/forgot", authHandler.forgotPassword); // Request Body { email }
app.post("/auth/password/reset", authHandler.resetPassword); // Request Body { token, password }

// $Routes.Board (API)
app.get("/api/board/:id", boardHandler.getBoardById);
app.post("/api/board/:id", boardHandler.createBoard);
app.patch("/api/board/:id/meta", requireAuth, boardHandler.updateMeta);
app.delete("/api/board/:id", requireAuth, boardHandler.deleteBoard);

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
app.post("/api/board/:id/upload-image", uploadImage.single("image"), boardHandler.uploadImage);

// Shared Multer config for board bundle uploads (probe & import)
const bundleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});
app.post(
  "/api/board/:id/validate-import",
  bundleUpload.single("bundle"),
  boardHandler.validateBoardBeforeImport
);
app.post("/api/board/:id/import", bundleUpload.single("bundle"), boardHandler.importBoard);

app.get("/api/board/:id/export", boardHandler.exportBoard);

// $Routes.Misc (API)
app.post("/api/link-preview", miscHandler.fetchLinkPreview);

// 404 handler for unknown routes
app.use((_, res) => {
  return res.status(404).render("error", {
    code: 404,
    message: "Page not found",
    description: "The page you’re looking for doesn’t exist or may have been moved.",
  });
});

// Centralized error handler (last)
app.use((err, _, res) => {
  return res.status(500).render("error", {
    code: 500,
    message: "Oops!",
    description: "Something went wrong",
    error: err?.message || String(err),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PaperTrail running at http://localhost:${PORT}`);
});
