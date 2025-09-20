-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_boards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT 'Untitled Board',
    "schema_version" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "user_id" TEXT,
    CONSTRAINT "boards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_boards" ("created_at", "id", "schema_version", "status", "title", "updated_at", "user_id", "visibility") SELECT "created_at", "id", "schema_version", "status", "title", "updated_at", "user_id", "visibility" FROM "boards";
DROP TABLE "boards";
ALTER TABLE "new_boards" RENAME TO "boards";
CREATE INDEX "boards_user_id_idx" ON "boards"("user_id");
CREATE INDEX "boards_visibility_idx" ON "boards"("visibility");
CREATE INDEX "boards_created_at_idx" ON "boards"("created_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
