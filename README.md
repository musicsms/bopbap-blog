# bopbap-blog

Security research blog [bopbap.co](https://bopbap.co) — pentest writeups, 0-day research, smart contract auditing, and CTFs (Damn Vulnerable DeFi).

## Stack

- **Framework:** [Astro](https://astro.build) 5 (static site, content collections)
- **Content:** Pure Markdown in `src/posts/`
- **Deployment:** [Cloudflare Pages](https://pages.cloudflare.com) — Git integration, automatic builds on push to `main`

## Writing a New Post

Create a file `src/posts/<slug>.md` with frontmatter:

```md
---
title: "Post Title"
description: "Short description displayed in lists"
pubDate: 2026-08-17
tags: ["web3", "ctf"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "medium"
---

Markdown content...
```

- `draft: true` → hides post from homepage + RSS feed (build still processes it, but doesn't render).
- `pubDate` → controls display order (newest first).
- Optional series tag: `series: "damn-vulnerable-defi"`.

## Development

```bash
npm install
npm run dev     # localhost:4321
npm run build   # static build to dist/
npm run preview # preview build
```

## Deployment (Cloudflare Pages)

1. Create a new Pages project, select **Connect to Git** → repo `musicsms/bopbap-blog`.
2. Framework preset: **Astro** (build command `npm run build`, output directory `dist`).
3. Attach custom domain `bopbap.co` → Pages project.

Every push to `main` automatically triggers Cloudflare to build and deploy.
