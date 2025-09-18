# PaperTrail — map your evidence, follow the story.

PaperTrail is a lightweight visual evidence board for organizing ideas, documents, images, and links. It lets you pin down pieces of information, connect them freely, and uncover patterns. Whether you’re researching, investigating, or just making sense of complex projects, PaperTrail helps you create a clear trail of evidence you can return to and share.

## Getting Started

At this stage, PaperTrail is designed as a single-user, single-workspace app. That means there is only one active board available at a time. Features such as real-time collaboration, multi-user access, or simultaneous editing are not yet supported.

If you want to manage multiple boards or workspaces, you can still do so manually using the Import/Export features:
- Export your current board as a .zip file to save it.
- Import a previously exported board to continue working on it.
- You are responsible for organizing these exported files if you wish to maintain multiple workspaces.

This setup is lightweight and simple, making it ideal for solo use, prototyping, or testing out ideas. Future versions of PaperTrail may add multi-board support and collaboration features.`

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

#### Git Workflow

We follow a [Git Flow](https://nvie.com/posts/a-successful-git-branching-model/) inspired branching strategy to keep development organized and production stable.

**Branches**
- `main` → production branch (always deployable).
- `develop` → integration branch (latest development work).
- `feature/` → short-lived branches for new features or fixes.
- `release/` → optional branches to prepare a release.
- `hotfix/` → urgent fixes branched from main.

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
