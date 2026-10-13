// Generates the head of the white manoeuvre arrow drawn on the route ahead of
// a turn (assets/images/map/maneuver-head.png, at 1x, 2x and 3x): a white
// triangle with a dark outline, pointing up, its base on the image's centre
// line so the map can place that point at the end of the arrow's shaft and
// turn it with the road (components/MapboxDriveMap.tsx). Development only:
// the PNGs are committed; run this again only to change their look.
//
//   node scripts/generate-maneuver-head.mjs   (needs Playwright with Chromium)
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../assets/images/map");
const SIZE = 28; // points: the triangle fills the top half
const OUTLINE = "#0E2B5C";

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const scale of [1, 2, 3]) {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><style>
    html, body { margin: 0; background: transparent; }
  </style></head><body>
    <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 1.6 L25.4 14 L2.6 14 Z" fill="#FFFFFF" stroke="${OUTLINE}" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  </body></html>`);
  const suffix = scale === 1 ? "" : `@${scale}x`;
  await page.screenshot({ path: path.join(out, `maneuver-head${suffix}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
console.log("maneuver-head.png written at 1x, 2x and 3x");
