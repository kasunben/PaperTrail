/*
  Warnings:

  - A unique constraint covering the columns `[slug]` on the table `boards` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "boards" ADD COLUMN "slug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "boards_slug_key" ON "boards"("slug");
