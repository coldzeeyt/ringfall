// Ringfall server (Bun, deployed on Railway from this repo).
// Serves the game, streams songs from the bucket, hosts the song upload page (/admin)
// and Waterfall, the mod site (/waterfall) where anyone can publish data-only mods.
import { S3Client } from "bun";


// ---------- storage: the Railway bucket, or a local folder when testing ----------
type Store = {
  get(key: string): Promise<Blob | null>;
  put(key: string, data: Blob | string, type: string): Promise<void>;
  del(key: string): Promise<void>;
};

function makeStore(): Store {
  if (Bun.env.S3_BUCKET) {
    const s3 = new S3Client({
      accessKeyId: Bun.env.S3_ACCESS_KEY_ID,
      secretAccessKey: Bun.env.S3_SECRET_ACCESS_KEY,
      bucket: Bun.env.S3_BUCKET,
      endpoint: Bun.env.S3_ENDPOINT,
      region: Bun.env.S3_REGION || "auto",
      virtualHostedStyle: false, // Railway buckets accept path-style requests
    });
    return {
      async get(key) { const f = s3.file(key); return (await f.exists()) ? f : null; },
      async put(key, data, type) { await s3.write(key, data, { type }); },
      async del(key) { try { await s3.delete(key); } catch {} },
    };
  }
  const root = Bun.env.LOCAL_DATA || "./data";
  const { mkdir, unlink } = require("node:fs/promises");
  const { dirname } = require("node:path");
  return {
    async get(key) { const f = Bun.file(`${root}/${key}`); return (await f.exists()) ? f : null; },
    async put(key, data, _type) { await mkdir(dirname(`${root}/${key}`), { recursive: true }); await Bun.write(`${root}/${key}`, data); },
    async del(key) { try { await unlink(`${root}/${key}`); } catch {} },
  };
}
const store = makeStore();

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try { const b = await store.get(key); return b ? await b.json() : fallback; } catch { return fallback; }
}
const writeJSON = (key: string, v: unknown) => store.put(key, JSON.stringify(v, null, 2), "application/json");

// ---------- helpers ----------
const ADMIN = Bun.env.ADMIN_PASSWORD || "";
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "cache-control": "no-store" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

const AUDIO = { mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm" } as Record<string, string>;
const IMAGE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as Record<string, string>;
const ext = (name: string) => (name.split(".").pop() || "").toLowerCase();
const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "file";
const rand = (n = 6) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
const sha = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

function timingSafe(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const isAdmin = (req: Request) => !!ADMIN && timingSafe(req.headers.get("x-admin-password") || "", ADMIN);

function serveBlob(blob: Blob, type: string, req: Request) {
  const headers: Record<string, string> = {
    "content-type": type, "cache-control": "public, max-age=3600",
    "x-content-type-options": "nosniff", "accept-ranges": "bytes",
  };
  const range = req.headers.get("range");
  const size = blob.size;
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && size) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
    if (start <= end && start < size) {
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
      return new Response(blob.slice(start, end + 1), { status: 206, headers });
    }
  }
  return new Response(blob, { headers });
}

// game files live in the bucket under site/ and are cached here for a minute
const SITE_TYPES: Record<string, string> = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json", png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const siteCache = new Map<string, { at: number; body: ArrayBuffer | null }>();
async function siteFile(p: string) {
  // files in this repo's public/ folder win; the bucket copy (site/) is the fallback
  const local = Bun.file(new URL("./public" + p, import.meta.url).pathname);
  if (await local.exists()) return await local.arrayBuffer();
  const hit = siteCache.get(p);
  if (hit && Date.now() - hit.at < 60_000) return hit.body;
  const blob = await store.get("site" + p);
  const body = blob ? await blob.arrayBuffer() : null;
  siteCache.set(p, { at: Date.now(), body });
  return body;
}

