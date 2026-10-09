import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Cuts the mark and the wordmark out of the logo sheet as white-on-transparent
// images (the panel tints them to the DevTools theme), and draws the extension
// icons from the mark. Run after changing the logo: node packages/extension/brand.mjs
const here = dirname(fileURLToPath(import.meta.url));
const sheet = readFileSync(join(here, 'brand/logo-sheet.webp')).toString('base64');
const out = join(here, 'static');

// Where the large white-on-navy version sits on the sheet.
const MARK = { x: 570, y: 112, width: 384, height: 284 };
const WORDMARK = { x: 494, y: 396, width: 550, height: 104 };
const ICON_SIZES = [16, 32, 48, 128];
// The k's stem is the b's (x 501-514 from row 419) moved 201px right; above its arms nothing else is there.
const B_STEM = { x: 499 };
const K_STEM = { x: 690, y: 396, width: 28, height: 40, shift: 201 };
// The rows of the o in "hound" with the blot, and the o's middle.
const O_LETTER = { x: 812, y: 455, width: 58, height: 24, centerX: 840 };

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const files = await page.evaluate(
    async ({ sheet, MARK, WORDMARK, ICON_SIZES, B_STEM, K_STEM, O_LETTER }) => {
      const img = new Image();
      img.src = `data:image/webp;base64,${sheet}`;
      await img.decode();
      const src = new OffscreenCanvas(img.width, img.height);
      const sg = src.getContext('2d');
      sg.drawImage(img, 0, 0);

      // Background and ink levels, measured on the sheet itself.
      const at = (x, y) => sg.getImageData(x, y, 1, 1).data;
      const bg = at(20, 20);
      const bgLum = (bg[0] + bg[1] + bg[2]) / 3;
      const inkLum = 240;

      // The wordmark's k has a wedge for a stem that pokes above the other letters. Give it a
      // plain stem like the b's: same stroke and height, copied from the b onto the k.
      sg.fillStyle = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
      sg.fillRect(K_STEM.x, K_STEM.y, K_STEM.width, K_STEM.height);
      sg.putImageData(
        sg.getImageData(B_STEM.x, K_STEM.y, K_STEM.width, K_STEM.height),
        B_STEM.x + K_STEM.shift,
        K_STEM.y,
      );

      // A grey blot sits in the left half of the o in "hound"; the o is symmetric, so mirror its clean right half over it.
      const o = sg.getImageData(O_LETTER.x, O_LETTER.y, O_LETTER.width, O_LETTER.height);
      const ox = O_LETTER.centerX - O_LETTER.x;
      for (let y = 0; y < O_LETTER.height; y++) {
        for (let x = 0; x < ox; x++) {
          const from = (y * O_LETTER.width + (2 * ox - x)) * 4;
          const to = (y * O_LETTER.width + x) * 4;
          for (let k = 0; k < 4; k++) o.data[to + k] = o.data[from + k];
        }
      }
      sg.putImageData(o, O_LETTER.x, O_LETTER.y);

      /** The white shape in a region, as white with alpha from how bright each pixel is. */
      const cut = (r) => {
        const data = sg.getImageData(r.x, r.y, r.width, r.height);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const lum = (px[i] + px[i + 1] + px[i + 2]) / 3;
          const a = Math.max(0, Math.min(1, (lum - bgLum - 12) / (inkLum - bgLum - 12)));
          px[i] = px[i + 1] = px[i + 2] = 255;
          px[i + 3] = Math.round(a * 255);
        }
        const c = new OffscreenCanvas(r.width, r.height);
        c.getContext('2d').putImageData(data, 0, 0);
        return c;
      };

      const toDataUrl = async (canvas) => {
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
      };

      const mark = cut(MARK);
      const wordmark = cut(WORDMARK);
      const result = {
        'brand/mark.png': await toDataUrl(mark),
        'brand/wordmark.png': await toDataUrl(wordmark),
      };

      for (const size of ICON_SIZES) {
        const c = new OffscreenCanvas(size, size);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        const r = size * 0.22;
        g.fillStyle = `rgb(${bg[0]}, ${bg[1]}, ${bg[2]})`;
        g.beginPath();
        g.roundRect(0, 0, size, size, r);
        g.fill();
        // Small icons get less padding, so the hound stays readable.
        const pad = size <= 16 ? 0.06 : size <= 32 ? 0.1 : 0.14;
        const w = size * (1 - 2 * pad);
        const h = (w * MARK.height) / MARK.width;
        g.drawImage(mark, (size - w) / 2, (size - h) / 2 + size * 0.02, w, h);
        result[`icons/${size}.png`] = await toDataUrl(c);
      }
      return result;
    },
    { sheet, MARK, WORDMARK, ICON_SIZES, B_STEM, K_STEM, O_LETTER },
  );
  for (const [name, base64] of Object.entries(files)) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), Buffer.from(base64, 'base64'));
  }
} finally {
  await browser.close();
}
