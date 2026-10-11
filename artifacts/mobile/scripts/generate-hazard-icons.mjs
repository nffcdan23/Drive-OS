// Generates the road hazard map markers (assets/images/map/hazard-*.png, at
// 1x, 2x and 3x) from the Ionicons font the app already ships, so the map
// draws them as a symbol layer beneath the location arrow. Development only:
// the PNGs are committed; run this again only to change their look.
//
//   node scripts/generate-hazard-icons.mjs   (needs Playwright with Chromium)
//
// Keep the kinds and colours in step with lib/hazards/model.ts.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const fontDir = path.join(root, "node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons");
const font = readFileSync(path.join(fontDir, "Fonts/Ionicons.ttf")).toString("base64");
const glyphs = JSON.parse(readFileSync(path.join(fontDir, "glyphmaps/Ionicons.json"), "utf8"));

const KINDS = {
  accident: { icon: "car-sport", color: "#E5484D" },
  hazard: { icon: "warning", color: "#F59E0B" },
  broken_down: { icon: "build", color: "#F97316" },
  roadworks: { icon: "construct", color: "#D9A50B" },
  flooding: { icon: "water", color: "#3B82F6" },
  police: { icon: "shield", color: "#7C5CFA" },
};
const SIZE = 30; // points, including the shadow margin

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
for (const [kind, { icon, color }] of Object.entries(KINDS)) {
  for (const scale of [1, 2, 3]) {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: scale });
    await page.setContent(`<!doctype html><html><head><style>
      @font-face { font-family: Ionicons; src: url(data:font/ttf;base64,${font}); }
      html, body { margin: 0; background: transparent; }
      .b { position: absolute; left: 3px; top: 2px; width: 24px; height: 24px; border-radius: 12px; box-sizing: border-box;
           background: ${color}; border: 1.5px solid rgba(255,255,255,0.92);
           box-shadow: 0 1px 2px rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; }
      .g { font-family: Ionicons; font-size: 13px; line-height: 13px; color: #fff; }
    </style></head><body><div class="b"><span class="g">&#${glyphs[icon]};</span></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    const suffix = scale === 1 ? "" : `@${scale}x`;
    await page.screenshot({ path: path.join(root, `assets/images/map/hazard-${kind.replace("_", "-")}${suffix}.png`), omitBackground: true });
    await page.close();
  }
}
await browser.close();
console.log("hazard icons written");
