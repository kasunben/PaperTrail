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

async function getTableColumns(table) {
  // Works in SQLite; returns list of column names for a table
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info('${table}');`);
  return new Set(rows.map((r) => r.name));
}

function pickKnownColumns(obj, knownCols) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (knownCols.has(k)) out[k] = v;
  }
  return out;
}

async function main() {
  // --- 1) Load board JSON ---
  const jsonPath = path.join(__dirname, "../data/demo-board.json");
  const raw = await readFile(jsonPath, "utf-8");
  const boardJson = JSON.parse(raw);

  // --- 2) Discover schema columns dynamically ---
  const boardCols = await getTableColumns("Board");
  const nodeCols = await getTableColumns("Node");
  const edgeCols = await getTableColumns("Edge");

  const hasNodeBoardId = nodeCols.has("boardId");
  const hasEdgeBoardId = edgeCols.has("boardId");

  const boardId = boardJson.id || "board-demo";

  const uploadsDir = path.join(__dirname, "../public/uploads", boardId);
  await ensureDir(uploadsDir);

  // --- 3) Upsert Board (id + metadata) ---
  // Map board fields to model columns
  const boardData = pickKnownColumns(
    {
      id: boardId,
      title: boardJson.title,
      schemaVersion: Number.isInteger(boardJson.schemaVersion)
        ? boardJson.schemaVersion
        : 1,
      createdAt: boardJson.createdAt
        ? new Date(boardJson.createdAt)
        : undefined,
      updatedAt: boardJson.updatedAt
        ? new Date(boardJson.updatedAt)
        : undefined,
    },
    boardCols
  );

  await prisma.board.upsert({
    where: { id: boardId },
    create: boardData,
    update: boardData,
  });

  // --- 4) Clear existing Nodes/Edges for this board ---
  if (hasEdgeBoardId) {
    await prisma.edge.deleteMany({ where: { boardId } });
  } else {
    const ids = (boardJson.edges || []).map((e) => e.id).filter(Boolean);
    if (ids.length)
      await prisma.edge.deleteMany({ where: { id: { in: ids } } });
  }

  if (hasNodeBoardId) {
    await prisma.node.deleteMany({ where: { boardId } });
  } else {
    const ids = (boardJson.nodes || []).map((n) => n.id).filter(Boolean);
    if (ids.length)
      await prisma.node.deleteMany({ where: { id: { in: ids } } });
  }

  // --- 5) Insert Nodes ---
  const nodePayloads = (boardJson.nodes || []).map(async (n) => {
    const nodeId = n.id;
    let dataObj = n.data ?? null;
    // Localize image URLs into /public/uploads/<boardId>/ if present
    if (dataObj && (dataObj.imageUrl || dataObj.img || dataObj.thumbnail || dataObj.thumbUrl)) {
      const rawUrl = dataObj.imageUrl || dataObj.img || dataObj.thumbnail || dataObj.thumbUrl;
      if (typeof rawUrl === "string" && /^https?:\/\//i.test(rawUrl)) {
        const filename = urlToFilename(rawUrl, `${nodeId}.img`);
        const destPath = path.join(uploadsDir, filename);
        const publicPath = path.posix.join("/uploads", boardId, filename);
        try {
          await downloadToFile(rawUrl, destPath);
          dataObj = { ...dataObj, imageUrl: publicPath, thumbUrl: dataObj.thumbUrl || publicPath };
        } catch (e) {
          // Keep original URL if download fails
          dataObj = { ...dataObj, imageUrl: rawUrl };
          console.warn(`Failed to download ${rawUrl}: ${e.message}`);
        }
      }
    }
    const normalized = {
      id: n.id,
      type: n.type,
      x: Number.isFinite(n.x) ? n.x : parseInt(n.x ?? 0, 10),
      y: Number.isFinite(n.y) ? n.y : parseInt(n.y ?? 0, 10),
      w: Number.isFinite(n.w) ? n.w : parseInt(n.w ?? 0, 10),
      h:
        n.h == null
          ? undefined
          : Number.isFinite(n.h)
          ? n.h
          : parseInt(n.h, 10),
      // Prefer to store full JSON if the table has a JSON column for it
      data: dataObj,
      // Some schemas use alternative names for the JSON blob
      payload: dataObj,
      content: dataObj,
      // Flattened fields (only kept if such columns exist in your schema)
      title: dataObj && typeof dataObj.title === "string" ? dataObj.title : null,
      html:
        dataObj && typeof dataObj.html === "string"
          ? dataObj.html
          : dataObj && typeof dataObj.descHtml === "string"
          ? dataObj.descHtml
          : null,
      linkUrl:
        dataObj && typeof dataObj.linkUrl === "string" ? dataObj.linkUrl : null,
      imageUrl:
        dataObj && typeof dataObj.imageUrl === "string" ? dataObj.imageUrl : null,
      thumbUrl:
        dataObj && typeof dataObj.thumbUrl === "string" ? dataObj.thumbUrl : null,
      tags: Array.isArray(dataObj?.tags) ? dataObj.tags : null,
      boardId: hasNodeBoardId ? boardId : undefined,
      createdAt: boardJson.createdAt ? new Date(boardJson.createdAt) : undefined,
      updatedAt: boardJson.updatedAt ? new Date(boardJson.updatedAt) : undefined,
    };
    return pickKnownColumns(normalized, nodeCols);
  });

  // Prefer createMany for speed; fallback to per-item if needed
  const resolvedNodePayloads = await Promise.all(nodePayloads);
  if (resolvedNodePayloads.length) {
    await prisma.node.createMany({ data: resolvedNodePayloads });
  }

  // --- 6) Insert Edges ---
  const edgePayloads = (boardJson.edges || []).map((e) => {
    const normalized = {
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label ?? null,
      dashed: e.dashed === true,
      color: e.color ?? null,
      boardId: hasEdgeBoardId ? boardId : undefined,
      createdAt: boardJson.createdAt
        ? new Date(boardJson.createdAt)
        : undefined,
      updatedAt: boardJson.updatedAt
        ? new Date(boardJson.updatedAt)
        : undefined,
    };
    return pickKnownColumns(normalized, edgeCols);
  });

  if (edgePayloads.length) {
    await prisma.edge.createMany({ data: edgePayloads });
  }

  console.log(
    `Seeded board ${boardId} with ${resolvedNodePayloads.length} nodes and ${edgePayloads.length} edges.`
  );
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
