# Ringfall

A top-down rhythm game by Halfbyte. Slide under the notes, hit on the beat.

**Play:** https://ringfall-production.up.railway.app

## What's here

- `public/` — the game (plain HTML, CSS and JavaScript modules, no build step)
  - `js/levels.js` — the built-in levels and chart format
  - `js/editor.js` — the level editor (Create on the main menu)
  - `js/game.js` — the engine, difficulty settings and sprites (`SPRITES`)
  - `admin.html` — the songs page (`/admin`)
  - `waterfall.html` — the Waterfall mod maker (`/waterfall`)
- `server.ts` — the Bun server: serves the game, songs from the storage bucket, the admin API and Waterfall
- `Dockerfile` — how Railway runs it

Pushing to `main` redeploys the site on Railway.

## Running locally

```
bun server.ts
```

Then open http://localhost:3000. Without bucket settings it keeps songs and mods in `./data`.

## Settings (Railway variables)

`S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (from the bucket) and `ADMIN_PASSWORD` (for `/admin` and `/update`).
