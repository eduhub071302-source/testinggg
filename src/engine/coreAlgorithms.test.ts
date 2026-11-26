import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32,
  createZipArchive,
  encodeIco,
  createPdfFromJpegs,
  extractEmbeddedJpegs,
  setPngDpi,
  setJpegDpi,
  parseExifMetadata,
  stripImageMetadata,
  injectEditableMetadata,
} from './binaryCodecs';
import {
  quantizePixels,
  extractColorPalette,
  encodeBlurHash,
  solveHomography,
  detectTrimBounds,
  minifySvg,
  svgToJsx,
  svgToDataUri,
  applyRenamePattern,
  packSprites,
  imageDataToAscii,
  computePixelDiff,
  generateResponsiveHtml,
} from './dspAlgorithms';
import { MemoryGovernor } from './memoryGovernor';
import { TOOLS_CATALOG } from '../data/toolsCatalog';

test('catalog contains all 80 numbered tools uniquely', () => {
  assert.equal(TOOLS_CATALOG.length, 80);
  const numbers = new Set(TOOLS_CATALOG.map((t) => t.number));
  const ids = new Set(TOOLS_CATALOG.map((t) => t.id));
  assert.equal(numbers.size, 80);
  assert.equal(ids.size, 80);
  assert.equal(Math.min(...numbers), 1);
  assert.equal(Math.max(...numbers), 80);
});

test('PKZIP archive builder creates valid headers, CRC32 and EOCD signature', () => {
  const enc = new TextEncoder();
  const payloadA = enc.encode('hello chromaforge');
  const payloadB = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const zip = createZipArchive([
    { name: 'a.txt', data: payloadA },
    { name: 'nested/b.bin', data: payloadB },
  ]);

  // Local file header PK\x03\x04
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);

  // End of Central Directory PK\x05\x06 at last 22 bytes
  const eocdOffset = zip.length - 22;
  assert.equal(zip[eocdOffset], 0x50);
  assert.equal(zip[eocdOffset + 1], 0x4b);
  assert.equal(zip[eocdOffset + 2], 0x05);
  assert.equal(zip[eocdOffset + 3], 0x06);
  // Entry count = 2
  assert.equal(zip[eocdOffset + 8], 2);
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('multi-resolution ICO encoder embeds 16/32/48/256 frames accurately', () => {
  const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
  const ico = encodeIco([
    { width: 16, height: 16, pngBytes: dummyPng },
    { width: 32, height: 32, pngBytes: dummyPng },
    { width: 256, height: 256, pngBytes: dummyPng },
  ]);
  // ICONDIR type=1, count=3
  assert.equal(ico[2], 1);
  assert.equal(ico[4], 3);
  // First entry 16x16, third entry 256 encoded as 0
  assert.equal(ico[6], 16);
  assert.equal(ico[6 + 16], 32);
  assert.equal(ico[6 + 32], 0);
});

test('PDF 1.4 builder and embedded JPEG extractor round-trip cleanly', () => {
  const fakeJpeg = new Uint8Array(2500);
  fakeJpeg[0] = 0xff;
  fakeJpeg[1] = 0xd8;
  fakeJpeg[2] = 0xff;
  fakeJpeg[3] = 0xda; // SOS
  fakeJpeg[fakeJpeg.length - 2] = 0xff;
  fakeJpeg[fakeJpeg.length - 1] = 0xd9; // EOI

  const pdf = createPdfFromJpegs(
    [{ jpegBytes: fakeJpeg, width: 800, height: 600 }],
    { pageSize: 'a4', orientation: 'portrait', marginPt: 24 }
  );
  const textHeader = new TextDecoder().decode(pdf.slice(0, 8));
  assert.equal(textHeader, '%PDF-1.4');

  const extracted = extractEmbeddedJpegs(pdf, 1024);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].length, fakeJpeg.length);
});

