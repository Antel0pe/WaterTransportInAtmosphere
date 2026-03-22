This is a Next.js project for visualizing water transport in the atmosphere.

## Getting Started

This repository uses `pnpm`.

Install dependencies:

```bash
pnpm install
```

Start the development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

## Git Worktrees

`pnpm` stores package contents in a shared content-addressable store, so worktrees
reuse downloaded dependencies automatically. Each worktree still needs its own
`pnpm install` once to create that worktree's `node_modules` links, but the package
payload is shared instead of duplicated.

For the best disk savings, keep your worktrees on the same filesystem so `pnpm` can
use hard links instead of copying packages between disks.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js). Feedback and contributions are welcome.

## Deploy on Vercel

The easiest way to deploy the app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme).

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
