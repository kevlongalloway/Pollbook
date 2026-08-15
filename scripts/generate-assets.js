#!/usr/bin/env node
/* Regenerates the raster brand assets in public/ from their two vector sources:
 *
 *   public/logo.svg           →  favicon.ico, apple-touch-icon.png, icon-192/512.png
 *   scripts/og-template.html  →  og-image.png (1200×630 link preview card)
 *
 * The committed PNGs are the build output — you only need to run this after
 * editing one of those two sources:
 *
 *   npm install --no-save playwright && node scripts/generate-assets.js
 *
 * Playwright is deliberately not a package.json dependency: it is a ~100MB
 * install needed once in a blue moon, never at deploy time. The script needs
 * network access the first time it runs (it pulls the webfonts from Google
 * Fonts and caches them under scripts/.font-cache/, which is gitignored).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const FONT_CACHE = path.join(__dirname, '.font-cache');

// Chrome UA — Google Fonts serves woff2 only to browsers it recognises.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const GOOGLE_FONTS_CSS =
  'https://fonts.googleapis.com/css2' +
  '?family=Archivo:wdth,wght@62..125,400..900' +
  '&family=Public+Sans:wght@400;600;700' +
  '&family=IBM+Plex+Mono:wght@400;500;600' +
  '&display=swap';

/* ---------------- fetching + font embedding ---------------- */

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          resolve(fetchUrl(new URL(res.headers.location, url).toString()));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GET ${url} → ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function cached(name, produce) {
  const file = path.join(FONT_CACHE, name);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const buf = await produce();
  fs.mkdirSync(FONT_CACHE, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/* Google Fonts splits each family into per-subset @font-face blocks. Keep the
 * latin ones, inline their woff2 as data URIs and drop the rest — the card is
 * English-only, and an inlined face can't fail to load mid-screenshot. */
async function buildFontCss() {
  const css = (await cached('fonts.css', () => fetchUrl(GOOGLE_FONTS_CSS))).toString('utf8');

  const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([\s\S]*?)\}/g)];
  const latin = blocks.filter(([, subset]) => subset === 'latin');
  if (!latin.length) throw new Error('no latin @font-face blocks in the Google Fonts CSS');

  const faces = [];
  for (const [, , body] of latin) {
    const url = body.match(/url\((https:[^)]+)\)/)[1];
    const name = url.split('/').pop();
    const woff2 = await cached(name, () => fetchUrl(url));
    faces.push(
      body
        .replace(/src:[\s\S]*?;/, `src: url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2');`)
        .replace(/unicode-range:[^;]+;/, '')
        .trim()
    );
    console.log(`  font ${name} (${(woff2.length / 1024).toFixed(0)} KB)`);
  }
  return faces.map((f) => `@font-face {\n${f}\n}`).join('\n');
}

/* ---------------- ICO container ---------------- */

/* .ico is a 6-byte header, then one 16-byte directory entry per size, then the
 * payloads. PNG payloads (rather than BMP) are understood by every browser
 * since IE11 and by Windows Vista+, and keep the file tiny. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette size
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // color planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/* ---------------- PNG post-processing ---------------- */

/* Chromium screenshots land as RGBA with a default compression level. These
 * are flat-colour graphics, so re-deflating the pixel data at max level buys a
 * meaningful chunk back — worth it on og-image.png, which link-preview
 * fetchers download on every share. */
function recompressPng(buf) {
  const chunks = [];
  let pos = 8; // skip signature
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else chunks.push({ type, data });
    pos += 12 + len;
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const deflated = zlib.deflateSync(raw, { level: 9, memLevel: 9, strategy: zlib.constants.Z_FILTERED });
  if (deflated.length >= Buffer.concat(idat).length) return buf; // no win, keep original

  const out = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const write = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    out.push(head, data, crc);
  };

  for (const c of chunks) {
    if (c.type === 'IEND') break;
    write(c.type, c.data);
    if (c.type === 'IHDR') write('IDAT', deflated);
  }
  write('IEND', Buffer.alloc(0));
  return Buffer.concat(out);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

/* ---------------- rendering ---------------- */

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error(
      'playwright is not installed. Run:\n' +
        '  npm install --no-save playwright && npx playwright install chromium'
    );
  }
}

async function main() {
  const { chromium } = loadPlaywright();

  console.log('Fetching webfonts…');
  const fontCss = await buildFontCss();

  const browser = await chromium.launch({
    args: ['--force-color-profile=srgb', '--disable-lcd-text'],
  });

  const write = (name, buf) => {
    fs.writeFileSync(path.join(PUBLIC, name), buf);
    console.log(`  public/${name.padEnd(22)} ${(buf.length / 1024).toFixed(1)} KB`);
  };

  try {
    /* --- og-image.png --------------------------------------------------- */
    console.log('\nRendering og-image.png…');
    const template = fs
      .readFileSync(path.join(__dirname, 'og-template.html'), 'utf8')
      .replace('/*__FONT_CSS__*/', fontCss);
    if (!template.includes('@font-face')) throw new Error('font CSS marker not found in og-template.html');

    const ogPage = await browser.newPage({ viewport: { width: 1200, height: 630 } });
    await ogPage.setContent(template, { waitUntil: 'load' });
    await ogPage.evaluate(() => document.fonts.ready);
    write('og-image.png', recompressPng(await ogPage.screenshot({ type: 'png' })));
    await ogPage.close();

    /* --- icons ---------------------------------------------------------- */
    console.log('\nRendering icons from public/logo.svg…');
    const svg = fs.readFileSync(path.join(PUBLIC, 'logo.svg'), 'utf8');
    const iconPage = await browser.newPage({ viewport: { width: 512, height: 512 } });

    const renderIcon = async (size) => {
      await iconPage.setViewportSize({ width: size, height: size });
      await iconPage.setContent(
        `<style>html,body{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
        { waitUntil: 'load' }
      );
      return recompressPng(await iconPage.screenshot({ type: 'png', omitBackground: true }));
    };

    write('icon-512.png', await renderIcon(512));
    write('icon-192.png', await renderIcon(192));
    write('apple-touch-icon.png', await renderIcon(180));

    const ico = [];
    for (const size of [16, 32, 48]) ico.push({ size, data: await renderIcon(size) });
    write('favicon.ico', buildIco(ico));

    await iconPage.close();
  } finally {
    await browser.close();
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
