import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";

// Helpers
function asyncHandler(fn, logger) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      try {
        if (logger?.error) {
          logger.error("[papertrail-api] Unhandled error", {
            path: req.path,
            method: req.method,
            userId: req.user?.id || null,
            error: err?.message,
          });
        }
      } catch {}
      next(err);
    });
  };
}

const EDGE_STYLE_KEYS = new Set(["style", "labelStyle"]);

const PROJECT_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const MAX_ASSET_DIMENSION = 1400;
const THUMB_DIMENSION = 480;
const ASSET_BODY_PARSER = express.raw({
  limit: "40mb",
  type: () => true,
});

const ensureProjectId = (value) => {
  const candidate = String(value || "").trim();
  if (!candidate || !PROJECT_ID_REGEX.test(candidate)) return null;
  return candidate;
};

const buildAssetUrl = (projectId, fileName) => {
  return `/api/plugins/papertrail/assets/${encodeURIComponent(projectId)}/${encodeURIComponent(fileName)}`;
};

const dataRootForProject = (ctx, projectId) => {
  const baseDir = ctx?.dataDir || process.env.DATA_DIR || path.resolve(ctx?.rootDir || ".", "data");
  return path.join(baseDir, projectId, "assets");
};

const makeVersion = (board) => `${board.updatedAt?.toISOString?.() || ""}:${board.version ?? 0}`;

const serializeEdgeData = (edge) => {
  const baseData = edge.data && typeof edge.data === "object" ? { ...edge.data } : {};
  const meta = {};
  if (typeof edge.label === "string") {
    meta.label = edge.label;
  }
  if (edge.type && edge.type !== "default") {
    meta.type = edge.type;
  }
  if (edge.animated) {
    meta.animated = true;
  }
  if (edge.style) {
    baseData.style = edge.style;
  }
  if (edge.labelStyle) {
    baseData.labelStyle = edge.labelStyle;
  }
  if (Object.keys(meta).length) {
    baseData.__edgeMeta = meta;
  }
  return Object.keys(baseData).length ? baseData : null;
};

const formatEdgeForClient = (edge) => {
  const { data, ...rest } = edge;
  const style = data?.style;
  const labelStyle = data?.labelStyle;
  const meta = data?.__edgeMeta || {};
  const cleanedData =
    data && Object.keys(data).length
      ? Object.entries(data).reduce((acc, [key, value]) => {
          if (EDGE_STYLE_KEYS.has(key) || key === "__edgeMeta") {
            return acc;
          }
          acc[key] = value;
          return acc;
        }, {})
      : null;
  return {
    ...rest,
    ...meta,
    data: cleanedData && Object.keys(cleanedData).length ? cleanedData : null,
    ...(style ? { style } : {}),
    ...(labelStyle ? { labelStyle } : {}),
  };
};

