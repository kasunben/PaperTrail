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
import { PrismaClient } from "@prisma/client";
import cookieParser from "cookie-parser";
import argon2 from "argon2";
import { engine as hbsEngine } from "express-handlebars";

import "dotenv/config";
import { stat } from "node:fs";

/** $Global Vars */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const __templatedir = path.join(__dirname, "public");

// > Read app/schema versions from package.json once at startup
let appVersion = "0.0.0";
let schemaVersion = 1;
try {
  const pkgRaw = await fs.readFile(
    path.join(__dirname, "package.json"),
    "utf-8"
  );
  const pkg = JSON.parse(pkgRaw);
  if (pkg && typeof pkg.version === "string") appVersion = pkg.version;
  if (pkg && typeof pkg.schemaVersion === "number")
    schemaVersion = pkg.schemaVersion;
} catch {}

// > Create data directory at startup if missing
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
await fs.mkdir(DATA_DIR, { recursive: true });
/** eof::$Global Vars -- */

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
await connectPrisma();
/**  eof::$DB.Prisma -- */

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
/** -- eof::$Route.Middlewares -- */

/** $Route.Handlers */
const miscHandler = {
  getVersion: async (_, res) => {
    return res.json({ version: appVersion, schemaVersion });
  },
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

      const contentType = (
        resp.headers.get("content-type") || ""
      ).toLowerCase();
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
      if (!isValidBoardId(id))
        return res.status(400).json({ error: "Invalid board id" });
      const b = await readBoardFromDb(id);
      if (!b) return res.status(404).json({ error: "Board not found" });
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
      archive.append(JSON.stringify(b, null, 2), { name: "board.json" });

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
  },
  importBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id))
        return res.status(400).json({ error: "Invalid board id" });
      if (!req.file) return res.status(400).json({ error: "No file" });

      // Create a temp workspace
      const tmpDir = path.join(
        DATA_DIR,
        ".import-" + crypto.randomBytes(4).toString("hex")
      );
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpZip = path.join(tmpDir, "bundle.zip");
      await fs.writeFile(tmpZip, req.file.buffer);

      try {
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
            if (e.isFile() && e.name === "board.json")
              return path.join(root, e.name);
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
          return res.status(400).json({ error: "board.json not found in zip" });
        }

        // Read + sanitize board.json
        let parsed;
        try {
          parsed = JSON.parse(await fs.readFile(bj, "utf-8"));
        } catch {
          parsed = null;
        }
        if (
          !parsed ||
          !Array.isArray(parsed.nodes) ||
          !Array.isArray(parsed.edges)
        ) {
          return res.status(400).json({ error: "Invalid board.json" });
        }

        const clean = sanitizeBoard(parsed);
        // Enforce auth only if the incoming board is private
        if (clean.visibility === "private") {
          const token = req.cookies?.[SESSION_COOKIE];
          const session = await getSessionWithUser(token);
          if (!session)
            return res
              .status(401)
              .json({ error: "Login required for importing private boards" });
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

        const saved = await readBoardFromDb(id);
        return res.json(saved);
      } finally {
        // Always clean temp zip and directory
        try {
          await fs.unlink(tmpZip);
        } catch {}
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    } catch (e) {
      console.error("importZip error", e);
      res.status(500).json({ error: "Import failed" });
    }
  },
  validateBoardBeforeImport: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id))
        return res.status(400).json({ error: "Invalid board id" });
      if (!req.file) return res.status(400).json({ error: "No file" });

      const tmpDir = path.join(
        DATA_DIR,
        ".probe-" + crypto.randomBytes(4).toString("hex")
      );
      await fs.mkdir(tmpDir, { recursive: true });
      const tmpZip = path.join(tmpDir, "bundle.zip");
      await fs.writeFile(tmpZip, req.file.buffer);

      try {
        // Extract into tmpDir
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
            if (e.isFile() && e.name === "board.json")
              return path.join(root, e.name);
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
        } catch {}

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
        } catch {}
        try {
          await fs.rm(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    } catch (e) {
      console.error("probeZip error", e);
      return res.status(500).json({ error: "Probe failed" });
    }
  },
  uploadImage: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      if (!isValidBoardId(id))
        return res.status(400).json({ error: "Invalid board id" });
      const vis = await getBoardVisibility(id);
      if (vis === "private") {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (!session)
          return res
            .status(401)
            .json({ error: "Login required for uploads to private boards" });
        req.user = { id: session.userId, email: session.user.email };
      }

      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      if (!/^image\//i.test(req.file.mimetype || "")) {
        return res
          .status(400)
          .json({ error: "Only image uploads are allowed" });
      }

      const buf = req.file.buffer;
      // Generate a stable name based on content hash + short stamp
      const hash = crypto
        .createHash("sha1")
        .update(buf)
        .digest("hex")
        .slice(0, 12);
      const stamp = Date.now().toString(36).slice(-6);
      const safeBase =
        (req.file.originalname || "upload")
          .replace(/\.[^.]+$/, "")
          .replace(/[^a-zA-Z0-9-_\.]/g, "_")
          .slice(0, 40) || "img";

      const UP_DIR = boardUploadsDir(DATA_DIR, id);
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
      if (!isValidBoardId(id))
        return res.status(400).json({ error: "Invalid board id" });
      if (!req.body || typeof req.body !== "object") {
        return res.status(400).json({ error: "Invalid board payload" });
      }
      // If incoming board is private, enforce auth (public boards can be saved without auth)
      if (
        String(req.body?.visibility || "").toLowerCase() === "private" &&
        !req.user
      ) {
        const token = req.cookies?.[SESSION_COOKIE];
        const session = await getSessionWithUser(token);
        if (!session)
          return res
            .status(401)
            .json({ error: "Login required for private boards" });
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
    if (!isValidBoardId(id))
      return res.status(400).json({ error: "Invalid board id" });
    const board = await readBoardFromDb(id);
    if (!board) return res.status(404).json({ error: "Board not found" });
    return res.json(board);
  },
};

