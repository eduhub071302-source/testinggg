import { PaletteColor, PerspectiveQuad } from '../types/studio';

/**
 * Pure TypeScript Image DSP, Color Science, Geometry & Developer Algorithms
 * Zero DOM dependencies — 100% deterministic and unit-testable.
 */

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// ---------------------------------------------------------------------------
// 1. Median-Cut Color Quantization + Floyd-Steinberg Dithering (Features 3 & 48)
// ---------------------------------------------------------------------------
interface ColorBox {
  colors: Array<[number, number, number, number]>;
}

export function quantizePixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  maxColors = 64,
  dither = true
): { rgba: Uint8ClampedArray; palette: Array<[number, number, number]> } {
  const targetColors = Math.max(2, Math.min(256, Math.round(maxColors)));
  const sampleStep = Math.max(1, Math.floor((width * height) / 16000));
  const samples: Array<[number, number, number, number]> = [];

  for (let i = 0; i < width * height; i += sampleStep) {
    const idx = i * 4;
    if (rgba[idx + 3] < 16) continue;
    samples.push([rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]]);
  }

  if (samples.length === 0) {
    return { rgba: new Uint8ClampedArray(rgba), palette: [[0, 0, 0]] };
  }

  const boxes: ColorBox[] = [{ colors: samples }];

  while (boxes.length < targetColors) {
    // Pick box with largest color range
    let bestIdx = -1;
    let bestRange = -1;
    let bestChannel = 0;

    for (let b = 0; b < boxes.length; b++) {
      const list = boxes[b].colors;
      if (list.length < 2) continue;
      for (let ch = 0; ch < 3; ch++) {
        let min = 255;
        let max = 0;
        for (let k = 0; k < list.length; k++) {
          const v = list[k][ch];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        const range = max - min;
        if (range > bestRange) {
          bestRange = range;
          bestIdx = b;
          bestChannel = ch;
        }
      }
    }

    if (bestIdx === -1 || bestRange <= 1) break;
    const box = boxes.splice(bestIdx, 1)[0];
    box.colors.sort((a, b) => a[bestChannel] - b[bestChannel]);
    const mid = Math.floor(box.colors.length / 2);
    boxes.push({ colors: box.colors.slice(0, mid) }, { colors: box.colors.slice(mid) });
  }

  const palette: Array<[number, number, number]> = boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const c of box.colors) {
      r += c[0];
      g += c[1];
      b += c[2];
    }
    const n = Math.max(1, box.colors.length);
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });

  const work = new Float32Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) work[i] = rgba[i];

  const out = new Uint8ClampedArray(rgba.length);
  const nearest = (r: number, g: number, b: number) => {
    let best = palette[0];
    let bestDist = Infinity;
    for (let i = 0; i < palette.length; i++) {
      const p = palette[i];
      const dr = r - p[0];
      const dg = g - p[1];
      const db = b - p[2];
      const dist = dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = rgba[idx + 3];
      out[idx + 3] = a;
      if (a < 16) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        continue;
      }

      const oldR = work[idx];
      const oldG = work[idx + 1];
      const oldB = work[idx + 2];
      const [nr, ng, nb] = nearest(oldR, oldG, oldB);
      out[idx] = nr;
      out[idx + 1] = ng;
      out[idx + 2] = nb;

      if (dither) {
        const er = oldR - nr;
        const eg = oldG - ng;
        const eb = oldB - nb;
        const distribute = (dx: number, dy: number, factor: number) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) return;
          const nIdx = (ny * width + nx) * 4;
          work[nIdx] += er * factor;
          work[nIdx + 1] += eg * factor;
          work[nIdx + 2] += eb * factor;
        };
        distribute(1, 0, 7 / 16);
        distribute(-1, 1, 3 / 16);
        distribute(0, 1, 5 / 16);
        distribute(1, 1, 1 / 16);
      }
    }
  }

  return { rgba: out, palette };
}

// ---------------------------------------------------------------------------
// 2. Dominant Color Palette & CSS Variable Extractor (Feature 72)
// ---------------------------------------------------------------------------
export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => clampByte(v).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