export default (ctx) => {
  const router = express.Router();
  const prisma = ctx.prisma;
  const logger = ctx.logger || console;

  router.post(
    "/assets",
    ASSET_BODY_PARSER,
    asyncHandler(async (req, res) => {
      const projectId = ensureProjectId(req.query.projectId);
      if (!projectId) {
        return res.status(400).json({ error: "invalid_project_id" });
      }
      const payload = req.body;
      if (!payload || !payload.length) {
        return res.status(400).json({ error: "missing_image" });
      }
      const assetRoot = dataRootForProject(ctx, projectId);
      await fs.mkdir(assetRoot, { recursive: true });
      const image = sharp(payload);
      const metadata = await image.metadata();
      const extension = metadata.format ? (metadata.format === "jpeg" ? "jpg" : metadata.format) : "jpg";
      const fileBase = `${Date.now()}-${randomUUID()}`;
      const fileName = `${fileBase}.${extension}`;
      const thumbFileName = `${fileBase}.thumb.${extension}`;
      const { data: buffer, info } = await sharp(payload)
        .resize({ width: MAX_ASSET_DIMENSION, height: MAX_ASSET_DIMENSION, fit: "inside", withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      const targetPath = path.join(assetRoot, fileName);
      await fs.writeFile(targetPath, buffer);
      const { data: thumbBuffer, info: thumbInfo } = await sharp(payload)
        .resize({ width: THUMB_DIMENSION, height: THUMB_DIMENSION, fit: "inside", withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      const thumbPath = path.join(assetRoot, thumbFileName);
      await fs.writeFile(thumbPath, thumbBuffer);
      res.status(201).json({
        url: buildAssetUrl(projectId, fileName),
        width: info.width,
        height: info.height,
        thumbnailUrl: buildAssetUrl(projectId, thumbFileName),
        thumbnailWidth: thumbInfo.width,
        thumbnailHeight: thumbInfo.height,
      });
    }, logger)
  );

  router.get(
    "/assets/:projectId/:file",
    asyncHandler(async (req, res) => {
      const projectId = ensureProjectId(req.params.projectId);
      const requestedFile = String(req.params.file || "").trim();
      if (!projectId || !requestedFile) {
        return res.status(404).json({ error: "not_found" });
      }
      const fileName = path.basename(requestedFile);
      const assetRoot = dataRootForProject(ctx, projectId);
      const resolvedRoot = path.resolve(assetRoot);
      const targetPath = path.resolve(assetRoot, fileName);
      if (!targetPath.startsWith(resolvedRoot)) {
        return res.status(404).json({ error: "not_found" });
      }
      try {
        await fs.access(targetPath);
      } catch {
        return res.status(404).json({ error: "not_found" });
      }
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.sendFile(targetPath);
    }, logger)
  );

  // GET board snapshot by projectId
  router.get(
    "/boards/:projectId",
    asyncHandler(async (req, res) => {
      const { projectId } = req.params;
      const board = await prisma.papertrailBoard.findUnique({
        where: { projectId },
        include: {
          nodes: true,
          edges: true,
        },
      });
      if (!board) return res.status(404).json({ error: "Not found" });
      const formattedEdges = board.edges.map(formatEdgeForClient);
      res.json({
        board: {
          id: board.id,
          projectId: board.projectId,
          title: board.title,
          version: board.version,
          updatedAt: board.updatedAt,
        },
        nodes: board.nodes,
        edges: formattedEdges,
        version: makeVersion(board),
      });
    }, logger)
  );

  // POST create board for projectId
  router.post(
    "/boards/:projectId",
    asyncHandler(async (req, res) => {
      const { projectId } = req.params;
      const { title, nodes = [], edges = [] } = req.body || {};
      const existing = await prisma.papertrailBoard.findUnique({ where: { projectId } });
      if (existing) return res.status(409).json({ error: "exists", boardId: existing.id, projectId });
      const board = await prisma.papertrailBoard.create({
        data: {
          title: title || null,
          projectId,
          version: 0,
          nodes: {
            create: nodes.map((n) => ({
              id: n.id,
              type: n.type,
              data: n.data ?? {},
              position: n.position ?? {},
            })),
          },
          edges: {
            create: edges.map((e) => ({
              id: e.id,
              source: e.source,
              target: e.target,
              data: serializeEdgeData(e),
            })),
          },
        },
        include: { nodes: true, edges: true },
      });
      const formattedEdges = board.edges.map(formatEdgeForClient);
      res.status(201).json({
        board: {
          id: board.id,
          projectId: board.projectId,
          title: board.title,
          version: board.version,
          updatedAt: board.updatedAt,
        },
        nodes: board.nodes,
        edges: formattedEdges,
        version: makeVersion(board),
      });
    }, logger)
  );

  // PUT board snapshot (idempotent, optimistic via version) by projectId
  router.put(
    "/boards/:projectId",
    asyncHandler(async (req, res) => {
      const { projectId } = req.params;
      const { board: boardPayload = {}, nodes = [], edges = [], version } = req.body || {};

      const existing = await prisma.papertrailBoard.findUnique({
        where: { projectId },
        select: { id: true, projectId: true, version: true, updatedAt: true },
      });
      if (!existing) return res.status(404).json({ error: "Not found" });

      const currentVersion = makeVersion(existing);
      if (version && version !== currentVersion) {
        return res.status(409).json({ error: "version_conflict", currentVersion });
      }

      // Upsert nodes/edges by full replace
      await prisma.$transaction([
        prisma.papertrailNode.deleteMany({ where: { boardId: existing.id } }),
        prisma.papertrailEdge.deleteMany({ where: { boardId: existing.id } }),
        prisma.papertrailNode.createMany({
          data: nodes.map((n) => ({
            id: n.id,
            boardId: existing.id,
            type: n.type,
            data: n.data ?? {},
            position: n.position ?? {},
          })),
        }),
        prisma.papertrailEdge.createMany({
          data: edges.map((e) => ({
            id: e.id,
            boardId: existing.id,
            source: e.source,
            target: e.target,
            data: serializeEdgeData(e),
          })),
        }),
        prisma.papertrailBoard.update({
          where: { id: existing.id },
          data: {
            title: boardPayload.title ?? undefined,
            projectId,
            version: { increment: 1 },
          },
        }),
      ]);

      const updated = await prisma.papertrailBoard.findUnique({
        where: { id: existing.id },
        include: { nodes: true, edges: true },
      });

      const formattedEdges = updated.edges.map(formatEdgeForClient);
      res.json({
        board: {
          id: updated.id,
          projectId: updated.projectId,
          title: updated.title,
          version: updated.version,
          updatedAt: updated.updatedAt,
        },
        nodes: updated.nodes,
        edges: formattedEdges,
        version: makeVersion(updated),
      });
    }, logger)
  );

  // Link preview (basic HTML meta scrape). Guarded by protocol + simple private-hostname checks.
  router.get(
    "/preview",
    asyncHandler(async (req, res) => {
      const raw = String(req.query.url || "").trim();
      let target;
      try {
        target = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
      } catch {
        return res.status(400).json({ error: "invalid_url" });
      }
      if (!/^https?:$/i.test(target.protocol)) {
        return res.status(400).json({ error: "invalid_protocol" });
      }
      const host = target.hostname.toLowerCase();
      const blocked = ["localhost", "127.0.0.1", "0.0.0.0"];
      if (blocked.some((b) => host === b || host.endsWith(`.${b}`))) {
        return res.status(400).json({ error: "blocked_host" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(target.toString(), { signal: controller.signal, redirect: "follow" });
        const reader = resp.body?.getReader();
        let html = "";
        const limit = 200_000; // 200kb max read
        if (reader) {
          let received = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.length;
            html += new TextDecoder().decode(value);
            if (received > limit) break;
          }
        } else {
          html = await resp.text();
        }
        const pick = (regex) => {
          const m = html.match(regex);
          return m && m[1] ? m[1].trim() : undefined;
        };
        const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)/i) || pick(/<title[^>]*>([^<]+)/i);
        const ogDesc = pick(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)/i) || pick(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)/i);
        const ogImage = pick(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)/i);

        res.json({
          url: target.toString(),
          title: ogTitle,
          description: ogDesc,
          image: ogImage,
        });
      } catch (err) {
        if (err.name === "AbortError") {
          return res.status(408).json({ error: "timeout" });
        }
        return res.status(400).json({ error: "fetch_failed", message: err?.message });
      } finally {
        clearTimeout(timeout);
      }
    }, logger)
  );

  return router;
};