const UPDATE_PAGE = `<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Update Ringfall</title>
<body style="font-family:system-ui;background:#1c1748;color:#eeedfe;display:grid;place-items:center;min-height:100vh;margin:0">
<form id="f" style="display:flex;flex-direction:column;gap:12px;width:min(360px,90vw)"><h2>Update game files</h2>
<label>Songs password<br><input id="pw" type="password" style="width:100%;padding:8px"></label>
<label>Game folder (the unzipped "public" folder)<br><input id="d" type="file" webkitdirectory multiple></label>
<button style="padding:10px;border-radius:10px;background:#ed93b1;border:0;font-weight:600">Upload</button><p id="m"></p></form>
<script>f.onsubmit=async e=>{e.preventDefault();const fd=new FormData();for(const x of d.files)fd.append(x.webkitRelativePath||x.name,x);m.textContent='Uploading...';
const r=await fetch('api/admin/site',{method:'POST',headers:{'x-admin-password':pw.value},body:fd});const j=await r.json().catch(()=>({}));
m.textContent=r.ok?'Updated '+j.files+' files. Reload the game.':(j.error||'Failed');}</script>`;

// simple per-IP limit for publishing mods
const publishLog = new Map<string, number[]>();
function allowPublish(ip: string) {
  const now = Date.now(), list = (publishLog.get(ip) || []).filter(t => now - t < 3600_000);
  if (list.length >= 6) return false;
  list.push(now); publishLog.set(ip, list); return true;
}

// ---------- songs for the main levels (slots 1–3) ----------
type SlotInfo = { title: string; artist: string; bpm: number; offsetMs: number; density: string; file: string; chart: unknown; updated: string };

// A chart is a list of notes, or { notes, triggers } from the editor.
const BG_NAMES = ["night", "sunset", "dawn", "mint", "storm", "ember", "deep"];
function cleanTrigger(t: any) {
  const b = Number(t?.b), fade = Math.min(16, Math.max(0, Number(t?.fade ?? 1) || 0));
  if (!isFinite(b) || b < 0 || b > 10000) return null;
  switch (t.type) {
    case "flip": case "mirror": case "bars": return { b, type: t.type, value: !!t.value, fade };
    case "speed": { const v = Number(t.value); return isFinite(v) ? { b, type: "speed", value: Math.min(2.5, Math.max(0.5, v)), fade } : null; }
    case "background": return BG_NAMES.includes(t.value) ? { b, type: "background", value: t.value, fade } : null;
    default: return null;
  }
}
function cleanChart(raw: unknown, max = 5000) {
  let c: any = raw;
  if (typeof c === "string") { if (!c.trim()) return null; c = JSON.parse(c); }
  let triggers: any[] = [];
  if (c && !Array.isArray(c) && Array.isArray(c.notes)) { triggers = Array.isArray(c.triggers) ? c.triggers : []; c = c.notes; }
  if (!Array.isArray(c)) return null;
  const notes = c.slice(0, max).map((n: any) => {
    const b = Number(n.b ?? n.beat), x = Number(n.x), len = Number(n.len ?? 0);
    if (!isFinite(b) || b < 0 || b > 10000 || !isFinite(x)) throw new Error("Chart has a bad note");
    const o: any = { b, x: Math.min(1, Math.max(0, x)) };
    if (isFinite(len) && len > 0) o.len = Math.min(64, len);
    return o;
  });
  const trig = triggers.slice(0, 500).map(cleanTrigger).filter(Boolean);
  return trig.length ? { notes, triggers: trig } : notes;
}

async function adminUpload(req: Request) {
  const form = await req.formData();
  const slot = String(form.get("slot"));
  if (!["1", "2", "3"].includes(slot)) return bad("Pick level 1, 2 or 3");
  const levels = await readJSON<Record<string, SlotInfo>>("levels.json", {});
  const prev = levels[slot];
  const file = form.get("file");
  let fileName = prev?.file || "";
  if (file instanceof Blob && file.size) {
    const name = (file as File).name || "song.mp3";
    if (!AUDIO[ext(name)]) return bad("Songs must be mp3, ogg, wav, m4a, aac, flac or webm");
    fileName = `slot${slot}-${Date.now().toString(36)}-${safeName(name)}`;
    await store.put("songs/" + fileName, file, AUDIO[ext(name)]);
    if (prev?.file && prev.file !== fileName) await store.del("songs/" + prev.file);
  }
  if (!fileName) return bad("Add a song file");
  let chart = null;
  try { chart = cleanChart(form.get("chart")); } catch (e: any) { return bad("Chart isn't valid JSON: " + e.message); }
  levels[slot] = {
    title: String(form.get("title") || `Level ${slot}`).slice(0, 60),
    artist: String(form.get("artist") || "").slice(0, 60),
    bpm: Math.min(400, Math.max(30, Number(form.get("bpm")) || 120)),
    offsetMs: Math.min(10000, Math.max(-10000, Number(form.get("offsetMs")) || 0)),
    density: ["easy", "normal", "hard"].includes(String(form.get("density"))) ? String(form.get("density")) : "normal",
    file: fileName,
    chart,
    updated: new Date().toISOString(),
  };
  await writeJSON("levels.json", levels);
  return json({ ok: true, levels });
}

