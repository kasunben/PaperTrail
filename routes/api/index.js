import express from "express";

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

// Simple version generator from board.updatedAt/version
const makeVersion = (board) => `${board.updatedAt?.toISOString?.() || ""}:${board.version ?? 0}`;

export default (ctx) => {
  const router = express.Router();
  const prisma = ctx.prisma;
  const logger = ctx.logger || console;

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
      res.json({
        board: {
          id: board.id,
          projectId: board.projectId,
          title: board.title,
          version: board.version,
          updatedAt: board.updatedAt,
        },
        nodes: board.nodes,
        edges: board.edges,
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
              data: e.data ?? null,
            })),
          },
        },
        include: { nodes: true, edges: true },
      });
      res.status(201).json({
        board: {
          id: board.id,
          projectId: board.projectId,
          title: board.title,
          version: board.version,
          updatedAt: board.updatedAt,
        },
        nodes: board.nodes,
        edges: board.edges,
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
            data: e.data ?? null,
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

      res.json({
        board: {
          id: updated.id,
          projectId: updated.projectId,
          title: updated.title,
          version: updated.version,
          updatedAt: updated.updatedAt,
        },
        nodes: updated.nodes,
        edges: updated.edges,
        version: makeVersion(updated),
      });
    }, logger)
  );

  return router;
};
