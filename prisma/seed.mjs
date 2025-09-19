import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import https from "https";
import http from "http";

const prisma = new PrismaClient();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function urlToFilename(urlStr, fallbackBase) {
  try {
    const u = new URL(urlStr);
    const base = path.basename(u.pathname) || fallbackBase;
    // basic sanitization
    return base.replace(/[^a-zA-Z0-9._-]/g, "_");
  } catch {
    return fallbackBase;
  }
}

async function downloadToFile(urlStr, destPath) {
  const proto = urlStr.startsWith("https") ? https : http;
  await new Promise((resolve, reject) => {
    const file = createWriteStream(destPath);
    const req = proto.get(urlStr, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // follow simple redirect
        downloadToFile(res.headers.location, destPath).then(resolve).catch(reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} for ${urlStr}`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    });
    req.on("error", (err) => {
      try { file.close(); } catch {}
      reject(err);
    });
  });
}

function normalizeTag(raw) {
  return String(raw).trim().replace(/^#+/, "").toLowerCase();
}

async function main() {
  // --- 1) Load board JSON ---
  const jsonPath = path.join(__dirname, "../data/demo-board.json");
  const raw = await readFile(jsonPath, "utf-8");
  const boardJson = JSON.parse(raw);

  const boardId = boardJson.id || "board-demo";
  const uploadsDir = path.join(__dirname, "../data/uploads", boardId);
  await ensureDir(uploadsDir);

  // --- 2) Upsert Board (id + metadata) ---
  await prisma.board.upsert({
    where: { id: boardId },
    create: {
      id: boardId,
      title: boardJson.title || "Demo Board",
      schemaVersion: Number.isInteger(boardJson.schemaVersion) ? boardJson.schemaVersion : 1,
      // createdAt/updatedAt use defaults if undefined
    },
    update: {
      title: boardJson.title || "Demo Board",
      schemaVersion: Number.isInteger(boardJson.schemaVersion) ? boardJson.schemaVersion : 1,
    },
  });

  // --- 3) Clear existing data for this board ---
  await prisma.$transaction([
    prisma.nodeTag.deleteMany({ where: { node: { boardId } } }),
    prisma.edge.deleteMany({ where: { boardId } }),
    prisma.node.deleteMany({ where: { boardId } }),
  ]);

  // --- 4) Insert Nodes ---
  for (const n of boardJson.nodes || []) {
    const nodeId = n.id;
    let dataObj = n.data ?? null;

    // Localize image URLs into /data/uploads/<boardId>/ if present (served at /uploads/<boardId>/...)
    if (dataObj && (dataObj.imageUrl || dataObj.img || dataObj.thumbnail || dataObj.thumbUrl)) {
      const rawUrl = dataObj.imageUrl || dataObj.img || dataObj.thumbnail || dataObj.thumbUrl;
      if (typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl)) {
        const filename = urlToFilename(rawUrl, `${nodeId}.img`);
        const destPath = path.join(uploadsDir, filename);
        const publicPath = path.posix.join("/uploads", boardId, filename);
        try {
          await downloadToFile(rawUrl, destPath);
          dataObj = { ...dataObj, imageUrl: publicPath, thumbUrl: dataObj?.thumbUrl || publicPath };
        } catch (e) {
          // Keep original URL if download fails
          dataObj = { ...dataObj, imageUrl: rawUrl };
          console.warn(`Failed to download ${rawUrl}: ${e.message}`);
        }
      }
    }

    await prisma.node.create({
      data: {
        id: nodeId, // keep JSON id so edges can reference it
        boardId,
        type: n.type,
        x: Number.isFinite(n.x) ? Math.trunc(n.x) : parseInt(n.x ?? 0, 10),
        y: Number.isFinite(n.y) ? Math.trunc(n.y) : parseInt(n.y ?? 0, 10),
        w: Number.isFinite(n.w) ? Math.trunc(n.w) : (n.w == null ? null : parseInt(n.w, 10)),
        h: Number.isFinite(n.h) ? Math.trunc(n.h) : (n.h == null ? null : parseInt(n.h, 10)),

        // Flattened fields per schema (camelCase; Prisma maps to snake_case)
        title: typeof dataObj?.title === "string" ? dataObj.title : null,
        html: typeof dataObj?.html === "string" ? dataObj.html
             : typeof dataObj?.descHtml === "string" ? dataObj.descHtml : null,
        linkUrl: typeof dataObj?.linkUrl === "string" ? dataObj.linkUrl : null,
        imageUrl: typeof dataObj?.imageUrl === "string" ? dataObj.imageUrl : null,
      },
    });

    // Tags → Tag/NodeTag
    const tags = Array.isArray(dataObj?.tags) ? dataObj.tags : [];
    for (const rawTag of tags) {
      const name = normalizeTag(rawTag);
      if (!name) continue;
      const tag = await prisma.tag.upsert({
        where: { name },
        create: { name }, // DB generates cuid()
        update: {},
      });
      await prisma.nodeTag.create({ data: { nodeId, tagId: tag.id } });
    }
  }

  // --- 5) Insert Edges ---
  for (const e of boardJson.edges || []) {
    await prisma.edge.create({
      data: {
        id: e.id,
        boardId,
        sourceId: e.sourceId,
        targetId: e.targetId,
        label: e.label ?? null,
        dashed: e.dashed === true,
        color: e.color ?? null,
      },
    });
  }

  console.log(`Seeded board ${boardId} with ${(boardJson.nodes || []).length} nodes and ${(boardJson.edges || []).length} edges.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