async function adminRemove(req: Request) {
  const { slot } = await req.json();
  const levels = await readJSON<Record<string, SlotInfo>>("levels.json", {});
  if (levels[slot]) { await store.del("songs/" + levels[slot].file); delete levels[slot]; await writeJSON("levels.json", levels); }
  return json({ ok: true, levels });
}

// ---------- Waterfall mods ----------
const THEME_KEYS = ["background", "background2", "ground", "ridge", "track", "accent", "text", "soft", "player", "ring", "tap", "hold", "holdLight"];
type ModIndexEntry = { id: string; name: string; author: string; description: string; version: string; tags: string[]; downloads: number; created: string; updated: string; theme: Record<string, string>; thumb: string | null };

const modUrl = (id: string, f: string | null | undefined) => (f ? `mods/${id}/${encodeURIComponent(f)}` : null);

async function publishMod(req: Request, ip: string) {
  if (!allowPublish(ip)) return bad("You've published a lot this hour. Try again later.", 429);
  const form = await req.formData();
  let man: any;
  try { man = JSON.parse(String(form.get("manifest") || "{}")); } catch { return bad("mod.json isn't valid JSON"); }

  // files sent alongside the manifest, by their original name
  const files = new Map<string, File>();
  let total = 0;
  for (const [k, v] of form.entries()) {
    if (k !== "files" || !(v instanceof Blob)) continue;
    const f = v as File, e = ext(f.name);
    const isImg = !!IMAGE[e], isAud = !!AUDIO[e];
    if (!isImg && !isAud) return bad(`${f.name}: only png, jpg, webp, gif and audio files are allowed`);
    if (isImg && f.size > 3 * 1024 * 1024) return bad(`${f.name} is over 3 MB`);
    if (isAud && f.size > 25 * 1024 * 1024) return bad(`${f.name} is over 25 MB`);
    total += f.size;
    files.set(f.name, f);
  }
  if (total > 60 * 1024 * 1024) return bad("The whole mod has to be under 60 MB");

  const name = String(man.name || "").trim().slice(0, 40);
  if (!name) return bad("Give your mod a name");
  const theme: Record<string, string> = {};
  for (const k of THEME_KEYS) if (typeof man.theme?.[k] === "string" && /^#[0-9a-f]{6}$/i.test(man.theme[k])) theme[k] = man.theme[k].toLowerCase();

  const need = (fname: unknown, kind: "image" | "audio") => {
    if (!fname) return null;
    const f = files.get(String(fname));
    if (!f) throw new Error(`Missing file: ${fname}`);
    if (kind === "image" && !IMAGE[ext(f.name)]) throw new Error(`${fname} should be an image`);
    if (kind === "audio" && !AUDIO[ext(f.name)]) throw new Error(`${fname} should be audio`);
    return f;
  };

  // update an existing mod with its key, or make a new one
  let id = String(form.get("modId") || "").trim();
  const key = String(form.get("modKey") || "").trim();
  const index = await readJSON<ModIndexEntry[]>("mods/index.json", []);
  let existing = id ? index.find(m => m.id === id) : undefined;
  let editKey = "";
  if (id) {
    const secret = await readJSON<{ keyHash: string }>(`mods/${id}/.key.json`, { keyHash: "" });
    if (!existing || !secret.keyHash || secret.keyHash !== (await sha(key))) return bad("Mod ID or key is wrong", 403);
  } else {
    id = `${safeName(name).replace(/\./g, "-").slice(0, 28)}-${rand(4)}`;
    editKey = rand(16);
  }

  try {
    const stored = new Map<string, string>();
    const keep = async (f: File | null) => {
      if (!f) return null;
      if (stored.has(f.name)) return stored.get(f.name)!;
      const fn = safeName(f.name);
      await store.put(`mods/${id}/${fn}`, f, IMAGE[ext(f.name)] || AUDIO[ext(f.name)]);
      stored.set(f.name, fn);
      return fn;
    };
    const sprites: Record<string, string | null> = {};
    for (const k of ["player", "tap", "background"]) sprites[k] = await keep(need(man.sprites?.[k], "image"));
    const hitsound = await keep(need(man.hitsound, "audio"));
    const levels = [];
    for (const lv of (Array.isArray(man.levels) ? man.levels : []).slice(0, 8)) {
      const music = await keep(need(lv.music, "audio"));
      if (!music) throw new Error("Each level needs a song file");
      levels.push({
        title: String(lv.title || name).slice(0, 40), artist: String(lv.artist || "").slice(0, 40),
        bpm: Math.min(400, Math.max(30, Number(lv.bpm) || 120)),
        offsetMs: Math.min(10000, Math.max(-10000, Number(lv.offsetMs) || 0)),
        density: ["easy", "normal", "hard"].includes(lv.density) ? lv.density : "normal",
        music, chart: cleanChart(lv.chart ?? null),
      });
    }
    const tags = [];
    if (Object.keys(theme).length) tags.push("colours");
    if (sprites.player || sprites.tap || sprites.background) tags.push("sprites");
    if (hitsound) tags.push("sounds");
    if (levels.length) tags.push(levels.length === 1 ? "1 level" : `${levels.length} levels`);
    if (!tags.length) throw new Error("A mod needs at least one change: colours, a sprite, a sound or a level");

    const now = new Date().toISOString();
    const manifest = {
      id, name,
      author: String(man.author || "").trim().slice(0, 30),
      description: String(man.description || "").trim().slice(0, 280),
      version: String(man.version || "1.0").slice(0, 12),
      theme, sprites, hitsound, levels, tags,
      created: existing?.created || now, updated: now,
    };
    await writeJSON(`mods/${id}/mod.json`, manifest);
    if (editKey) await writeJSON(`mods/${id}/.key.json`, { keyHash: await sha(editKey) });

    const entry: ModIndexEntry = {
      id, name, author: manifest.author, description: manifest.description, version: manifest.version,
      tags, downloads: existing?.downloads || 0, created: manifest.created, updated: now, theme,
      thumb: modUrl(id, sprites.background || sprites.player || sprites.tap),
    };
    const fresh = await readJSON<ModIndexEntry[]>("mods/index.json", []);
    const i = fresh.findIndex(m => m.id === id);
    if (i >= 0) fresh[i] = entry; else fresh.push(entry);
    await writeJSON("mods/index.json", fresh);
    return json({ ok: true, id, key: editKey || undefined });
  } catch (e: any) {
    return bad(e.message || "Couldn't publish that mod");
  }
}

async function modForClient(id: string) {
  const m = await readJSON<any>(`mods/${id}/mod.json`, null);
  if (!m) return null;
  return {
    ...m,
    sprites: Object.fromEntries(Object.entries(m.sprites || {}).map(([k, v]) => [k, modUrl(id, v as string)])),
    hitsound: modUrl(id, m.hitsound),
    levels: (m.levels || []).map((lv: any) => ({ ...lv, music: modUrl(id, lv.music) })),
  };
}

async function deleteMod(id: string) {
  const index = await readJSON<ModIndexEntry[]>("mods/index.json", []);
  const m = await readJSON<any>(`mods/${id}/mod.json`, null);
  if (m) {
    const fns = new Set<string>([...Object.values(m.sprites || {}), m.hitsound, ...(m.levels || []).map((l: any) => l.music)].filter(Boolean) as string[]);
    for (const f of fns) await store.del(`mods/${id}/${f}`);
    await store.del(`mods/${id}/mod.json`); await store.del(`mods/${id}/.key.json`);
  }
  await writeJSON("mods/index.json", index.filter(x => x.id !== id));
}

// ---------- router ----------
Bun.serve({
  port: Number(Bun.env.PORT || 3000),
  maxRequestBodySize: 120 * 1024 * 1024,
  async fetch(req, server) {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname);
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || server.requestIP(req)?.address || "?";
    try {
      // songs + levels
      if (p === "/api/levels") return json(await readJSON("levels.json", {}));
      if (p.startsWith("/music/")) {
        const f = p.slice(7);
        if (!/^[a-z0-9._-]+$/.test(f)) return bad("Not found", 404);
        const blob = await store.get("songs/" + f);
        return blob ? serveBlob(blob, AUDIO[ext(f)] || "application/octet-stream", req) : bad("Not found", 404);
      }

      // admin
      if (p === "/api/admin/check" && req.method === "POST") return isAdmin(req) ? json({ ok: true }) : bad("Wrong password", 401);
      if (p.startsWith("/api/admin/")) {
        if (!isAdmin(req)) return bad("Wrong password", 401);
        if (p === "/api/admin/upload" && req.method === "POST") return await adminUpload(req);
        if (p === "/api/admin/remove" && req.method === "POST") return await adminRemove(req);
        if (p === "/api/admin/mods/delete" && req.method === "POST") { const { id } = await req.json(); await deleteMod(String(id)); return json({ ok: true }); }
      }

      // update the game's own files from a folder (password protected)
      if (p === "/update") return new Response(UPDATE_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (p === "/api/admin/site" && req.method === "POST") {
        if (!isAdmin(req)) return bad("Wrong password", 401);
        const form = await req.formData(); let n = 0;
        for (const [k, v] of form.entries()) {
          if (!(v instanceof Blob)) continue;
          const rel = "/" + k.replace(/^.*?(index\.html|admin\.html|waterfall\.html|css\/|js\/)/, "$1");
          if (!/^\/[a-z0-9/._-]+$/.test(rel) || rel.includes("..") || !SITE_TYPES[ext(rel)]) continue;
          await store.put("site" + rel, v, SITE_TYPES[ext(rel)]); siteCache.delete(rel); n++;
        }
        return json({ ok: true, files: n });
      }

      // Waterfall
      if (p === "/api/mods" && req.method === "GET") {
        const index = await readJSON<ModIndexEntry[]>("mods/index.json", []);
        index.sort((a, b) => (b.downloads - a.downloads) || b.updated.localeCompare(a.updated));
        return json({ mods: index });
      }
      if (p === "/api/mods" && req.method === "POST") return await publishMod(req, ip);
      let m = /^\/api\/mods\/([a-z0-9-]+)$/.exec(p);
      if (m && req.method === "GET") { const mod = await modForClient(m[1]); return mod ? json(mod) : bad("No such mod", 404); }
      m = /^\/api\/mods\/([a-z0-9-]+)\/download$/.exec(p);
      if (m && req.method === "POST") {
        const index = await readJSON<ModIndexEntry[]>("mods/index.json", []);
        const e = index.find(x => x.id === m![1]);
        if (e) { e.downloads++; await writeJSON("mods/index.json", index); }
        return json({ ok: true });
      }
      m = /^\/api\/mods\/([a-z0-9-]+)\/delete$/.exec(p);
      if (m && req.method === "POST") {
        const { key } = await req.json();
        const secret = await readJSON<{ keyHash: string }>(`mods/${m[1]}/.key.json`, { keyHash: "" });
        if (!secret.keyHash || secret.keyHash !== (await sha(String(key || "")))) return bad("Wrong key", 403);
        await deleteMod(m[1]); return json({ ok: true });
      }
      m = /^\/mods\/([a-z0-9-]+)\/([a-z0-9._-]+)$/.exec(p);
      if (m) {
        const e = ext(m[2]), type = IMAGE[e] || AUDIO[e];
        if (!type) return bad("Not found", 404);
        const blob = await store.get(`mods/${m[1]}/${m[2]}`);
        return blob ? serveBlob(blob, type, req) : bad("Not found", 404);
      }

      // pages + game files (kept in the bucket under site/)
      if (p === "/") p = "/index.html";
      if (p === "/admin") p = "/admin.html";
      if (p === "/waterfall") p = "/waterfall.html";
      const type = SITE_TYPES[ext(p)];
      if (!type || !/^\/[a-z0-9/._-]+$/.test(p) || p.includes("..")) return bad("Not found", 404);
      const body = await siteFile(p);
      if (body === null) return bad("Not found", 404);
      return new Response(body, { headers: { "content-type": type, "cache-control": p.endsWith(".html") ? "no-cache" : "public, max-age=300" } });
    } catch (e: any) {
      console.error(p, e);
      return bad("Something went wrong on the server", 500);
    }
  },
});
console.log("Ringfall is up");