const fileHandler = {
  serveUpload: async (req, res) => {
    try {
      const relRaw = req.params[0] || "";
      // Normalize and prevent directory traversal
      const rel = path.posix.normalize("/" + relRaw).replace(/^\/+/, "");
      if (rel.includes("..")) return res.status(400).end();

      const uploadsRoot = path.join(DATA_DIR, "uploads");

      let filePath;
      if (!rel.includes("/")) {
        // Require board-scoped path: <boardId>/<filename>
        return res.status(404).end();
      }
      // e.g. rel = "<boardId>/filename.webp"
      filePath = path.join(uploadsRoot, rel);

      return res.sendFile(filePath);
    } catch (e) {
      return res.status(404).end();
    }
  },
};

const uiHandler = {
  viewIndexPage: async (_, res) => {
    try {
      const rows = await prisma.board.findMany({
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          visibility: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const boards = rows.map((b) => ({
        id: b.id,
        title: b.title || "Untitled",
        visibility: (b.visibility || "public").toLowerCase(),
        status: "draft", // TODO: placeholder for now, implement this later
        createdAt:
          b.createdAt instanceof Date
            ? b.createdAt.toISOString()
            : new Date(b.createdAt).toISOString(), // TODO: convert to human-friendly format
        updatedAt:
          b.updatedAt instanceof Date
            ? b.updatedAt.toISOString()
            : new Date(b.updatedAt).toISOString(),
        url: `/b/${b.id}`,
      }));

      return res.render("index", { boards });
    } catch (err) {
      console.error("viewIndexPage error", err);
      return res.status(500).render("error", {
        code: 500,
        message: "Oops!",
        description: "Failed to load boards",
        error: err?.message || String(err),
      });
    }
  },
  viewLoginPage: async (_, res) => {
    return res.render("login");
  },
  viewRegisterPage: async (_, res) => {
    return res.render("register");
  },
  viewBoard: async (req, res) => {
    try {
      const id = String(req.params.id || "").trim();

      // basic id sanity check
      if (!isValidBoardId(id)) {
        return res.status(404).render("error", {
          code: 404,
          message: "Board not found",
          description:
            "The board you’re looking for doesn’t exist or may have been moved.",
        });
      }

      const exists = await prisma.board.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        return res.status(404).render("error", {
          code: 404,
          message: "Board not found",
          description:
            "The board you’re looking for doesn’t exist or may have been moved.",
        });
      }
      // Serve the SPA shell (renamed from index.html to board.html)
      return res.render("board");
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
  createNewBoard: async (_, res) => {
    try {
      const board = sanitizeBoard({ nodes: [], edges: [] });
      await writeBoardToDb(board, board.id);

      // Redirect user to the new board
      return res.redirect(302, `/b/${board.id}`);
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
      const { token, password } = req.body || {};
      if (
        typeof token !== "string" ||
        typeof password !== "string" ||
        password.length < 10
      ) {
        return res.status(400).json({ error: "Invalid" });
      }
      const t = await prisma.passwordResetToken.findUnique({
        where: { token },
      });
      if (!t || t.expiresAt < new Date()) {
        return res.status(400).json({ error: "Invalid/expired token" });
      }

      const passwordHash = await hashPassword(password);
      await prisma.user.update({
        where: { id: t.userId },
        data: { passwordHash },
      });
      await prisma.passwordResetToken.delete({ where: { token } });
      res.json({ ok: true });
    } catch (e) {
      console.error("/auth/password/reset error", e);
      res.status(500).json({ error: "Failed" });
    }
  },
  forgotPassword: async (req, res) => {
    try {
      const { email } = req.body || {};
      if (typeof email !== "string")
        return res.status(400).json({ error: "Invalid" });

      const user = await prisma.user.findUnique({ where: { email } });
      if (user) {
        const token = randomToken(32);
        await prisma.passwordResetToken.create({
          data: {
            userId: user.id,
            token,
            expiresAt: new Date(Date.now() + 1000 * 60 * 30), // 30m
          },
        });
        // send reset link `${process.env.APP_URL || ""}/reset?token=${token}`
      }
      res.json({ ok: true }); // don't reveal if email exists
    } catch (e) {
      console.error("/auth/password/forgot error", e);
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
        } catch {}
        res.clearCookie(SESSION_COOKIE, cookieOpts);
      }
      return res.json({ ok: true });
    } catch {
      return res.json({ ok: true });
    }
  },
  login: async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (typeof email !== "string" || typeof password !== "string") {
        return res.status(400).json({ error: "Invalid payload" });
      }
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) return res.status(401).json({ error: "Invalid credentials" });

      const ok = await verifyPassword(user.passwordHash, password);
      if (!ok) return res.status(401).json({ error: "Invalid credentials" });

      await createSession(res, user, req);
      res.json({ ok: true });
    } catch (e) {
      console.error("/auth/login error", e);
      res.status(500).json({ error: "Login failed" });
    }
  },
  register: async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (
        typeof email !== "string" ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
      ) {
        return res.status(400).json({ error: "Invalid email" });
      }
      if (typeof password !== "string" || password.length < 10) {
        return res.status(400).json({ error: "Password too short" });
      }
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing)
        return res.status(409).json({ error: "Email already registered" });

      const passwordHash = await hashPassword(password);
      const user = await prisma.user.create({ data: { email, passwordHash } });

      // Optional: email verification
      const token = randomToken(32);
      await prisma.verificationToken.create({
        data: {
          userId: user.id,
          token,
          purpose: "email-verify",
          expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24), // 24h
        },
      });
      // send verification email with `${process.env.APP_URL || ""}/verify?token=${token}`

      return res.status(201).json({ ok: true });
    } catch (e) {
      console.error("/auth/register error", e);
      return res.status(500).json({ error: "Register failed" });
    }
  },
};
/** -- eof::$Route.Handlers -- */

