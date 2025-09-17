import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import path from 'path';
const prisma = new PrismaClient();

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const boardJsonPath = path.join(DATA_DIR, 'board-1', 'board.json');

function normalizeTagName(s) {
  return String(s || '').trim().replace(/^#+/, '').toLowerCase();
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(boardJsonPath, 'utf-8');
  } catch {
    console.log('No existing board.json found. Nothing to seed.');
    return;
  }
  const b = JSON.parse(raw);
  const boardId = b.id || 'board-1';

  // Upsert board
  await prisma.board.upsert({
    where: { id: boardId },
    create: {
      id: boardId,
      title: b.title || 'My Evidence Board',
      schemaVersion: b.schemaVersion ?? 1,
    },
    update: {},
  });

  // Insert nodes
  for (const n of (b.nodes || [])) {
    await prisma.node.create({
      data: {
        id: String(n.id),
        boardId,
        type: n.type || 'text',
        x: Math.trunc(n.x || 0),
        y: Math.trunc(n.y || 0),
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

    // tags
    const tags = Array.isArray(n.data?.tags) ? n.data.tags : [];
    for (const t of tags) {
      const name = normalizeTagName(t);
      if (!name) continue;
      const tag = await prisma.tag.upsert({
        where: { name },
        create: { id: `tag_${name}`, name },
        update: {},
      });
      await prisma.nodeTag.upsert({
        where: { nodeId_tagId: { nodeId: n.id, tagId: tag.id } },
        create: { nodeId: n.id, tagId: tag.id },
        update: {},
      });
    }
  }

  // Insert edges
  for (const e of (b.edges || [])) {
    await prisma.edge.create({
      data: {
        id: String(e.id),
        boardId,
        sourceId: String(e.sourceId),
        targetId: String(e.targetId),
        label: e.label ?? null,
        dashed: !!e.dashed,
        color: e.color ?? null,
      },
    });
  }

  console.log('Seed complete.');
}

main().finally(() => prisma.$disconnect());