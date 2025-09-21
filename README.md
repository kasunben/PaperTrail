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

## Configuration

PaperTrail can be configured using environment variables in a `.env` file:

### Guest Login

The guest login feature allows you to add a simple authentication layer to your PaperTrail instance. When enabled, users must click "Continue as Guest" before accessing the application.

To enable guest login, set the following in your `.env` file:

```
GUEST_LOGIN_ENABLED=true
```

When guest login is enabled:
- Users will see a modal dialog when first accessing the application
- They must click "Continue as Guest" to proceed
- The guest session is stored in localStorage
- All API requests are authenticated with a guest token

To disable guest login (default behavior), set:

```
GUEST_LOGIN_ENABLED=false
```

## License

The community version licensed under MIT.
