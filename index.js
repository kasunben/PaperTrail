export async function onDelete({ prisma, projectId, logger }) {
  try {
    const board = await prisma.papertrailBoard.findUnique({
      where: { projectId },
      select: { id: true },
    });

    if (!board) {
      return;
    }

    await prisma.$transaction([
      prisma.papertrailNode.deleteMany({ where: { boardId: board.id } }),
      prisma.papertrailEdge.deleteMany({ where: { boardId: board.id } }),
      prisma.papertrailBoard.delete({ where: { id: board.id } }),
    ]);
  } catch (err) {
    if (err?.code === "P2025") {
      // Not found; ignore
      return;
    }
    if (logger?.error) {
      logger.error("[papertrail] onDelete failed", { projectId, error: err?.message });
    }
    throw err;
  }
}