test('PNG pHYs DPI injector and JPEG DPI/metadata round-trip without corruption', () => {
  // Minimal valid PNG: signature + IHDR + IEND
  const pngSig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array([
    0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 100, 0, 0, 0, 80, 8, 2, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const iend = new Uint8Array([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
  const minPng = new Uint8Array(pngSig.length + ihdr.length + iend.length);
  minPng.set(pngSig, 0);
  minPng.set(ihdr, pngSig.length);
  minPng.set(iend, pngSig.length + ihdr.length);

  const patchedPng = setPngDpi(minPng, 300);
  const parsedPng = parseExifMetadata(patchedPng);
  assert.equal(parsedPng.dpiX, 300);
  assert.equal(parsedPng.width, 100);
  assert.equal(parsedPng.height, 80);

  // Minimal JPEG + editable metadata + scrubber
  const minJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  const withDpi = setJpegDpi(minJpeg, 600);
  const withMeta = injectEditableMetadata(withDpi, {
    copyright: '2026 ChromaForge',
    artist: 'Studio Lab',
    description: 'Master proof',
  });
  const parsedJpg = parseExifMetadata(withMeta);
  assert.equal(parsedJpg.dpiX, 600);
  assert.equal(parsedJpg.copyright, '2026 ChromaForge');
  assert.equal(parsedJpg.artist, 'Studio Lab');

  const { cleaned, removedBytes } = stripImageMetadata(withMeta);
  assert.ok(removedBytes > 0);
  const afterScrub = parseExifMetadata(cleaned);
  assert.equal(afterScrub.copyright, undefined);
});

test('color quantizer, palette extractor, BlurHash, and ASCII converter produce valid outputs', () => {
  const w = 16;
  const h = 16;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = x < 8 ? 220 : 24;
      rgba[i + 1] = y < 8 ? 60 : 180;
      rgba[i + 2] = 240;
      rgba[i + 3] = 255;
    }
  }

  const q = quantizePixels(rgba, w, h, 4, true);
  assert.equal(q.rgba.length, rgba.length);
  assert.ok(q.palette.length <= 4);

  const pal = extractColorPalette(rgba, w, h, 4);
  assert.ok(pal.colors.length >= 2);
  assert.ok(pal.cssVariables.includes('--palette-1:'));

  const hash = encodeBlurHash(rgba, w, h, 4, 3);
  assert.equal(hash.length, 1 + 1 + 4 + (4 * 3 - 1) * 2);

  const ascii = imageDataToAscii(rgba, w, h);
  assert.equal(ascii.text.split('\n').length, h);
});

test('homography solver maps identity and projective corners accurately', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];
  const H = solveHomography(pts, pts);
  assert.ok(Math.abs(H[0] - 1) < 1e-6);
  assert.ok(Math.abs(H[4] - 1) < 1e-6);
  assert.ok(Math.abs(H[8] - 1) < 1e-6);
});

test('auto-trim detects exact subject bounding box inside solid margin', () => {
  const w = 20;
  const h = 20;
  const rgba = new Uint8ClampedArray(w * h * 4);
  // Fill pure white background
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = 255;
    rgba[i + 1] = 255;
    rgba[i + 2] = 255;
    rgba[i + 3] = 255;
  }
  // Draw dark subject at (5,4) to (12,14)
  for (let y = 4; y <= 14; y++) {
    for (let x = 5; x <= 12; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = 20;
      rgba[i + 1] = 20;
      rgba[i + 2] = 20;
    }
  }
  const box = detectTrimBounds(rgba, w, h, 10);
  assert.deepEqual(box, { x: 5, y: 4, w: 8, h: 11 });
});

test('SVG minifier, JSX converter, pattern renamer, sprite packer, pixel diff & srcset generator work', () => {
  const rawSvg = `<!-- comment --><svg xmlns="http://www.w3.org/2000/svg" class="icon" stroke-width="2.12345"><path d="M0 0 L10.5555 10.1111" /></svg>`;
  const { minified, savedPercent } = minifySvg(rawSvg, 2);
  assert.ok(!minified.includes('comment'));
  assert.ok(savedPercent > 10);

  const jsx = svgToJsx(rawSvg, 'BrandMark');
  assert.ok(jsx.includes('strokeWidth='));
  assert.ok(jsx.includes('className='));
  assert.ok(svgToDataUri(rawSvg).startsWith('url("data:image/svg+xml,'));

  const renamed = applyRenamePattern('shirt-blue-{index:2}.{ext}', {
    originalName: 'IMG_001.JPG',
    index: 0,
    ext: 'webp',
  });
  assert.equal(renamed, 'shirt-blue-01.webp');

  const packed = packSprites([
    { name: 'a.png', width: 32, height: 32 },
    { name: 'b.png', width: 64, height: 32 },
  ]);
  assert.equal(packed.frames.length, 2);
  assert.ok(packed.css.includes('.sprite-a'));

  const imgA = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]);
  const imgB = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]);
  const diff = computePixelDiff(imgA, imgB, 2, 1, 10);
  assert.equal(diff.diffPixels, 1);
  assert.equal(diff.diffPercent, 50);

  const html = generateResponsiveHtml('hero.jpg', [320, 640], ['webp', 'jpg']);
  assert.ok(html.includes('<picture>'));
  assert.ok(html.includes('hero-320w.webp 320w'));
});

test('MemoryGovernor enforces strict 300MB budget with automatic LRU eviction', () => {
  const gov = new MemoryGovernor(300, 210);
  const MB = 1024 * 1024;
  let evictedA = false;

  gov.registerObjectUrl('a', 'mem://a', 120 * MB, false, () => {
    evictedA = true;
  });
  gov.registerObjectUrl('b', 'mem://b', 120 * MB, false);
  // Adding 120MB crosses 210MB soft cap -> 'a' must be evicted automatically
  assert.equal(evictedA, true);
  assert.ok(gov.getTrackedBytes() <= 300 * MB);
  assert.ok(gov.getEvictionCount() >= 1);
});
