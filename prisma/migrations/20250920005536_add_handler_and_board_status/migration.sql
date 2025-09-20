/*
  Warnings:

  - Added the required column `handler` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_boards" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'public',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "user_id" TEXT,
    CONSTRAINT "boards_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_boards" ("created_at", "id", "schema_version", "title", "updated_at", "user_id", "visibility") SELECT "created_at", "id", "schema_version", "title", "updated_at", "user_id", "visibility" FROM "boards";
DROP TABLE "boards";
ALTER TABLE "new_boards" RENAME TO "boards";
CREATE INDEX "boards_user_id_idx" ON "boards"("user_id");
CREATE INDEX "boards_visibility_idx" ON "boards"("visibility");
CREATE INDEX "boards_created_at_idx" ON "boards"("created_at");
CREATE TABLE "new_users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "handler" TEXT NOT NULL,
    "email_verified_at" DATETIME,
    "password_hash" TEXT NOT NULL,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME NOT NULL
);
INSERT INTO "new_users" ("created_at", "email", "email_verified_at", "id", "password_hash", "updated_at") SELECT "created_at", "email", "email_verified_at", "id", "password_hash", "updated_at" FROM "users";
DROP TABLE "users";
ALTER TABLE "new_users" RENAME TO "users";
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE UNIQUE INDEX "users_handler_key" ON "users"("handler");
CREATE INDEX "users_created_at_idx" ON "users"("created_at");
CREATE INDEX "users_email_verified_at_idx" ON "users"("email_verified_at");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