export function rgbToHsl(r: number, g: number, b: number): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h *= 60;
  }

  return `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
}

export function extractColorPalette(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  count = 6
): { colors: PaletteColor[]; cssVariables: string } {
  const { palette } = quantizePixels(rgba, width, height, Math.max(2, Math.min(12, count)), false);
  const counts = new Uint32Array(palette.length);
  const step = Math.max(1, Math.floor((width * height) / 12000));
  let total = 0;

  for (let i = 0; i < width * height; i += step) {
    const idx = i * 4;
    if (rgba[idx + 3] < 32) continue;
    const r = rgba[idx];
    const g = rgba[idx + 1];
    const b = rgba[idx + 2];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let p = 0; p < palette.length; p++) {
      const dr = r - palette[p][0];
      const dg = g - palette[p][1];
      const db = b - palette[p][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = p;
      }
    }
    counts[bestIdx]++;
    total++;
  }

  const colors: PaletteColor[] = palette
    .map(([r, g, b], idx) => ({
      hex: rgbToHex(r, g, b),
      rgb: `rgb(${r}, ${g}, ${b})`,
      hsl: rgbToHsl(r, g, b),
      percent: total > 0 ? Math.round((counts[idx] / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.percent - a.percent);

  const cssLines = colors.map((c, idx) => `  --palette-${idx + 1}: ${c.hex}; /* ${c.percent}% */`);
  const cssVariables = `:root {\n${cssLines.join('\n')}\n}`;
  return { colors, cssVariables };
}

// ---------------------------------------------------------------------------
// 3. Genuine Base83 DCT BlurHash Encoder (Feature 70)
// ---------------------------------------------------------------------------
const BASE83_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function encodeBase83(value: number, length: number): string {
  let result = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / Math.pow(83, length - i)) % 83;
    result += BASE83_CHARS[Math.max(0, Math.min(82, digit))];
  }
  return result;
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return v <= 0.0031308 ? Math.round(v * 12.92 * 255 + 0.5) : Math.round((1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5);
}

function signPow(val: number, exp: number): number {
  return Math.sign(val) * Math.pow(Math.abs(val), exp);
}

export function encodeBlurHash(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  componentX = 4,
  componentY = 3
): string {
  const cx = Math.max(1, Math.min(9, componentX));
  const cy = Math.max(1, Math.min(9, componentY));

  const factors: Array<[number, number, number]> = [];
  for (let y = 0; y < cy; y++) {
    for (let x = 0; x < cx; x++) {
      const normalisation = x === 0 && y === 0 ? 1 : 2;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < height; j++) {
        const cosY = Math.cos((Math.PI * y * j) / height);
        for (let i = 0; i < width; i++) {
          const basis = normalisation * Math.cos((Math.PI * x * i) / width) * cosY;
          const idx = (j * width + i) * 4;
          r += basis * srgbToLinear(rgba[idx]);
          g += basis * srgbToLinear(rgba[idx + 1]);
          b += basis * srgbToLinear(rgba[idx + 2]);
        }
      }
      const scale = 1 / (width * height);
      factors.push([r * scale, g * scale, b * scale]);
    }
  }

  const dc = factors[0];
  const ac = factors.slice(1);
  let hash = encodeBase83(cx - 1 + (cy - 1) * 9, 1);

  let maxAc = 0;
  for (const f of ac) {
    maxAc = Math.max(maxAc, Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]));
  }

  let quantMax = 0;
  let actualMax = 1;
  if (ac.length > 0) {
    quantMax = Math.max(0, Math.min(82, Math.floor(maxAc * 166 - 0.5)));
    actualMax = (quantMax + 1) / 166;
    hash += encodeBase83(quantMax, 1);
  } else {
    hash += encodeBase83(0, 1);
  }

  const dcInt = (linearToSrgb(dc[0]) << 16) + (linearToSrgb(dc[1]) << 8) + linearToSrgb(dc[2]);
  hash += encodeBase83(dcInt, 4);

  for (const f of ac) {
    const qR = Math.max(0, Math.min(18, Math.floor(signPow(f[0] / actualMax, 0.5) * 9 + 9.5)));
    const qG = Math.max(0, Math.min(18, Math.floor(signPow(f[1] / actualMax, 0.5) * 9 + 9.5)));
    const qB = Math.max(0, Math.min(18, Math.floor(signPow(f[2] / actualMax, 0.5) * 9 + 9.5)));
    hash += encodeBase83(qR * 19 * 19 + qG * 19 + qB, 2);
  }

  return hash;
}

// ---------------------------------------------------------------------------
// 4. Homography 3x3 Projective Deskew Solver (Feature 30)
// ---------------------------------------------------------------------------
export function solveHomography(
  srcPts: Array<{ x: number; y: number }>,
  dstPts: Array<{ x: number; y: number }>
): number[] {
  // Solve A * h = b for 8 unknowns using Gaussian elimination with partial pivoting
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = srcPts[i];
    const { x: u, y: v } = dstPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivotRow][col])) {
        pivotRow = row;
      }
    }
    [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
    [b[col], b[pivotRow]] = [b[pivotRow], b[col]];

    const pivot = A[col][col];
    if (Math.abs(pivot) < 1e-10) continue;

    for (let j = col; j < n; j++) A[col][j] /= pivot;
    b[col] /= pivot;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      for (let j = col; j < n; j++) A[row][j] -= factor * A[col][j];
      b[row] -= factor * b[col];
    }
  }

  return [...b, 1];
}

export function warpPerspectiveRgba(
  srcRgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  quad: PerspectiveQuad,
  outW: number,
  outH: number
): Uint8ClampedArray {
  // Map destination rectangle corners -> source normalized quad corners
  const dstCorners = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];
  const srcCorners = [
    { x: quad.tl.x * srcW, y: quad.tl.y * srcH },
    { x: quad.tr.x * srcW, y: quad.tr.y * srcH },
    { x: quad.br.x * srcW, y: quad.br.y * srcH },
    { x: quad.bl.x * srcW, y: quad.bl.y * srcH },
  ];

  const H = solveHomography(dstCorners, srcCorners);
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const denom = H[6] * x + H[7] * y + H[8];
      if (Math.abs(denom) < 1e-8) continue;
      const sx = (H[0] * x + H[1] * y + H[2]) / denom;
      const sy = (H[3] * x + H[4] * y + H[5]) / denom;

      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) continue;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x0 + 1) * 4;
      const i01 = ((y0 + 1) * srcW + x0) * 4;
      const i11 = ((y0 + 1) * srcW + x0 + 1) * 4;
      const dstIdx = (y * outW + x) * 4;

      for (let ch = 0; ch < 4; ch++) {
        const top = srcRgba[i00 + ch] * (1 - fx) + srcRgba[i10 + ch] * fx;
        const bot = srcRgba[i01 + ch] * (1 - fx) + srcRgba[i11 + ch] * fx;
        out[dstIdx + ch] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 5. Auto-Trim Whitespace Bounding Box Detector (Feature 31)
// ---------------------------------------------------------------------------
export function detectTrimBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 18
): { x: number; y: number; w: number; h: number } {
  // Sample top-left corner pixel as background reference
  const bgR = rgba[0];
  const bgG = rgba[1];
  const bgB = rgba[2];
  const bgA = rgba[3];
  const checkTransparent = bgA < 16;

  const isBackground = (idx: number): boolean => {
    const a = rgba[idx + 3];
    if (checkTransparent) return a <= tolerance;
    if (a < 16) return true;
    return (
      Math.abs(rgba[idx] - bgR) <= tolerance &&
      Math.abs(rgba[idx + 1] - bgG) <= tolerance &&
      Math.abs(rgba[idx + 2] - bgB) <= tolerance
    );
  };

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBackground((y * width + x) * 4)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, w: width, h: height };
  }

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------
// 6. SVG Minifier & SVG to JSX / Data URI (Features 65 & 66)
// ---------------------------------------------------------------------------
export function minifySvg(svgText: string, precision = 2): { minified: string; savedPercent: number } {
  const originalLen = svgText.length;
  let out = svgText
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, '')
    .replace(/<title[\s\S]*?<\/title>/gi, '')
    .replace(/<desc[\s\S]*?<\/desc>/gi, '')
    .replace(/\s(xmlns:(?:inkscape|sodipodi|sketch|xlink|serif|dc|cc|rdf)|data-name)="[^"]*"/gi, '')
    .replace(/\s(?:inkscape|sodipodi):[a-z-]+="[^"]*"/gi, '')
    .replace(/(\d+\.\d+)/g, (match) => {
      const n = Number(match);
      return Number.isFinite(n) ? Number(n.toFixed(precision)).toString() : match;
    })
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const savedPercent = originalLen > 0 ? Math.max(0, Math.round(((originalLen - out.length) / originalLen) * 1000) / 10) : 0;
  return { minified: out, savedPercent };
}

export function svgToJsx(svgText: string, componentName = 'VectorIcon'): string {
  const { minified } = minifySvg(svgText);
  const attrMap: Record<string, string> = {
    'class=': 'className=',
    'stroke-width=': 'strokeWidth=',
    'stroke-linecap=': 'strokeLinecap=',
    'stroke-linejoin=': 'strokeLinejoin=',
    'stroke-dasharray=': 'strokeDasharray=',
    'stroke-dashoffset=': 'strokeDashoffset=',
    'stroke-opacity=': 'strokeOpacity=',
    'fill-rule=': 'fillRule=',
    'clip-rule=': 'clipRule=',
    'clip-path=': 'clipPath=',
    'fill-opacity=': 'fillOpacity=',
    'stop-color=': 'stopColor=',
    'stop-opacity=': 'stopOpacity=',
    'font-family=': 'fontFamily=',
    'font-size=': 'fontSize=',
    'font-weight=': 'fontWeight=',
    'text-anchor=': 'textAnchor=',
  };

  let jsxBody = minified;
  for (const [k, v] of Object.entries(attrMap)) {
    jsxBody = jsxBody.split(k).join(v);
  }
  jsxBody = jsxBody.replace(/<svg\b([^>]*)>/, '<svg$1 {...props}>');

  return `import React from 'react';\n\nexport function ${componentName}(props: React.SVGProps<SVGSVGElement>) {\n  return (\n    ${jsxBody}\n  );\n}\n`;
}

export function svgToDataUri(svgText: string): string {
  const { minified } = minifySvg(svgText);
  const encoded = encodeURIComponent(minified)
    .replace(/%20/g, ' ')
    .replace(/%3D/g, '=')
    .replace(/%3A/g, ':')
    .replace(/%2F/g, '/')
    .replace(/%22/g, "'");
  return `url("data:image/svg+xml,${encoded}")`;
}

// ---------------------------------------------------------------------------
// 7. Bulk Pattern Renamer (Feature 61)
// ---------------------------------------------------------------------------
export function applyRenamePattern(
  template: string,
  meta: { originalName: string; index: number; ext: string; width?: number; height?: number }
): string {
  const baseName = meta.originalName.replace(/\.[^.]+$/, '');
  const cleanExt = meta.ext.replace(/^\./, '');
  const dateStr = new Date().toISOString().slice(0, 10);

  let out = template
    .replace(/\{name\}/g, baseName)
    .replace(/\{ext\}/g, cleanExt)
    .replace(/\{width\}/g, String(meta.width ?? 0))
    .replace(/\{height\}/g, String(meta.height ?? 0))
    .replace(/\{date\}/g, dateStr)
    .replace(/\{index:(\d+)\}/g, (_, pad) => String(meta.index + 1).padStart(Number(pad), '0'))
    .replace(/\{index\}/g, String(meta.index + 1));

  if (!out.includes('.')) {
    out = `${out}.${cleanExt}`;
  }
  return out.replace(/[^a-zA-Z0-9._-]/g, '-');
}

// ---------------------------------------------------------------------------
// 8. Sprite Sheet Shelf Packer (Feature 68)
// ---------------------------------------------------------------------------
export interface SpriteRectInput {
  name: string;
  width: number;
  height: number;
}

export interface PackedSpriteFrame {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function packSprites(
  items: SpriteRectInput[],
  padding = 4
): { width: number; height: number; frames: PackedSpriteFrame[]; css: string; json: string } {
  const sorted = [...items].sort((a, b) => b.height - a.height || b.width - a.width);
  const totalArea = sorted.reduce((acc, s) => acc + (s.width + padding) * (s.height + padding), 0);
  const maxItemW = sorted.reduce((m, s) => Math.max(m, s.width + padding * 2), 64);
  const targetWidth = Math.max(maxItemW, Math.ceil(Math.sqrt(totalArea) * 1.15));

  let cursorX = padding;
  let cursorY = padding;
  let rowHeight = 0;
  let sheetW = 0;
  const frames: PackedSpriteFrame[] = [];

  for (const item of sorted) {
    if (cursorX + item.width + padding > targetWidth && cursorX > padding) {
      cursorX = padding;
      cursorY += rowHeight + padding;
      rowHeight = 0;
    }
    frames.push({ name: item.name, x: cursorX, y: cursorY, width: item.width, height: item.height });
    cursorX += item.width + padding;
    rowHeight = Math.max(rowHeight, item.height);
    sheetW = Math.max(sheetW, cursorX);
  }

  const sheetH = Math.max(1, cursorY + rowHeight + padding);
  const cssLines = [
    `.sprite { background-image: url("sprite-sheet.png"); background-repeat: no-repeat; display: inline-block; }`,
    ...frames.map((f) => {
      const cls = f.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      return `.sprite-${cls} { width: ${f.width}px; height: ${f.height}px; background-position: -${f.x}px -${f.y}px; }`;
    }),
  ];

  const atlas = {
    meta: { image: 'sprite-sheet.png', size: { w: sheetW, h: sheetH }, scale: '1' },
    frames: Object.fromEntries(
      frames.map((f) => [f.name, { frame: { x: f.x, y: f.y, w: f.width, h: f.height } }])
    ),
  };

  return {
    width: sheetW,
    height: sheetH,
    frames,
    css: cssLines.join('\n'),
    json: JSON.stringify(atlas, null, 2),
  };
}

// ---------------------------------------------------------------------------
// 9. Image to ASCII Art Converter (Feature 74)
// ---------------------------------------------------------------------------
export function imageDataToAscii(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  ramp = '@%#*+=-:. ',
  invert = false
): { text: string; html: string } {
  const chars = invert ? ramp.split('').reverse().join('') : ramp;
  const lines: string[] = [];
  const htmlLines: string[] = [];

  for (let y = 0; y < height; y++) {
    let line = '';
    let htmlLine = '';
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx];
      const g = rgba[idx + 1];
      const b = rgba[idx + 2];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      const charIdx = Math.min(chars.length - 1, Math.floor(lum * chars.length));
      const ch = chars[charIdx];
      line += ch;
      const safeCh = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
      htmlLine += `<span style="color:rgb(${r},${g},${b})">${safeCh}</span>`;
    }
    lines.push(line);
    htmlLines.push(htmlLine);
  }

  return { text: lines.join('\n'), html: htmlLines.join('\n') };
}

// ---------------------------------------------------------------------------
// 10. Pixel Diff / Layout Regression Comparator (Feature 71)
// ---------------------------------------------------------------------------
export function computePixelDiff(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 12
): { diffRgba: Uint8ClampedArray; diffPixels: number; diffPercent: number } {
  const totalPixels = width * height;
  const diffRgba = new Uint8ClampedArray(totalPixels * 4);
  let diffPixels = 0;

  for (let i = 0; i < totalPixels; i++) {
    const idx = i * 4;
    const dr = Math.abs(a[idx] - b[idx]);
    const dg = Math.abs(a[idx + 1] - b[idx + 1]);
    const db = Math.abs(a[idx + 2] - b[idx + 2]);
    const delta = Math.max(dr, dg, db);

    if (delta > threshold) {
      diffPixels++;
      diffRgba[idx] = 239;
      diffRgba[idx + 1] = 68;
      diffRgba[idx + 2] = 68;
      diffRgba[idx + 3] = 255;
    } else {
      const gray = Math.round((a[idx] * 0.299 + a[idx + 1] * 0.587 + a[idx + 2] * 0.114) * 0.35);
      diffRgba[idx] = gray;
      diffRgba[idx + 1] = gray;
      diffRgba[idx + 2] = gray;
      diffRgba[idx + 3] = 255;
    }
  }

  const diffPercent = totalPixels > 0 ? Math.round((diffPixels / totalPixels) * 10000) / 100 : 0;
  return { diffRgba, diffPixels, diffPercent };
}

// ---------------------------------------------------------------------------
// 11. Responsive <picture> HTML & PWA manifest.json Builders (Features 63 & 64)
// ---------------------------------------------------------------------------
export function generateResponsiveHtml(
  baseName: string,
  breakpoints: number[],
  formats: Array<'avif' | 'webp' | 'jpg'>,
  altText = 'Responsive asset'
): string {
  const cleanBase = baseName.replace(/\.[^.]+$/, '');
  const sources: string[] = [];

  for (const fmt of formats) {
    if (fmt === 'jpg') continue;
    const mime = fmt === 'avif' ? 'image/avif' : 'image/webp';
    const srcset = breakpoints.map((w) => `${cleanBase}-${w}w.${fmt} ${w}w`).join(', ');
    sources.push(`  <source type="${mime}" srcset="${srcset}" sizes="(max-width: 768px) 100vw, 80vw" />`);
  }

  const fallbackExt = formats.includes('jpg') ? 'jpg' : formats[formats.length - 1] ?? 'webp';
  const fallbackSrcset = breakpoints.map((w) => `${cleanBase}-${w}w.${fallbackExt} ${w}w`).join(', ');
  const largest = breakpoints[breakpoints.length - 1] ?? 1024;

  return `<picture>\n${sources.join('\n')}\n  <img\n    src="${cleanBase}-${largest}w.${fallbackExt}"\n    srcset="${fallbackSrcset}"\n    sizes="(max-width: 768px) 100vw, 80vw"\n    alt="${altText}"\n    loading="lazy"\n    decoding="async"\n  />\n</picture>`;
}

export function generatePwaManifest(appName = 'My Web App', themeColor = '#0F172A'): string {
  return JSON.stringify(
    {
      name: appName,
      short_name: appName,
      start_url: '/',
      display: 'standalone',
      background_color: '#FFFFFF',
      theme_color: themeColor,
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// 12. Pure Pixel Tone, Color, Convolution, Chroma Key & Retro DSP (Features 40-48)
// ---------------------------------------------------------------------------
export interface ToneParams {
  brightness: number; // -100..100
  contrast: number; // -100..100
  exposure: number; // -2..2 EV
  highlights: number; // -100..100
  shadows: number; // -100..100
  gamma: number; // 0.3..2.5
}

export function applyCoreExposure(rgba: Uint8ClampedArray, params: ToneParams): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const expMul = Math.pow(2, params.exposure);
  const contrastFactor = (259 * (params.contrast + 255)) / (255 * (259 - params.contrast));
  const invGamma = 1 / Math.max(0.1, params.gamma);

  for (let i = 0; i < rgba.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let v = rgba[i + c] * expMul + params.brightness * 2.55;
      const norm = Math.max(0, Math.min(1, v / 255));

      // Shadows boost affects darker tones; highlights affects upper tones
      if (params.shadows !== 0) {
        const shadowWeight = Math.pow(1 - norm, 2);
        v += params.shadows * 0.9 * shadowWeight;
      }
      if (params.highlights !== 0) {
        const highWeight = Math.pow(norm, 2);
        v += params.highlights * 0.9 * highWeight;
      }

      v = contrastFactor * (v - 128) + 128;
      v = Math.pow(Math.max(0, Math.min(255, v)) / 255, invGamma) * 255;
      out[i + c] = clampByte(v);
    }
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

export interface ColorVibranceParams {
  saturation: number; // -100..100
  vibrance: number; // -100..100
  hue: number; // -180..180
  temperature: number; // -100..100
  tint: number; // -100..100
}

export function applyColorVibrance(rgba: Uint8ClampedArray, p: ColorVibranceParams): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const satScale = 1 + p.saturation / 100;
  const vibScale = p.vibrance / 100;
  const hueRad = (p.hue * Math.PI) / 180;
  const cosH = Math.cos(hueRad);
  const sinH = Math.sin(hueRad);

  for (let i = 0; i < rgba.length; i += 4) {
    let r = rgba[i] + p.temperature * 0.65;
    let g = rgba[i + 1] - p.tint * 0.45;
    let b = rgba[i + 2] - p.temperature * 0.65;

    // Hue rotation matrix
    if (p.hue !== 0) {
      const nr = r * (0.299 + 0.701 * cosH + 0.168 * sinH) + g * (0.587 - 0.587 * cosH + 0.33 * sinH) + b * (0.114 - 0.114 * cosH - 0.497 * sinH);
      const ng = r * (0.299 - 0.299 * cosH - 0.328 * sinH) + g * (0.587 + 0.413 * cosH + 0.035 * sinH) + b * (0.114 - 0.114 * cosH + 0.292 * sinH);
      const nb = r * (0.299 - 0.3 * cosH + 1.25 * sinH) + g * (0.587 - 0.588 * cosH - 1.05 * sinH) + b * (0.114 + 0.886 * cosH - 0.203 * sinH);
      r = nr;
      g = ng;
      b = nb;
    }

    const avg = (r + g + b) / 3;
    const maxCh = Math.max(r, g, b);
    const curSat = maxCh > 0 ? (maxCh - Math.min(r, g, b)) / 255 : 0;
    const effectiveSat = satScale + vibScale * (1 - curSat);

    out[i] = clampByte(avg + (r - avg) * effectiveSat);
    out[i + 1] = clampByte(avg + (g - avg) * effectiveSat);
    out[i + 2] = clampByte(avg + (b - avg) * effectiveSat);
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

export function applyBwPreset(
  rgba: Uint8ClampedArray,
  preset: 'classic' | 'high-contrast' | 'sepia' | 'film' | 'infrared'
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const r = rgba[i];
    const g = rgba[i + 1];
    const b = rgba[i + 2];
    let gray = 0.299 * r + 0.587 * g + 0.114 * b;

    if (preset === 'high-contrast') {
      gray = 1.45 * (gray - 128) + 128;
    } else if (preset === 'film') {
      gray = 0.21 * r + 0.72 * g + 0.07 * b;
      gray = 1.18 * (gray - 120) + 124;
    } else if (preset === 'infrared') {
      gray = -0.2 * r + 1.45 * g - 0.25 * b;
    }

    if (preset === 'sepia') {
      out[i] = clampByte(gray * 1.08 + 18);
      out[i + 1] = clampByte(gray * 0.96 + 6);
      out[i + 2] = clampByte(gray * 0.78 - 10);
    } else {
      const c = clampByte(gray);
      out[i] = c;
      out[i + 1] = c;
      out[i + 2] = c;
    }
    out[i + 3] = rgba[i + 3];
  }
  return out;
}

export function applyUnsharpMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  amount = 1.2
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        out[idx] = rgba[idx];
        out[idx + 1] = rgba[idx + 1];
        out[idx + 2] = rgba[idx + 2];
        out[idx + 3] = rgba[idx + 3];
        continue;
      }
      for (let ch = 0; ch < 3; ch++) {
        const center = rgba[idx + ch];
        const avg =
          (rgba[((y - 1) * width + x) * 4 + ch] +
            rgba[((y + 1) * width + x) * 4 + ch] +
            rgba[(y * width + x - 1) * 4 + ch] +
            rgba[(y * width + x + 1) * 4 + ch]) *
          0.25;
        out[idx + ch] = clampByte(center + (center - avg) * amount);
      }
      out[idx + 3] = rgba[idx + 3];
    }
  }
  return out;
}

export function applyMotionBlur(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  radius = 8,
  angleDeg = 0
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const steps = Math.max(2, Math.min(25, Math.round(radius)));
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      const half = (steps - 1) / 2;
      for (let s = 0; s < steps; s++) {
        const sx = Math.round(x + (s - half) * dx);
        const sy = Math.round(y + (s - half) * dy);
        if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
          const i = (sy * width + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          a += rgba[i + 3];
          count++;
        }
      }
      const dst = (y * width + x) * 4;
      out[dst] = Math.round(r / count);
      out[dst + 1] = Math.round(g / count);
      out[dst + 2] = Math.round(b / count);
      out[dst + 3] = Math.round(a / count);
    }
  }
  return out;
}

export function applyChromaKey(
  rgba: Uint8ClampedArray,
  targetRgb: [number, number, number],
  tolerance: number,
  replaceMode: 'transparent' | 'color',
  replaceRgb: [number, number, number]
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba.length);
  const maxDist = Math.max(1, tolerance * 2.55);

  for (let i = 0; i < rgba.length; i += 4) {
    const dr = rgba[i] - targetRgb[0];
    const dg = rgba[i + 1] - targetRgb[1];
    const db = rgba[i + 2] - targetRgb[2];
    const dist = Math.sqrt(dr * dr + dg * dg + db * db);

    if (dist <= maxDist) {
      if (replaceMode === 'transparent') {
        const feather = dist > maxDist * 0.7 ? (dist - maxDist * 0.7) / (maxDist * 0.3) : 0;
        out[i] = rgba[i];
        out[i + 1] = rgba[i + 1];
        out[i + 2] = rgba[i + 2];
        out[i + 3] = Math.round(rgba[i + 3] * feather);
      } else {
        out[i] = replaceRgb[0];
        out[i + 1] = replaceRgb[1];
        out[i + 2] = replaceRgb[2];
        out[i + 3] = rgba[i + 3];
      }
    } else {
      out[i] = rgba[i];
      out[i + 1] = rgba[i + 1];
      out[i + 2] = rgba[i + 2];
      out[i + 3] = rgba[i + 3];
    }
  }

  return out;
}

export function applyRetroEffect(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  mode: 'floyd-steinberg' | 'halftone' | 'duotone' | 'pixel-art',
  colorA: [number, number, number] = [15, 23, 42],
  colorB: [number, number, number] = [56, 189, 248],
  cellSize = 6
): Uint8ClampedArray {
  if (mode === 'floyd-steinberg') {
    return quantizePixels(rgba, width, height, 8, true).rgba;
  }

  const out = new Uint8ClampedArray(rgba.length);
  if (mode === 'duotone') {
    for (let i = 0; i < rgba.length; i += 4) {
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) / 255;
      out[i] = clampByte(colorA[0] + (colorB[0] - colorA[0]) * lum);
      out[i + 1] = clampByte(colorA[1] + (colorB[1] - colorA[1]) * lum);
      out[i + 2] = clampByte(colorA[2] + (colorB[2] - colorA[2]) * lum);
      out[i + 3] = rgba[i + 3];
    }
    return out;
  }

  const step = Math.max(2, Math.min(24, Math.round(cellSize)));
  if (mode === 'pixel-art') {
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const sampleIdx = (Math.min(height - 1, y + (step >> 1)) * width + Math.min(width - 1, x + (step >> 1))) * 4;
        const r = rgba[sampleIdx];
        const g = rgba[sampleIdx + 1];
        const b = rgba[sampleIdx + 2];
        const a = rgba[sampleIdx + 3];
        for (let dy = 0; dy < step && y + dy < height; dy++) {
          for (let dx = 0; dx < step && x + dx < width; dx++) {
            const dst = ((y + dy) * width + (x + dx)) * 4;
            out[dst] = r;
            out[dst + 1] = g;
            out[dst + 2] = b;
            out[dst + 3] = a;
          }
        }
      }
    }
    return out;
  }

  // Halftone dots
  out.fill(255);
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const cx = Math.min(width - 1, x + step / 2);
      const cy = Math.min(height - 1, y + step / 2);
      const sIdx = (Math.floor(cy) * width + Math.floor(cx)) * 4;
      const lum = (0.299 * rgba[sIdx] + 0.587 * rgba[sIdx + 1] + 0.114 * rgba[sIdx + 2]) / 255;
      const radius = (1 - lum) * (step * 0.55);

      for (let dy = 0; dy < step && y + dy < height; dy++) {
        for (let dx = 0; dx < step && x + dx < width; dx++) {
          const dist = Math.hypot(x + dx - cx, y + dy - cy);
          const dst = ((y + dy) * width + (x + dx)) * 4;
          const inside = dist <= radius;
          out[dst] = inside ? colorA[0] : 248;
          out[dst + 1] = inside ? colorA[1] : 250;
          out[dst + 2] = inside ? colorA[2] : 252;
          out[dst + 3] = rgba[dst + 3] || 255;
        }
      }
    }
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
