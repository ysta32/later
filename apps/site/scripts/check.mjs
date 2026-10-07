import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const BASE = "https://later-app.vercel.app";
const pages = [
  "",
  "pocket-alternative",
  "omnivore-alternative",
  "instapaper-alternative",
  "readwise-reader-alternative",
  "self-hosted-read-it-later",
];
const errors = [];
const err = (m) => errors.push(m);

const fileFor = (urlPath) => {
  const clean = urlPath.split("#")[0].split("?")[0];
  const p = path.join(pub, clean);
  if (clean.endsWith("/") || clean === "") return path.join(p, "index.html");
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  if (fs.existsSync(p + ".html")) return p + ".html";
  return path.join(p, "index.html");
};

for (const slug of pages) {
  const label = slug || "(home)";
  const file = path.join(pub, slug, "index.html");
  if (!fs.existsSync(file)) {
    err(`${label}: missing index.html`);
    continue;
  }
  const html = fs.readFileSync(file, "utf8");
  const title = html.match(/<title>([^<]+)<\/title>/);
  if (!title || !title[1].trim()) err(`${label}: missing title`);
  if (!/<meta name="description" content="[^"]{20,}"/.test(html)) err(`${label}: missing meta description`);
  const canon = html.match(/<link rel="canonical" href="([^"]+)"/);
  const want = `${BASE}/${slug ? slug + "/" : ""}`;
  if (!canon) err(`${label}: missing canonical`);
  else if (canon[1] !== want) err(`${label}: canonical ${canon[1]} != ${want}`);
  if ((html.match(/<h1[ >]/g) || []).length !== 1) err(`${label}: need exactly one h1`);
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  if (!blocks.length) err(`${label}: no JSON-LD`);
  let hasFaq = false;
  for (const b of blocks) {
    try {
      const j = JSON.parse(b[1]);
      if (j["@type"] === "FAQPage") hasFaq = true;
    } catch (e) {
      err(`${label}: invalid JSON-LD (${e.message})`);
    }
  }
  if (slug && !hasFaq) err(`${label}: missing FAQPage JSON-LD`);
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const u = m[1];
    if (/^(https?:|mailto:|#)/.test(u)) continue;
    if (!u.startsWith("/")) {
      err(`${label}: relative link ${u}`);
      continue;
    }
    if (!fs.existsSync(fileFor(u))) err(`${label}: broken link ${u}`);
  }
}

const sm = fs.readFileSync(path.join(pub, "sitemap.xml"), "utf8");
for (const slug of pages) {
  const loc = `${BASE}/${slug ? slug + "/" : ""}`;
  if (!sm.includes(`<loc>${loc}</loc>`)) err(`sitemap missing ${loc}`);
}
for (const f of ["robots.txt", "og.svg", "favicon.svg", "styles.css"])
  if (!fs.existsSync(path.join(pub, f))) err(`missing ${f}`);
try {
  const v = JSON.parse(fs.readFileSync(path.join(pub, "..", "vercel.json"), "utf8"));
  if (v.cleanUrls !== true) err("vercel.json cleanUrls");
} catch (e) {
  err("vercel.json invalid");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`site check ok: ${pages.length} pages`);
