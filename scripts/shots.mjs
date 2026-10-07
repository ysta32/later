// Usage: node scripts/shots.mjs <baseUrl> <outDir> <path1,path2,...> [--auth email:password]
// Screenshots each path at 375/768/1280/1920 in light and dark.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const [base, out, pathsArg, ...rest] = process.argv.slice(2);
const authIdx = rest.indexOf("--auth");
const auth = authIdx >= 0 ? rest[authIdx + 1].split(":") : null;
const widths = [375, 768, 1280, 1920];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const ctx = await browser.newContext({ colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  if (auth) {
    const r = await page.request.post(base + "/api/auth/login", {
      data: { email: auth[0], password: auth[1] },
    });
    if (!r.ok())
      await page.request.post(base + "/api/auth/signup", { data: { email: auth[0], password: auth[1] } });
  }
  for (const p of pathsArg.split(",")) {
    for (const w of widths) {
      await page.setViewportSize({ width: w, height: Math.round(w < 800 ? 812 : w * 0.5625) });
      await page.goto(base + p, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const name = (p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home") + `-${w}-${scheme}.png`;
      await page.screenshot({ path: `${out}/${name}`, fullPage: true });
    }
  }
  await ctx.close();
}
await browser.close();
console.log("shots done", out);
