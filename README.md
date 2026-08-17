# bopbap-blog

Blog bảo mật [bopbap.co](https://bopbap.co) — writeup pentest, 0-day research, smart-contract audit và CTF (Damn Vulnerable DeFi).

## Stack

- **Framework:** [Astro](https://astro.build) 5 (static site, content collections)
- **Nội dung:** Markdown thuần trong `src/posts/`
- **Deploy:** [Cloudflare Pages](https://pages.cloudflare.com) — Git integration, tự build khi push lên `main`

## Viết bài mới

Tạo file `src/posts/<slug>.md` với frontmatter:

```md
---
title: "Tiêu đề bài viết"
description: "Mô tả ngắn hiển thị ở danh sách"
pubDate: 2026-08-17
tags: ["web3", "ctf"]
draft: false
challenge: "damn-vulnerable-defi"
difficulty: "medium"
---

Nội dung markdown...
```

- `draft: true` → bài ẩn khỏi trang chủ + RSS (build vẫn chạy, chỉ không render).
- `pubDate` → điều khiển thứ tự hiển thị (mới nhất lên đầu).
- Có thể dùng series: `series: "damn-vulnerable-defi"`.

## Dev

```bash
npm install
npm run dev     # localhost:4321
npm run build   # build tĩnh ra dist/
npm run preview # xem bản build
```

## Deploy (Cloudflare Pages)

1. Tạo project Pages mới, chọn **Connect to Git** → repo `musicsms/bopbap-blog`.
2. Framework preset: **Astro** (build command `npm run build`, output directory `dist`).
3. Gắn custom domain `bopbap.co` → Pages project.

Mỗi push lên `main` Cloudflare tự build + deploy.
