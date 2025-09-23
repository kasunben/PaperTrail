# PaperTrail — map your evidence, follow the story.

PaperTrail is a lightweight visual evidence board for organizing ideas, documents, images, and links. It lets you pin down pieces of information, connect them freely, and uncover patterns. Whether you’re researching, investigating, or just making sense of complex projects, PaperTrail helps you create a clear trail of evidence you can return to and share.

## Getting Started

We use Node.js/Express with the Handlebars template engine as the core stack for this application. SQLite serves as the primary database, with straightforward extensibility to PostgreSQL (or any other SQL database) through Prisma.

All uploaded assets are stored under `/data/uploads/*`, organized by board IDs.

Portability is currently managed via the **Import/Export** functionality.

### Guest Login (Optional Feature)

You can allow frictionless exploration via a guest account.

Environment flags (set in `.env`):

```
GUEST_LOGIN_ENABLED=true|false
GUEST_LOGIN_ENABLED_BYPASS_LOGIN=true|false
```

Behavior:

- GUEST_LOGIN_ENABLED=false → Normal auth only (default).
- GUEST_LOGIN_ENABLED=true and GUEST_LOGIN_ENABLED_BYPASS_LOGIN=false → Login page shows a “Continue as guest” link. Each click creates a fresh random guest (handler like `guest_ab12cd34`).
- GUEST_LOGIN_ENABLED=true and GUEST_LOGIN_ENABLED_BYPASS_LOGIN=true → No login screen. First visitor creates (or reuses) a singleton guest (handler `guest`); all users share that session pattern (until cookie expires).

Notes:

- Guest boards you create are still tied to the guest user id.
- Disable in production if multi‑user accountability is required.
- Consider adding rate limiting if exposed publicly.

### Seeding (Demo Board)

A public demo board (“Sri Lanka Protests — 2022”) is embedded in `prisma/seed.mjs`.  
It is inserted only if it does not already exist (non‑destructive).

Board id: `board-sri-lanka-protests-2022`  
Properties: `visibility=public`, `status=published`, `userId=null` (shown to every authenticated user, including guest).

Run the seed after pushing the schema:

```bash
npx prisma db push
node prisma/seed.mjs
# or if configured:
npx prisma db seed // or npm run prisma:seed
```

Force re-seed (optional):

```bash
sqlite3 data/papertrail.db "DELETE FROM boards WHERE id='board-sri-lanka-protests-2022';"
node prisma/seed.mjs
```

If you later bump the board JSON format, also update:

- `schemaVersion` in `seed.mjs`
- `schemaVersion` constant in `package.json`

### Development

```bash
git clone git@github.com:kasunben/PaperTrail.git
cd PaperTrail
cp .env.example .env
npm i
```

**Sync Databse with Prisma schema.**

```bash
npx prisma db push
```

Use `npm run dev` to launch the development server with automatic file watching. For the production build, use `npm start`.

#### Prisma

We use [Prisma](https://www.prisma.io/) as intermediate abstraction layer between the app code and the database.

##### Updating the schema

- Update `prisma/schema.prisma` first
- Run `npx prisma format` to ensure the validity and format the schema changes
- Run the migration command to log the change with `npx prisma migrate dev --name <migration-name-in-snake-case>`

#### Git Workflow

We follow a [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/) inspired branching strategy to keep development organized and production stable.

**Branches**

- `main` → production branch (always deployable).
- `develop` → integration branch (latest development work).
- `feat/` → short-lived branches for new features or fixes.
- `release/` → optional branches to prepare a release.
- `hotfix/` → urgent fixes branched from main.
- `fix/` → bug fixes

##### Workflow

###### Start a feature

```bash
git switch -c feature/my-feature develop
```

Work, commit, and rebase with develop to stay updated.

###### Open a PR → merge into develop

- Use **Squash & Merge** to keep history clean.

###### Release to production

- When develop is stable:

```bash
git checkout main
git merge --ff-only develop
git push origin main
```

- Tag the release:

```bash
git tag -a v1.2.0 -m "Release v1.2.0"
git push origin v1.2.0
```

###### Hotfixes

- Branch from `main`, fix, then merge back into both `main` and `develop`.

> **Notes:**
> - Do not rebase shared branches (`main`, `develop`).
> - Rebase your local feature branches before opening a PR to keep history linear.
> - Squash merges ensure each feature is a single, clean commit in history.

## License

The community version licensed under MIT.