/** $Utils */
// $Utils.Sanitizers
function sanitizeBoard(incoming, fallbackId) {
  const out = {
    id: ensureBoardId(incoming.id, fallbackId),
    title:
      typeof incoming.title === "string"
        ? incoming.title.slice(0, 256)
        : "My Evidence Board",
    visibility:
      typeof incoming.visibility === "string" &&
      incoming.visibility.toLowerCase() === "private"
        ? "private"
        : "public",
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
  out.schemaVersion = schemaVersion;
  return out;
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
function genShortId(prefix = "b_") {
  // ~8-char URL-safe id
  const raw = crypto.randomBytes(6).toString("base64url");
  const id = raw.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8);
  return prefix + id;
}
function isValidBoardId(v) {
  return typeof v === "string" && /^[A-Za-z0-9_-]{3,32}$/.test(v);
}
function ensureBoardId(candidate, fallbackCurrent) {
  if (isValidBoardId(candidate)) return candidate;
  if (isValidBoardId(fallbackCurrent)) return fallbackCurrent;
  return genShortId();
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
    createdAt: (b.createdAt instanceof Date
      ? b.createdAt
      : new Date(b.createdAt)
    ).toISOString(),
    updatedAt: (b.updatedAt instanceof Date
      ? b.updatedAt
      : new Date(b.updatedAt)
    ).toISOString(),
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
        userId: cleanBoard.visibility === "private" ? ownerUserId : null,
      },
      update: {
        title,
        schemaVersion,
        visibility: cleanBoard.visibility === "private" ? "private" : "public",
        userId: cleanBoard.visibility === "private" ? ownerUserId : null,
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
          create: { name },
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
const sessionTtlMs =
  1000 * 60 * 60 * Number(process.env.SESSION_TTL_HOURS ?? 720); // 30 days default
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
      } catch {}
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
app.set("views", path.join(__dirname, "public"));

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
app.use(cookieParser());

// Block direct access to template files under /public (e.g., *.html, *.hbs)
app.use((req, res, next) => {
  if (/\.(html|hbs|handlebars)$/i.test(req.path)) {
    return res.status(404).end();
  }
  next();
});
// Serve static assets (CSS/JS/images/fonts, etc.) without directory index
app.use(express.static(__templatedir, { index: false }));

app.get(/^\/uploads\/(.+)$/, fileHandler.serveUpload);

// $Routes.Views
app.get("/", uiHandler.viewIndexPage);
app.get("/login", uiHandler.viewLoginPage);
app.get("/register", uiHandler.viewRegisterPage);
app.get("/b/create-new", uiHandler.createNewBoard);
app.get("/b/:id", uiHandler.viewBoard);

// $Routes.Auth
app.post("/auth/register", authHandler.register);
app.post("/auth/login", authHandler.login);
app.post("/auth/logout", authHandler.logout);
app.get("/auth/me", requireAuth, authHandler.getCurrentUser);
app.get("/auth/verify", authHandler.verifyToken); // Request /?token=...
app.post("/auth/password/forgot", authHandler.forgotPassword); // Request Body { email }
app.post("/auth/password/reset", authHandler.resetPassword); // Request Body { token, password }

// $Routes.Board (API)
app.get("/api/board/:id", boardHandler.getBoardById);
app.post("/api/board/:id", boardHandler.createBoard);

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
app.post(
  "/api/board/:id/upload-image",
  uploadImage.single("image"),
  boardHandler.uploadImage
);

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
app.post(
  "/api/board/:id/import",
  bundleUpload.single("bundle"),
  boardHandler.importBoard
);

app.get("/api/board/:id/export", boardHandler.exportBoard);

// $Routes.Misc (API)
app.get("/api/version", miscHandler.getVersion);
app.post("/api/link-preview", miscHandler.fetchLinkPreview);

// 404 handler for unknown routes
app.use((_, res) => {
  return res.status(404).render("error", {
    code: 404,
    message: "Page not found",
    description:
      "The page you’re looking for doesn’t exist or may have been moved.",
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

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`PaperTrail running at http://localhost:${PORT}`);
});
