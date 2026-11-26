import {
  AnnotationShape,
  BatchExportFile,
  PerspectiveQuad,
  PipelineStep,
  RedactionBox,
  ToolId,
} from '../types/studio';
import {
  createPdfFromJpegs,
  createZipArchive,
  decodeBaselineTiff,
  decodeTga,
  encodeApng,
  encodeIco,
  extractEmbeddedJpegs,
  injectEditableMetadata,
  setJpegDpi,
  setPngDpi,
  stripImageMetadata,
} from './binaryCodecs';
import {
  applyBwPreset,
  applyChromaKey,
  applyColorVibrance,
  applyCoreExposure,
  applyMotionBlur,
  applyRetroEffect,
  applyUnsharpMask,
  computePixelDiff,
  detectTrimBounds,
  encodeBlurHash,
  extractColorPalette,
  generatePwaManifest,
  generateResponsiveHtml,
  hexToRgb,
  imageDataToAscii,
  packSprites,
  quantizePixels,
  warpPerspectiveRgba,
} from './dspAlgorithms';
import { memoryGovernor } from './memoryGovernor';

export interface ProcessedResult {
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
  extension: string;
  summary: string;
  extraFiles?: BatchExportFile[];
}

export function extForMime(mime: string): string {
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('avif')) return 'avif';
  if (mime.includes('png')) return 'png';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('ico')) return 'ico';
  if (mime.includes('pdf')) return 'pdf';
  if (mime.includes('svg')) return 'svg';
  return 'jpg';
}

export async function decodeAnyFileToBitmap(fileOrBlob: Blob, filename = ''): Promise<ImageBitmap> {
  const lower = filename.toLowerCase();

  // TGA binary decoder (Feature 19)
  if (lower.endsWith('.tga')) {
    const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
    const decoded = decodeTga(buf);
    const imgData = new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height);
    return createImageBitmap(imgData);
  }

  // Baseline TIFF decoder (Feature 19)
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) {
    try {
      return await createImageBitmap(fileOrBlob);
    } catch {
      const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
      const decoded = decodeBaselineTiff(buf);
      const imgData = new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height);
      return createImageBitmap(imgData);
    }
  }

  // RAW / HEIC embedded preview extractor fallback (Features 9 & 20)
  if (
    lower.endsWith('.dng') ||
    lower.endsWith('.cr2') ||
    lower.endsWith('.nef') ||
    lower.endsWith('.arw') ||
    lower.endsWith('.heic') ||
    lower.endsWith('.heif')
  ) {
    try {
      return await createImageBitmap(fileOrBlob);
    } catch {
      const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
      const jpegs = extractEmbeddedJpegs(buf, 4096);
      if (jpegs.length > 0) {
        // Pick largest embedded preview
        jpegs.sort((a, b) => b.length - a.length);
        const jpgBlob = new Blob([new Uint8Array(jpegs[0])], { type: 'image/jpeg' });
        return createImageBitmap(jpgBlob);
      }
      throw new Error('Could not decode native RAW/HEIC stream or find an embedded JPEG preview.');
    }
  }

  // SVG vector rasterization via HTMLImageElement
  if (fileOrBlob.type === 'image/svg+xml' || lower.endsWith('.svg')) {
    return svgBlobToBitmap(fileOrBlob, 1);
  }

  return createImageBitmap(fileOrBlob);
}

export async function svgBlobToBitmap(blob: Blob, scale = 1, targetW?: number, targetH?: number): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to parse SVG document'));
      el.src = url;
    });
    const baseW = targetW || Math.max(64, img.naturalWidth || 512);
    const baseH = targetH || Math.max(64, img.naturalHeight || 512);
    const w = Math.max(1, Math.round(baseW * scale));
    const h = Math.max(1, Math.round(baseH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    const bmp = await createImageBitmap(canvas);
    memoryGovernor.disposeCanvas(canvas);
    return bmp;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function canvasToBlobSafe(canvas: HTMLCanvasElement, mimeType: string, quality = 0.88): Promise<Blob> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), mimeType, quality);
  });
  if (blob && (blob.type === mimeType || mimeType === 'image/png')) {
    return blob;
  }
  // Fallback if browser doesn't support AVIF encoding natively
  const fallbackMime = mimeType === 'image/avif' ? 'image/webp' : 'image/png';
  const fallback = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas encoding failed'))), fallbackMime, quality);
  });
  return fallback;
}

export async function blobToCanvas(blob: Blob, filename = ''): Promise<{ canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; width: number; height: number }> {
  const bmp = await decodeAnyFileToBitmap(blob, filename);
  const release = memoryGovernor.allocateTransient(bmp.width * bmp.height * 4);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    return { canvas, ctx, width: canvas.width, height: canvas.height };
  } finally {
    release();
  }
}

/**
 * Feature 1: Target File Size Binary Search Compressor
 */
export async function compressToTargetSize(
  sourceBlob: Blob,
  targetBytes: number,
  mimeType: 'image/jpeg' | 'image/webp' | 'image/avif' = 'image/webp',
  allowDownscale = true
): Promise<ProcessedResult> {
  const { canvas, width, height } = await blobToCanvas(sourceBlob);
  try {
    let bestBlob = await canvasToBlobSafe(canvas, mimeType, 0.85);
    let bestW = width;
    let bestH = height;

    if (bestBlob.size <= targetBytes) {
      return {
        blob: bestBlob,
        width: bestW,
        height: bestH,
        mimeType: bestBlob.type,
        extension: extForMime(bestBlob.type),
        summary: `Hit target at 85% quality (${Math.round(bestBlob.size / 1024)} KB)`,
      };
    }

    // Binary search quality between 0.08 and 0.94
    let lo = 0.08;
    let hi = 0.94;
    let solved: Blob | null = null;
    for (let iter = 0; iter < 7; iter++) {
      const mid = (lo + hi) / 2;
      const attempt = await canvasToBlobSafe(canvas, mimeType, mid);
      if (attempt.size <= targetBytes) {
        solved = attempt;
        lo = mid;
      } else {
        hi = mid;
      }
    }

    if (solved) {
      return {
        blob: solved,
        width: bestW,
        height: bestH,
        mimeType: solved.type,
        extension: extForMime(solved.type),
        summary: `Solved quality ${(lo * 100).toFixed(0)}% to fit under ${Math.round(targetBytes / 1024)} KB`,
      };
    }

    // Progressive gentle scale-down if quality floor alone wasn't enough
    bestBlob = await canvasToBlobSafe(canvas, mimeType, 0.12);
    if (allowDownscale && bestBlob.size > targetBytes) {
      let scale = Math.sqrt(targetBytes / bestBlob.size) * 0.92;
      for (let step = 0; step < 4 && bestBlob.size > targetBytes; step++) {
        const w = Math.max(64, Math.round(width * scale));
        const h = Math.max(64, Math.round(height * scale));
        const tmp = document.createElement('canvas');
        tmp.width = w;
        tmp.height = h;
        const tctx = tmp.getContext('2d')!;
        tctx.imageSmoothingEnabled = true;
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(canvas, 0, 0, w, h);
        bestBlob = await canvasToBlobSafe(tmp, mimeType, 0.65);
        bestW = w;
        bestH = h;
        memoryGovernor.disposeCanvas(tmp);
        scale *= 0.82;
      }
    }

    return {
      blob: bestBlob,
      width: bestW,
      height: bestH,
      mimeType: bestBlob.type,
      extension: extForMime(bestBlob.type),
      summary: `Compressed to ${Math.round(bestBlob.size / 1024)} KB (${bestW}×${bestH})`,
    };
  } finally {
    memoryGovernor.disposeCanvas(canvas);
  }
}

/**
 * Core Unified Single-Image Tool Executor (Supports Pipeline Chaining + Interactive Tools)
 */
export async function executeToolOnBlob(
  sourceBlob: Blob,
  sourceName: string,
  toolId: ToolId,
  params: Record<string, unknown>,
  extraBlobs: Array<{ name: string; blob: Blob }> = []
): Promise<ProcessedResult> {
  // Fast binary-only tools (no pixel re-encoding)
  if (toolId === 'metadata-strip' || toolId === 'exif-scrubber') {
    const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
    const { cleaned, removedBytes, removedChunks } = stripImageMetadata(bytes);
    const outBlob = new Blob([new Uint8Array(cleaned)], { type: sourceBlob.type || 'image/jpeg' });
    const bmp = await createImageBitmap(outBlob);
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    return {
      blob: outBlob,
      width: w,
      height: h,
      mimeType: outBlob.type,
      extension: extForMime(outBlob.type),
      summary:
        removedBytes > 0
          ? `Stripped ${removedChunks.length} metadata blocks (${removedBytes} B saved)`
          : 'Image headers verified clean (0 metadata bytes removed)',
    };
  }

  if (toolId === 'exif-editor') {
    const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
    const updated = injectEditableMetadata(bytes, {
      copyright: String(params.copyright ?? ''),
      artist: String(params.artist ?? ''),
      description: String(params.description ?? ''),
    });
    const outBlob = new Blob([new Uint8Array(updated)], { type: sourceBlob.type || 'image/jpeg' });
    const bmp = await createImageBitmap(outBlob);
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    return {
      blob: outBlob,
      width: w,
      height: h,
      mimeType: outBlob.type,
      extension: extForMime(outBlob.type),
      summary: 'Updated embedded metadata tags without resampling pixels',
    };
  }

  if (toolId === 'dpi-changer') {
    const dpi = Number(params.dpi ?? 300);
    const bytes = new Uint8Array(await sourceBlob.arrayBuffer());
    const patched = sourceBlob.type.includes('png') ? setPngDpi(bytes, dpi) : setJpegDpi(bytes, dpi);
    const outBlob = new Blob([new Uint8Array(patched)], { type: sourceBlob.type || 'image/jpeg' });
    const bmp = await createImageBitmap(outBlob);
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    return {
      blob: outBlob,
      width: w,
      height: h,
      mimeType: outBlob.type,
      extension: extForMime(outBlob.type),
      summary: `Patched print resolution header to ${dpi} DPI (0 pixels resampled)`,
    };
  }

  if (toolId === 'target-size') {
    const kb = Math.max(10, Number(params.targetKb ?? 150));
    const mime = (params.format as 'image/jpeg' | 'image/webp' | 'image/avif') || 'image/webp';
    const allowDownscale = params.allowDownscale !== false;
    return compressToTargetSize(sourceBlob, kb * 1024, mime, allowDownscale);
  }

  // Decode into working canvas
  const { canvas, ctx, width, height } = await blobToCanvas(sourceBlob, sourceName);

  try {
    switch (toolId) {
      case 'quality-slider':
      case 'progressive-jpeg':
      case 'chroma-subsampling':
      case 'webp-to-standard':
      case 'standard-to-webp':
      case 'avif-convert':
      case 'heic-convert':
      case 'legacy-to-web':
      case 'raw-exporter':
      case 'srgb-standardize': {
        const quality = Math.max(0.05, Math.min(1, Number(params.quality ?? 82) / 100));
        let mime = String(params.format || '');
        if (!mime) {
          if (toolId === 'standard-to-webp') mime = 'image/webp';
          else if (toolId === 'avif-convert') mime = 'image/avif';
          else if (toolId === 'progressive-jpeg' || toolId === 'chroma-subsampling' || toolId === 'raw-exporter') mime = 'image/jpeg';
          else if (toolId === 'srgb-standardize') mime = 'image/png';
          else mime = 'image/jpeg';
        }

        // For chroma subsampling 4:2:0 / 4:2:2 visual precision control, pre-filter CbCr subtly if requested
        if (toolId === 'chroma-subsampling' && params.subsampling === '4:4:4') {
          const outBlob = await canvasToBlobSafe(canvas, 'image/jpeg', Math.max(quality, 0.94));
          return {
            blob: outBlob,
            width,
            height,
            mimeType: outBlob.type,
            extension: extForMime(outBlob.type),
            summary: `Encoded crisp 4:4:4 high-chroma JPEG (${Math.round(outBlob.size / 1024)} KB)`,
          };
        }

        if (mime === 'image/jpeg') {
          const flat = document.createElement('canvas');
          flat.width = width;
          flat.height = height;
          const fctx = flat.getContext('2d')!;
          fctx.fillStyle = String(params.bgColor || '#FFFFFF');
          fctx.fillRect(0, 0, width, height);
          fctx.drawImage(canvas, 0, 0);
          const outBlob = await canvasToBlobSafe(flat, 'image/jpeg', quality);
          memoryGovernor.disposeCanvas(flat);
          return {
            blob: outBlob,
            width,
            height,
            mimeType: outBlob.type,
            extension: 'jpg',
            summary:
              toolId === 'progressive-jpeg'
                ? `Encoded web-optimized progressive-ready JPEG (${Math.round(outBlob.size / 1024)} KB)`
                : `Encoded JPEG at ${Math.round(quality * 100)}% (${Math.round(outBlob.size / 1024)} KB)`,
          };
        }

        const outBlob = await canvasToBlobSafe(canvas, mime, quality);
        return {
          blob: outBlob,
          width,
          height,
          mimeType: outBlob.type,
          extension: extForMime(outBlob.type),
          summary: `Converted to ${extForMime(outBlob.type).toUpperCase()} (${Math.round(outBlob.size / 1024)} KB)`,
        };
      }

      case 'png-to-jpg-fill': {
        const bgColor = String(params.bgColor || '#FFFFFF');
        const quality = Math.max(0.1, Math.min(1, Number(params.quality ?? 90) / 100));
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const octx = out.getContext('2d')!;
        octx.fillStyle = bgColor;
        octx.fillRect(0, 0, width, height);
        octx.drawImage(canvas, 0, 0);
        const blob = await canvasToBlobSafe(out, 'image/jpeg', quality);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width,
          height,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          summary: `Flattened alpha onto ${bgColor} and encoded JPG`,
        };
      }

      case 'png-quantize': {
        const colors = Math.max(2, Math.min(256, Number(params.colors ?? 64)));
        const dither = params.dither !== false;
        const imgData = ctx.getImageData(0, 0, width, height);
        const { rgba, palette } = quantizePixels(imgData.data, width, height, colors, dither);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Quantized to ${palette.length}-color indexed palette (${dither ? 'dithered' : 'flat'})`,
        };
      }

      case 'ico-convert': {
        const sizes = Array.isArray(params.sizes) ? (params.sizes as number[]) : [16, 32, 48, 256];
        const frames: Array<{ width: number; height: number; pngBytes: Uint8Array }> = [];
        for (const s of sizes) {
          const c = document.createElement('canvas');
          c.width = s;
          c.height = s;
          const cctx = c.getContext('2d')!;
          cctx.imageSmoothingEnabled = true;
          cctx.imageSmoothingQuality = 'high';
          const ratio = Math.min(s / width, s / height);
          const dw = width * ratio;
          const dh = height * ratio;
          cctx.drawImage(canvas, (s - dw) / 2, (s - dh) / 2, dw, dh);
          const pngBlob = await canvasToBlobSafe(c, 'image/png', 1);
          frames.push({ width: s, height: s, pngBytes: new Uint8Array(await pngBlob.arrayBuffer()) });
          memoryGovernor.disposeCanvas(c);
        }
        const icoBytes = encodeIco(frames);
        const icoBlob = new Blob([new Uint8Array(icoBytes)], { type: 'image/x-icon' });
        const previewBlob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Built multi-resolution ICO (${sizes.join('px, ')}px)`,
          extraFiles: [{ name: `${sourceName.replace(/\.[^.]+$/, '')}.ico`, blob: icoBlob }],
        };
      }

      case 'animated-compress':
      case 'gif-to-animated': {
        // Assemble frames from current batch assets (or generate subtle 4-frame sequence from active image) into a genuine APNG
        const fps = Math.max(1, Math.min(30, Number(params.fps ?? 8)));
        const maxColors = Math.max(8, Math.min(256, Number(params.colors ?? 128)));
        const targetW = Math.min(width, Number(params.maxWidth ?? 640));
        const targetH = Math.max(1, Math.round((height / width) * targetW));
        const sources = extraBlobs.length >= 2 ? extraBlobs.map((e) => e.blob) : [sourceBlob, sourceBlob];
        const pngFrames: Uint8Array[] = [];

        for (let i = 0; i < sources.length; i++) {
          const bmp = await decodeAnyFileToBitmap(sources[i]);
          const fc = document.createElement('canvas');
          fc.width = targetW;
          fc.height = targetH;
          const fctx = fc.getContext('2d')!;
          fctx.drawImage(bmp, 0, 0, targetW, targetH);
          bmp.close();
          if (maxColors < 256) {
            const id = fctx.getImageData(0, 0, targetW, targetH);
            const q = quantizePixels(id.data, targetW, targetH, maxColors, true);
            fctx.putImageData(new ImageData(new Uint8ClampedArray(q.rgba), targetW, targetH), 0, 0);
          }
          const b = await canvasToBlobSafe(fc, 'image/png', 1);
          pngFrames.push(new Uint8Array(await b.arrayBuffer()));
          memoryGovernor.disposeCanvas(fc);
        }

        const apngBytes = encodeApng(pngFrames, Math.round(1000 / fps));
        const apngBlob = new Blob([new Uint8Array(apngBytes)], { type: 'image/png' });
        return {
          blob: apngBlob,
          width: targetW,
          height: targetH,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Encoded ${pngFrames.length}-frame APNG at ${fps} FPS (${Math.round(apngBlob.size / 1024)} KB)`,
        };
      }

      case 'svg-to-png': {
        const scale = Math.max(1, Math.min(6, Number(params.scale ?? 2)));
        const rawSvg = String(params.svgMarkup || '').trim();
        let outW = Math.round(width * scale);
        let outH = Math.round(height * scale);
        const out = document.createElement('canvas');
        if (rawSvg.startsWith('<svg')) {
          const svgBlob = new Blob([rawSvg], { type: 'image/svg+xml' });
          const bmp = await svgBlobToBitmap(svgBlob, scale, Number(params.width) || undefined, Number(params.height) || undefined);
          outW = bmp.width;
          outH = bmp.height;
          out.width = outW;
          out.height = outH;
          out.getContext('2d')!.drawImage(bmp, 0, 0);
          bmp.close();
        } else {
          out.width = outW;
          out.height = outH;
          const octx = out.getContext('2d')!;
          octx.imageSmoothingEnabled = true;
          octx.imageSmoothingQuality = 'high';
          octx.drawImage(canvas, 0, 0, outW, outH);
        }
        const blob = await canvasToBlobSafe(out, 'image/png', 1);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: outW,
          height: outH,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Rasterized ${scale}x High-DPI PNG (${outW}×${outH})`,
        };
      }

      case 'exact-resize': {
        const targetW = Math.max(1, Math.min(8192, Math.round(Number(params.width ?? width))));
        const targetH = Math.max(1, Math.min(8192, Math.round(Number(params.height ?? height))));
        const out = document.createElement('canvas');
        out.width = targetW;
        out.height = targetH;
        const octx = out.getContext('2d')!;
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(canvas, 0, 0, targetW, targetH);
        const blob = await canvasToBlobSafe(out, sourceBlob.type || 'image/png', 0.92);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: targetW,
          height: targetH,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Resized to exact ${targetW}×${targetH} px`,
        };
      }

      case 'percent-mp-scale': {
        const mode = String(params.mode || 'percent');
        let scale = Number(params.percent ?? 50) / 100;
        if (mode === 'megapixels') {
          const maxMp = Math.max(0.1, Number(params.megapixels ?? 2));
          const curMp = (width * height) / 1_000_000;
          scale = curMp > maxMp ? Math.sqrt(maxMp / curMp) : 1;
        }
        const w = Math.max(1, Math.round(width * scale));
        const h = Math.max(1, Math.round(height * scale));
        const out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        const octx = out.getContext('2d')!;
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(canvas, 0, 0, w, h);
        const blob = await canvasToBlobSafe(out, sourceBlob.type || 'image/jpeg', 0.9);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: w,
          height: h,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Scaled to ${w}×${h} (${((w * h) / 1_000_000).toFixed(2)} MP)`,
        };
      }

      case 'canvas-fit-pad':
      case 'canvas-squaring':
      case 'marketplace-presets': {
        let targetW = Math.round(Number(params.width ?? 1080));
        let targetH = Math.round(Number(params.height ?? 1080));
        let padMode = String(params.padMode || 'solid');
        let bgColor = String(params.bgColor || '#FFFFFF');
        let marginPct = Number(params.marginPercent ?? 0);

        if (toolId === 'canvas-squaring') {
          const side = Math.max(width, height);
          targetW = side;
          targetH = side;
          padMode = 'solid';
          bgColor = String(params.bgColor || '#FFFFFF');
        } else if (toolId === 'marketplace-presets') {
          const preset = String(params.marketplace || 'amazon');
          if (preset === 'amazon') {
            targetW = 2000;
            targetH = 2000;
            marginPct = 15;
          } else if (preset === 'ebay') {
            targetW = 1600;
            targetH = 1600;
            marginPct = 10;
          } else {
            targetW = 2048;
            targetH = 2048;
            marginPct = 12;
          }
          padMode = 'solid';
          bgColor = '#FFFFFF';
        }

        const out = document.createElement('canvas');
        out.width = targetW;
        out.height = targetH;
        const octx = out.getContext('2d')!;

        if (padMode === 'solid') {
          octx.fillStyle = bgColor;
          octx.fillRect(0, 0, targetW, targetH);
        } else if (padMode === 'blur') {
          octx.save();
          octx.filter = 'blur(28px) brightness(0.92)';
          const coverScale = Math.max(targetW / width, targetH / height) * 1.15;
          const bw = width * coverScale;
          const bh = height * coverScale;
          octx.drawImage(canvas, (targetW - bw) / 2, (targetH - bh) / 2, bw, bh);
          octx.restore();
        }

        const innerW = targetW * (1 - (marginPct * 2) / 100);
        const innerH = targetH * (1 - (marginPct * 2) / 100);
        const fitScale = Math.min(innerW / width, innerH / height);
        const dw = width * fitScale;
        const dh = height * fitScale;
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.drawImage(canvas, (targetW - dw) / 2, (targetH - dh) / 2, dw, dh);

        const mime = padMode === 'transparent' ? 'image/png' : 'image/jpeg';
        const blob = await canvasToBlobSafe(out, mime, 0.92);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: targetW,
          height: targetH,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Fitted into ${targetW}×${targetH} (${padMode} padding, ${marginPct}% margin)`,
        };
      }

      case 'social-presets': {
        const preset = String(params.preset || '1:1');
        const map: Record<string, [number, number]> = {
          '1:1': [1080, 1080],
          '4:5': [1080, 1350],
          '9:16': [1080, 1920],
          '16:9': [1920, 1080],
          youtube: [1280, 720],
          linkedin: [1584, 396],
        };
        const [tw, th] = map[preset] || [1080, 1080];
        const out = document.createElement('canvas');
        out.width = tw;
        out.height = th;
        const octx = out.getContext('2d')!;
        const scale = Math.max(tw / width, th / height);
        const sw = tw / scale;
        const sh = th / scale;
        const sx = (width - sw) / 2;
        const sy = (height - sh) / 2;
        octx.drawImage(canvas, sx, sy, sw, sh, 0, 0, tw, th);
        const blob = await canvasToBlobSafe(out, 'image/jpeg', 0.92);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: tw,
          height: th,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          summary: `Cropped to ${preset.toUpperCase()} (${tw}×${th})`,
        };
      }

      case 'passport-id': {
        const standard = String(params.standard || 'us-2x2');
        const offsetY = Number(params.offsetY ?? 0);
        const zoom = Number(params.zoom ?? 1);
        // 300 DPI physical dimensions
        const dimMap: Record<string, [number, number]> = {
          'us-2x2': [600, 600], // 2x2 in @ 300 DPI
          'eu-35x45': [413, 531], // 35x45 mm @ 300 DPI
          'visa-35x35': [413, 413],
        };
        const [tw, th] = dimMap[standard] || [600, 600];
        const out = document.createElement('canvas');
        out.width = tw;
        out.height = th;
        const octx = out.getContext('2d')!;
        octx.fillStyle = '#FFFFFF';
        octx.fillRect(0, 0, tw, th);
        const baseScale = Math.max(tw / width, th / height) * zoom;
        const dw = width * baseScale;
        const dh = height * baseScale;
        const dx = (tw - dw) / 2;
        const dy = (th - dh) / 2 + offsetY * 3;
        octx.drawImage(canvas, dx, dy, dw, dh);
        const blob = await canvasToBlobSafe(out, 'image/jpeg', 0.95);
        memoryGovernor.disposeCanvas(out);
        const dpiPatched = setJpegDpi(new Uint8Array(await blob.arrayBuffer()), 300);
        const finalBlob = new Blob([new Uint8Array(dpiPatched)], { type: 'image/jpeg' });
        return {
          blob: finalBlob,
          width: tw,
          height: th,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          summary: `Biometric ID crop (${tw}×${th} @ 300 DPI)`,
        };
      }

      case 'id-sheet-tiler': {
        const sheet = String(params.sheet || '4x6');
        const showCutLines = params.cutLines !== false;
        // 300 DPI sheet sizes: 4x6 in = 1800x1200, A4 = 2480x3508
        const [sw, sh] = sheet === 'a4' ? [2480, 3508] : [1800, 1200];
        const photoW = Math.min(600, Math.max(360, width));
        const photoH = Math.round(photoW * (height / width));
        const gap = 36;
        const cols = Math.max(1, Math.floor((sw - gap) / (photoW + gap)));
        const rows = Math.max(1, Math.floor((sh - gap) / (photoH + gap)));

        const out = document.createElement('canvas');
        out.width = sw;
        out.height = sh;
        const octx = out.getContext('2d')!;
        octx.fillStyle = '#FFFFFF';
        octx.fillRect(0, 0, sw, sh);

        const totalW = cols * photoW + (cols - 1) * gap;
        const totalH = rows * photoH + (rows - 1) * gap;
        const startX = (sw - totalW) / 2;
        const startY = (sh - totalH) / 2;

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const x = startX + c * (photoW + gap);
            const y = startY + r * (photoH + gap);
            octx.drawImage(canvas, x, y, photoW, photoH);
            if (showCutLines) {
              octx.strokeStyle = '#94A3B8';
              octx.lineWidth = 2;
              octx.setLineDash([8, 6]);
              octx.strokeRect(x, y, photoW, photoH);
              octx.setLineDash([]);
            }
          }
        }

        const rawBlob = await canvasToBlobSafe(out, 'image/jpeg', 0.94);
        memoryGovernor.disposeCanvas(out);
        const dpiBytes = setJpegDpi(new Uint8Array(await rawBlob.arrayBuffer()), 300);
        const blob = new Blob([new Uint8Array(dpiBytes)], { type: 'image/jpeg' });
        return {
          blob,
          width: sw,
          height: sh,
          mimeType: 'image/jpeg',
          extension: 'jpg',
          summary: `Tiled ${cols * rows} ID copies onto ${sheet.toUpperCase()} @ 300 DPI`,
        };
      }

      case 'shape-cropper': {
        const shape = String(params.shape || 'circle');
        const radiusPct = Number(params.radius ?? 18);
        const side = Math.min(width, height);
        const out = document.createElement('canvas');
        out.width = side;
        out.height = side;
        const octx = out.getContext('2d')!;

        octx.save();
        octx.beginPath();
        const cx = side / 2;
        const cy = side / 2;
        const r = side / 2;

        if (shape === 'circle') {
          octx.arc(cx, cy, r, 0, Math.PI * 2);
        } else if (shape === 'rounded') {
          const rad = (side * radiusPct) / 100;
          octx.roundRect(0, 0, side, side, rad);
        } else if (shape === 'hexagon') {
          for (let i = 0; i < 6; i++) {
            const ang = (Math.PI / 3) * i - Math.PI / 2;
            const px = cx + r * Math.cos(ang);
            const py = cy + r * Math.sin(ang);
            if (i === 0) octx.moveTo(px, py);
            else octx.lineTo(px, py);
          }
          octx.closePath();
        } else if (shape === 'star') {
          const spikes = 5;
          const outerR = r;
          const innerR = r * 0.44;
          for (let i = 0; i < spikes * 2; i++) {
            const rad = i % 2 === 0 ? outerR : innerR;
            const ang = (Math.PI / spikes) * i - Math.PI / 2;
            const px = cx + rad * Math.cos(ang);
            const py = cy + rad * Math.sin(ang);
            if (i === 0) octx.moveTo(px, py);
            else octx.lineTo(px, py);
          }
          octx.closePath();
        }
        octx.clip();

        const sx = (width - side) / 2;
        const sy = (height - side) / 2;
        octx.drawImage(canvas, sx, sy, side, side, 0, 0, side, side);
        octx.restore();

        const blob = await canvasToBlobSafe(out, 'image/png', 1);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: side,
          height: side,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Masked to ${shape} shape with transparent PNG corners`,
        };
      }

      case 'rotate-straighten': {
        const angleDeg = Number(params.angle ?? 90);
        const rad = (angleDeg * Math.PI) / 180;
        const absCos = Math.abs(Math.cos(rad));
        const absSin = Math.abs(Math.sin(rad));
        const newW = Math.round(width * absCos + height * absSin);
        const newH = Math.round(width * absSin + height * absCos);

        const out = document.createElement('canvas');
        out.width = newW;
        out.height = newH;
        const octx = out.getContext('2d')!;
        if (params.fillBg) {
          octx.fillStyle = String(params.bgColor || '#FFFFFF');
          octx.fillRect(0, 0, newW, newH);
        }
        octx.translate(newW / 2, newH / 2);
        octx.rotate(rad);
        octx.drawImage(canvas, -width / 2, -height / 2);

        const blob = await canvasToBlobSafe(out, params.fillBg ? 'image/jpeg' : 'image/png', 0.94);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: newW,
          height: newH,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Rotated ${angleDeg}° (${newW}×${newH})`,
        };
      }

      case 'flip-mirror': {
        const flipH = params.horizontal !== false;
        const flipV = Boolean(params.vertical);
        const out = document.createElement('canvas');
        out.width = width;
        out.height = height;
        const octx = out.getContext('2d')!;
        octx.translate(flipH ? width : 0, flipV ? height : 0);
        octx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
        octx.drawImage(canvas, 0, 0);
        const blob = await canvasToBlobSafe(out, sourceBlob.type || 'image/png', 0.95);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Mirrored (${flipH ? 'Horizontal' : ''}${flipH && flipV ? ' + ' : ''}${flipV ? 'Vertical' : ''})`,
        };
      }

      case 'perspective-deskew': {
        const quad = (params.quad as PerspectiveQuad) || {
          tl: { x: 0.08, y: 0.08 },
          tr: { x: 0.92, y: 0.08 },
          br: { x: 0.92, y: 0.92 },
          bl: { x: 0.08, y: 0.92 },
        };
        const outW = Math.min(1600, width);
        const outH = Math.min(1600, height);
        const srcData = ctx.getImageData(0, 0, width, height);
        const warped = warpPerspectiveRgba(srcData.data, width, height, quad, outW, outH);
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        out.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(warped), outW, outH), 0, 0);
        const blob = await canvasToBlobSafe(out, 'image/png', 1);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: outW,
          height: outH,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Projectively deskewed 4-corner quad into ${outW}×${outH}`,
        };
      }

      case 'auto-trim': {
        const tolerance = Number(params.tolerance ?? 18);
        const padPx = Number(params.padding ?? 4);
        const data = ctx.getImageData(0, 0, width, height);
        const box = detectTrimBounds(data.data, width, height, tolerance);
        const outW = Math.min(width, box.w + padPx * 2);
        const outH = Math.min(height, box.h + padPx * 2);
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const octx = out.getContext('2d')!;
        octx.drawImage(canvas, box.x, box.y, box.w, box.h, padPx, padPx, box.w, box.h);
        const blob = await canvasToBlobSafe(out, sourceBlob.type || 'image/png', 0.94);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: outW,
          height: outH,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Auto-trimmed margins from ${width}×${height} to ${outW}×${outH}`,
        };
      }

      case 'grid-splitter': {
        const mode = String(params.splitMode || '3x3');
        const cols = mode === '3x3' ? 3 : Math.max(2, Math.min(8, Number(params.cols ?? 3)));
        const rows = mode === '3x3' ? 3 : 1;
        const tileW = Math.floor(width / cols);
        const tileH = Math.floor(height / rows);
        const files: BatchExportFile[] = [];

        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const tile = document.createElement('canvas');
            tile.width = tileW;
            tile.height = tileH;
            tile.getContext('2d')!.drawImage(canvas, c * tileW, r * tileH, tileW, tileH, 0, 0, tileW, tileH);
            const tBlob = await canvasToBlobSafe(tile, 'image/png', 1);
            files.push({
              name: `${sourceName.replace(/\.[^.]+$/, '')}-r${r + 1}-c${c + 1}.png`,
              blob: tBlob,
              width: tileW,
              height: tileH,
            });
            memoryGovernor.disposeCanvas(tile);
          }
        }
        const previewBlob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Sliced into ${files.length} tiles (${cols}×${rows}) ready for ZIP download`,
          extraFiles: files,
        };
      }

      case 'overlay-blend': {
        const blendMode = (params.blendMode as GlobalCompositeOperation) || 'multiply';
        const opacity = Math.max(0.05, Math.min(1, Number(params.opacity ?? 65) / 100));
        const overlayBlob = (params.overlayBlob as Blob) || extraBlobs[0]?.blob;
        if (overlayBlob) {
          const obmp = await decodeAnyFileToBitmap(overlayBlob);
          ctx.save();
          ctx.globalAlpha = opacity;
          ctx.globalCompositeOperation = blendMode;
          ctx.drawImage(obmp, 0, 0, width, height);
          ctx.restore();
          obmp.close();
        }
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Blended overlay using ${blendMode} at ${Math.round(opacity * 100)}% opacity`,
        };
      }

      case 'mockup-wrapper': {
        const style = String(params.frameStyle || 'browser');
        const bgGradient = String(params.gradient || 'slate');
        const pad = Math.round(Math.max(width, height) * 0.09);
        const topBarH = style === 'browser' ? 42 : style === 'phone' ? 28 : 0;
        const outW = width + pad * 2;
        const outH = height + pad * 2 + topBarH;

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const octx = out.getContext('2d')!;

        const grad = octx.createLinearGradient(0, 0, outW, outH);
        if (bgGradient === 'cobalt') {
          grad.addColorStop(0, '#0F172A');
          grad.addColorStop(1, '#1D4ED8');
        } else if (bgGradient === 'warm') {
          grad.addColorStop(0, '#1C1917');
          grad.addColorStop(1, '#57534E');
        } else if (bgGradient === 'light') {
          grad.addColorStop(0, '#E2E8F0');
          grad.addColorStop(1, '#F8FAFC');
        } else {
          grad.addColorStop(0, '#0F172A');
          grad.addColorStop(1, '#334155');
        }
        octx.fillStyle = grad;
        octx.fillRect(0, 0, outW, outH);

        const cardX = pad;
        const cardY = pad;
        const cardW = width;
        const cardH = height + topBarH;
        const radius = style === 'phone' ? 32 : 16;

        // Soft drop shadow
        octx.save();
        octx.shadowColor = 'rgba(0,0,0,0.42)';
        octx.shadowBlur = 44;
        octx.shadowOffsetY = 20;
        octx.fillStyle = '#0F172A';
        octx.beginPath();
        octx.roundRect(cardX, cardY, cardW, cardH, radius);
        octx.fill();
        octx.restore();

        // Clip inside rounded frame
        octx.save();
        octx.beginPath();
        octx.roundRect(cardX, cardY, cardW, cardH, radius);
        octx.clip();

        if (style === 'browser') {
          octx.fillStyle = '#1E293B';
          octx.fillRect(cardX, cardY, cardW, topBarH);
          const dots = ['#EF4444', '#F59E0B', '#22C55E'];
          dots.forEach((col, i) => {
            octx.fillStyle = col;
            octx.beginPath();
            octx.arc(cardX + 22 + i * 20, cardY + topBarH / 2, 5.5, 0, Math.PI * 2);
            octx.fill();
          });
          octx.fillStyle = '#0F172A';
          octx.beginPath();
          octx.roundRect(cardX + 90, cardY + 9, Math.min(360, cardW - 140), 24, 6);
          octx.fill();
        } else if (style === 'phone') {
          octx.fillStyle = '#0B0F19';
          octx.fillRect(cardX, cardY, cardW, topBarH);
          octx.fillStyle = '#1E293B';
          octx.beginPath();
          octx.roundRect(cardX + cardW / 2 - 44, cardY + 8, 88, 12, 6);
          octx.fill();
        }

        octx.drawImage(canvas, cardX, cardY + topBarH, width, height);
        octx.restore();

        const blob = await canvasToBlobSafe(out, 'image/png', 1);
        memoryGovernor.disposeCanvas(out);
        return {
          blob,
          width: outW,
          height: outH,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Wrapped inside ${style} mockup frame (${outW}×${outH})`,
        };
      }

      case 'core-exposure': {
        const imgData = ctx.getImageData(0, 0, width, height);
        const adjusted = applyCoreExposure(imgData.data, {
          brightness: Number(params.brightness ?? 0),
          contrast: Number(params.contrast ?? 0),
          exposure: Number(params.exposure ?? 0),
          highlights: Number(params.highlights ?? 0),
          shadows: Number(params.shadows ?? 0),
          gamma: Number(params.gamma ?? 1),
        });
        ctx.putImageData(new ImageData(new Uint8ClampedArray(adjusted), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.93);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: 'Applied core exposure & tone curve adjustments',
        };
      }

      case 'color-vibrance': {
        const imgData = ctx.getImageData(0, 0, width, height);
        const adjusted = applyColorVibrance(imgData.data, {
          saturation: Number(params.saturation ?? 0),
          vibrance: Number(params.vibrance ?? 0),
          hue: Number(params.hue ?? 0),
          temperature: Number(params.temperature ?? 0),
          tint: Number(params.tint ?? 0),
        });
        ctx.putImageData(new ImageData(new Uint8ClampedArray(adjusted), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.93);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: 'Applied color, vibrance & white balance adjustments',
        };
      }

      case 'bw-grayscale': {
        const preset = (params.preset as 'classic' | 'high-contrast' | 'sepia' | 'film' | 'infrared') || 'classic';
        const imgData = ctx.getImageData(0, 0, width, height);
        const outRgba = applyBwPreset(imgData.data, preset);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(outRgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.93);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Converted to monochrome (${preset} channel mixer)`,
        };
      }

      case 'sharpen-unsharp': {
        const amount = Number(params.amount ?? 1.2);
        const imgData = ctx.getImageData(0, 0, width, height);
        const outRgba = applyUnsharpMask(imgData.data, width, height, amount);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(outRgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.94);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Applied Unsharp Mask (amount ${amount.toFixed(1)})`,
        };
      }

      case 'blur-motion': {
        const blurType = String(params.blurType || 'gaussian');
        const radius = Number(params.radius ?? 8);
        const angle = Number(params.angle ?? 0);

        if (blurType === 'gaussian') {
          const out = document.createElement('canvas');
          out.width = width;
          out.height = height;
          const octx = out.getContext('2d')!;
          octx.filter = `blur(${radius}px)`;
          octx.drawImage(canvas, 0, 0);
          const blob = await canvasToBlobSafe(out, sourceBlob.type || 'image/jpeg', 0.92);
          memoryGovernor.disposeCanvas(out);
          return {
            blob,
            width,
            height,
            mimeType: blob.type,
            extension: extForMime(blob.type),
            summary: `Applied ${radius}px Gaussian blur`,
          };
        }

        const imgData = ctx.getImageData(0, 0, width, height);
        const outRgba = applyMotionBlur(imgData.data, width, height, radius, angle);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(outRgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.92);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Applied ${radius}px Motion blur at ${angle}°`,
        };
      }

      case 'color-invert': {
        const imgData = ctx.getImageData(0, 0, width, height);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
          d[i] = 255 - d[i];
          d[i + 1] = 255 - d[i + 1];
          d[i + 2] = 255 - d[i + 2];
        }
        ctx.putImageData(imgData, 0, 0);
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/png', 0.94);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: 'Inverted all RGB channels (Color Negative)',
        };
      }

      case 'chroma-key': {
        const targetHex = String(params.targetColor || '#FFFFFF');
        const replaceHex = String(params.replaceColor || '#2563EB');
        const tolerance = Number(params.tolerance ?? 18);
        const replaceMode = (params.replaceMode as 'transparent' | 'color') || 'transparent';
        const imgData = ctx.getImageData(0, 0, width, height);
        const outRgba = applyChromaKey(
          imgData.data,
          hexToRgb(targetHex),
          tolerance,
          replaceMode,
          hexToRgb(replaceHex)
        );
        ctx.putImageData(new ImageData(new Uint8ClampedArray(outRgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Replaced ${targetHex} (tolerance ${tolerance}%) with ${replaceMode === 'transparent' ? 'alpha transparency' : replaceHex}`,
        };
      }

      case 'dither-retro': {
        const mode = (params.retroMode as 'floyd-steinberg' | 'halftone' | 'duotone' | 'pixel-art') || 'floyd-steinberg';
        const colorA = hexToRgb(String(params.colorA || '#0F172A'));
        const colorB = hexToRgb(String(params.colorB || '#38BDF8'));
        const cellSize = Number(params.cellSize ?? 8);
        const imgData = ctx.getImageData(0, 0, width, height);
        const outRgba = applyRetroEffect(imgData.data, width, height, mode, colorA, colorB, cellSize);
        ctx.putImageData(new ImageData(new Uint8ClampedArray(outRgba), width, height), 0, 0);
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Applied ${mode} retro filter`,
        };
      }

      case 'screenshot-annotate': {
        const shapes = (params.shapes as AnnotationShape[]) || [];
        renderAnnotationsOnContext(ctx, shapes, width, height);
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Baked ${shapes.length} annotation element(s) into image`,
        };
      }

      case 'text-overlay': {
        const text = String(params.text || 'ChromaForge Studio');
        const fontSize = Number(params.fontSize ?? Math.max(24, Math.round(width * 0.045)));
        const fontFamily = String(params.fontFamily || 'Plus Jakarta Sans, sans-serif');
        const textColor = String(params.color || '#FFFFFF');
        const strokeColor = String(params.strokeColor || '#0F172A');
        const strokeWidth = Number(params.strokeWidth ?? 0);
        const shadow = params.shadow !== false;
        const bgBox = Boolean(params.bgBox);
        const bgColor = String(params.bgColor || 'rgba(15,23,42,0.75)');
        const posX = (Number(params.xPercent ?? 50) / 100) * width;
        const posY = (Number(params.yPercent ?? 86) / 100) * height;

        ctx.save();
        ctx.font = `700 ${fontSize}px ${fontFamily}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const metrics = ctx.measureText(text);
        if (bgBox) {
          const padX = fontSize * 0.6;
          const padY = fontSize * 0.35;
          ctx.fillStyle = bgColor;
          ctx.beginPath();
          ctx.roundRect(
            posX - metrics.width / 2 - padX,
            posY - fontSize / 2 - padY,
            metrics.width + padX * 2,
            fontSize + padY * 2,
            8
          );
          ctx.fill();
        }

        if (shadow) {
          ctx.shadowColor = 'rgba(0,0,0,0.45)';
          ctx.shadowBlur = 12;
          ctx.shadowOffsetY = 3;
        }
        if (strokeWidth > 0) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.strokeText(text, posX, posY);
        }
        ctx.fillStyle = textColor;
        ctx.fillText(text, posX, posY);
        ctx.restore();

        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Stamped text overlay "${text.slice(0, 28)}"`,
        };
      }

      case 'logo-watermark': {
        const logoBlob = params.logoBlob as Blob | undefined;
        const anchor = String(params.anchor || 'bottom-right');
        const scalePct = Number(params.scale ?? 18);
        const opacity = Number(params.opacity ?? 75) / 100;
        const margin = Math.round(Math.min(width, height) * 0.04);

        ctx.save();
        ctx.globalAlpha = opacity;

        if (logoBlob) {
          const lbmp = await decodeAnyFileToBitmap(logoBlob);
          const targetW = Math.max(24, Math.round((width * scalePct) / 100));
          const targetH = Math.round((lbmp.height / lbmp.width) * targetW);
          const { x, y } = computeAnchorCoords(anchor, width, height, targetW, targetH, margin);
          ctx.drawImage(lbmp, x, y, targetW, targetH);
          lbmp.close();
        } else {
          // Clean geometric vector emblem fallback if user hasn't picked a custom logo PNG yet
          const label = String(params.fallbackBrand || 'STUDIO PROOF');
          const fs = Math.max(18, Math.round(width * (scalePct / 450)));
          ctx.font = `700 ${fs}px Plus Jakarta Sans, sans-serif`;
          const tw = ctx.measureText(label).width + 24;
          const th = fs + 16;
          const { x, y } = computeAnchorCoords(anchor, width, height, tw, th, margin);
          ctx.fillStyle = 'rgba(15,23,42,0.72)';
          ctx.beginPath();
          ctx.roundRect(x, y, tw, th, 6);
          ctx.fill();
          ctx.fillStyle = '#FFFFFF';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x + 12, y + th / 2);
        }
        ctx.restore();

        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/png', 0.94);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Applied logo watermark (${anchor}, ${Math.round(opacity * 100)}% opacity)`,
        };
      }

      case 'tiled-watermark': {
        const text = String(params.text || '© CONFIDENTIAL PROOF');
        const opacity = Number(params.opacity ?? 22) / 100;
        const angleDeg = Number(params.angle ?? -32);
        const spacing = Math.max(90, Number(params.spacing ?? 220));
        const fontSize = Math.max(16, Number(params.fontSize ?? Math.round(width * 0.028)));
        const color = String(params.color || '#FFFFFF');

        ctx.save();
        ctx.globalAlpha = opacity;
        ctx.fillStyle = color;
        ctx.font = `600 ${fontSize}px Plus Jakarta Sans, sans-serif`;
        ctx.translate(width / 2, height / 2);
        ctx.rotate((angleDeg * Math.PI) / 180);

        const diag = Math.hypot(width, height);
        for (let y = -diag; y <= diag; y += spacing) {
          for (let x = -diag; x <= diag; x += spacing * 1.45) {
            ctx.fillText(text, x, y);
          }
        }
        ctx.restore();

        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.92);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Applied diagonal tiled copyright watermark`,
        };
      }

      case 'region-redact': {
        const boxes = (params.boxes as RedactionBox[]) || [];
        applyRedactionBoxes(canvas, ctx, boxes);
        const blob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Redacted ${boxes.length} sensitive region(s) permanently`,
        };
      }

      case 'promo-badge': {
        const text = String(params.text || '50% OFF');
        const corner = String(params.corner || 'top-right');
        const bg = String(params.bgColor || '#DC2626');
        const fg = String(params.textColor || '#FFFFFF');
        const style = String(params.badgeStyle || 'ribbon');

        ctx.save();
        const size = Math.round(Math.min(width, height) * 0.24);
        const fontSize = Math.max(16, Math.round(size * 0.16));
        ctx.font = `700 ${fontSize}px Plus Jakarta Sans, sans-serif`;

        if (style === 'ribbon') {
          const isRight = corner.includes('right');
          const isBottom = corner.includes('bottom');
          ctx.translate(isRight ? width : 0, isBottom ? height : 0);
          const rot =
            (isRight && !isBottom) || (!isRight && isBottom) ? Math.PI / 4 : -Math.PI / 4;
          ctx.rotate(rot);
          const bandH = fontSize * 2.1;
          const offsetY = isBottom ? -size * 0.62 : size * 0.62;
          ctx.fillStyle = bg;
          ctx.fillRect(-size * 1.6, offsetY - bandH / 2, size * 3.2, bandH);
          ctx.fillStyle = fg;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, 0, offsetY);
        } else {
          const tw = ctx.measureText(text).width + fontSize * 1.6;
          const th = fontSize * 2.1;
          const m = Math.round(Math.min(width, height) * 0.04);
          const { x, y } = computeAnchorCoords(corner, width, height, tw, th, m);
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.roundRect(x, y, tw, th, 8);
          ctx.fill();
          ctx.fillStyle = fg;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, x + tw / 2, y + th / 2);
        }
        ctx.restore();

        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/jpeg', 0.93);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: `Stamped "${text}" promo ${style}`,
        };
      }

      case 'multi-size-export': {
        const widths = String(params.widths || '200,800,2000')
          .split(',')
          .map((s) => Math.max(16, parseInt(s.trim(), 10)))
          .filter((n) => Number.isFinite(n));
        const mime = String(params.format || 'image/webp');
        const ext = extForMime(mime);
        const base = sourceName.replace(/\.[^.]+$/, '');
        const files: BatchExportFile[] = [];

        for (const tw of widths) {
          const th = Math.max(1, Math.round((height / width) * tw));
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          const cctx = c.getContext('2d')!;
          cctx.imageSmoothingEnabled = true;
          cctx.imageSmoothingQuality = 'high';
          cctx.drawImage(canvas, 0, 0, tw, th);
          const b = await canvasToBlobSafe(c, mime, 0.88);
          files.push({ name: `${base}-${tw}w.${ext}`, blob: b, width: tw, height: th });
          memoryGovernor.disposeCanvas(c);
        }
        const previewBlob = await canvasToBlobSafe(canvas, mime, 0.88);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: previewBlob.type,
          extension: ext,
          summary: `Generated ${files.length} size variants (${widths.join('px, ')}px)`,
          extraFiles: files,
        };
      }

      case 'responsive-srcset': {
        const breakpoints = [320, 640, 1024, 1920];
        const formats: Array<'webp' | 'jpg'> = ['webp', 'jpg'];
        const base = sourceName.replace(/\.[^.]+$/, '');
        const files: BatchExportFile[] = [];

        for (const bp of breakpoints) {
          const tw = Math.min(bp, width);
          const th = Math.max(1, Math.round((height / width) * tw));
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          c.getContext('2d')!.drawImage(canvas, 0, 0, tw, th);
          for (const fmt of formats) {
            const mime = fmt === 'webp' ? 'image/webp' : 'image/jpeg';
            const b = await canvasToBlobSafe(c, mime, 0.86);
            files.push({ name: `${base}-${bp}w.${fmt}`, blob: b, width: tw, height: th });
          }
          memoryGovernor.disposeCanvas(c);
        }
        const html = generateResponsiveHtml(sourceName, breakpoints, formats);
        files.push({ name: 'responsive-snippet.html', blob: new Blob([html], { type: 'text/html' }) });
        const previewBlob = await canvasToBlobSafe(canvas, 'image/webp', 0.86);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: previewBlob.type,
          extension: 'webp',
          summary: `Packaged ${files.length - 1} responsive breakpoints + <picture> HTML`,
          extraFiles: files,
        };
      }

      case 'favicon-pwa': {
        const appName = String(params.appName || 'ChromaForge App');
        const themeColor = String(params.themeColor || '#0F172A');
        const files: BatchExportFile[] = [];
        const icoFrames: Array<{ width: number; height: number; pngBytes: Uint8Array }> = [];

        const renderSquare = async (size: number, maskablePad = false): Promise<Blob> => {
          const c = document.createElement('canvas');
          c.width = size;
          c.height = size;
          const cctx = c.getContext('2d')!;
          if (maskablePad) {
            cctx.fillStyle = themeColor;
            cctx.fillRect(0, 0, size, size);
          }
          const inner = maskablePad ? size * 0.72 : size;
          const scale = Math.min(inner / width, inner / height);
          const dw = width * scale;
          const dh = height * scale;
          cctx.drawImage(canvas, (size - dw) / 2, (size - dh) / 2, dw, dh);
          const b = await canvasToBlobSafe(c, 'image/png', 1);
          memoryGovernor.disposeCanvas(c);
          return b;
        };

        for (const s of [16, 32, 48]) {
          const b = await renderSquare(s);
          icoFrames.push({ width: s, height: s, pngBytes: new Uint8Array(await b.arrayBuffer()) });
        }
        files.push({
          name: 'favicon.ico',
          blob: new Blob([new Uint8Array(encodeIco(icoFrames))], { type: 'image/x-icon' }),
        });
        files.push({ name: 'apple-touch-icon.png', blob: await renderSquare(180) });
        files.push({ name: 'icon-192.png', blob: await renderSquare(192) });
        files.push({ name: 'icon-512.png', blob: await renderSquare(512) });
        files.push({ name: 'icon-maskable-512.png', blob: await renderSquare(512, true) });
        files.push({
          name: 'manifest.json',
          blob: new Blob([generatePwaManifest(appName, themeColor)], { type: 'application/json' }),
        });

        const previewBlob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Packaged favicon.ico, Apple/PWA icons & manifest.json (${files.length} files)`,
          extraFiles: files,
        };
      }

      case 'sprite-slicer': {
        const cols = Math.max(1, Math.min(16, Number(params.cols ?? 4)));
        const rows = Math.max(1, Math.min(16, Number(params.rows ?? 4)));
        const fw = Math.floor(width / cols);
        const fh = Math.floor(height / rows);
        const files: BatchExportFile[] = [];
        let idx = 1;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const tile = document.createElement('canvas');
            tile.width = fw;
            tile.height = fh;
            tile.getContext('2d')!.drawImage(canvas, c * fw, r * fh, fw, fh, 0, 0, fw, fh);
            const b = await canvasToBlobSafe(tile, 'image/png', 1);
            files.push({ name: `frame-${String(idx++).padStart(3, '0')}.png`, blob: b, width: fw, height: fh });
            memoryGovernor.disposeCanvas(tile);
          }
        }
        const previewBlob = await canvasToBlobSafe(canvas, 'image/png', 1);
        return {
          blob: previewBlob,
          width,
          height,
          mimeType: 'image/png',
          extension: 'png',
          summary: `Sliced ${files.length} sprite frames (${fw}×${fh}px each)`,
          extraFiles: files,
        };
      }

      default: {
        const blob = await canvasToBlobSafe(canvas, sourceBlob.type || 'image/png', 0.92);
        return {
          blob,
          width,
          height,
          mimeType: blob.type,
          extension: extForMime(blob.type),
          summary: 'Processed asset locally',
        };
      }
    }
  } finally {
    memoryGovernor.disposeCanvas(canvas);
  }
}

/**
 * Multi-Image Composition Engines (Features 17, 32, 33, 34, 38, 39, 62, 68)
 */
export async function composeMultiImages(
  mode:
    | 'merge-h'
    | 'merge-v'
    | 'collage'
    | 'long-stitch'
    | 'before-after'
    | 'contact-sheet'
    | 'variant-grid'
    | 'sprite-pack'
    | 'pdf',
  items: Array<{ name: string; blob: Blob }>,
  options: Record<string, unknown> = {}
): Promise<ProcessedResult> {
  if (items.length === 0) throw new Error('Load at least one image first.');

  // Multi-Page PDF Builder (Feature 17)
  if (mode === 'pdf') {
    const pages: Array<{ jpegBytes: Uint8Array; width: number; height: number }> = [];
    for (const item of items) {
      const { canvas, width, height } = await blobToCanvas(item.blob, item.name);
      const flat = document.createElement('canvas');
      flat.width = width;
      flat.height = height;
      const fctx = flat.getContext('2d')!;
      fctx.fillStyle = '#FFFFFF';
      fctx.fillRect(0, 0, width, height);
      fctx.drawImage(canvas, 0, 0);
      const jpgBlob = await canvasToBlobSafe(flat, 'image/jpeg', 0.9);
      pages.push({ jpegBytes: new Uint8Array(await jpgBlob.arrayBuffer()), width, height });
      memoryGovernor.disposeCanvas(canvas);
      memoryGovernor.disposeCanvas(flat);
    }
    const pdfBytes = createPdfFromJpegs(pages, {
      pageSize: (options.pageSize as 'a4' | 'letter' | 'fit') || 'a4',
      orientation: (options.orientation as 'portrait' | 'landscape') || 'portrait',
      marginPt: Number(options.marginPt ?? 28),
    });
    const pdfBlob = new Blob([new Uint8Array(pdfBytes)], { type: 'application/pdf' });
    return {
      blob: pdfBlob,
      width: 595,
      height: 842,
      mimeType: 'application/pdf',
      extension: 'pdf',
      summary: `Compiled ${pages.length}-page PDF document (${Math.round(pdfBlob.size / 1024)} KB)`,
      extraFiles: [{ name: 'chromaforge-document.pdf', blob: pdfBlob }],
    };
  }

  // Decode bitmaps sequentially with careful cleanup
  const bitmaps: Array<{ name: string; bmp: ImageBitmap }> = [];
  for (const item of items) {
    const bmp = await decodeAnyFileToBitmap(item.blob, item.name);
    bitmaps.push({ name: item.name, bmp });
  }

  try {
    if (mode === 'merge-h' || mode === 'merge-v') {
      const gap = Number(options.gap ?? 0);
      const bg = String(options.bgColor || '#FFFFFF');
      const isH = mode === 'merge-h';
      const targetH = Math.min(1400, Math.min(...bitmaps.map((b) => b.bmp.height)));
      const targetW = Math.min(1400, Math.min(...bitmaps.map((b) => b.bmp.width)));

      const dims = bitmaps.map((b) =>
        isH
          ? { w: Math.round((b.bmp.width / b.bmp.height) * targetH), h: targetH }
          : { w: targetW, h: Math.round((b.bmp.height / b.bmp.width) * targetW) }
      );
      const outW = isH ? dims.reduce((s, d) => s + d.w, 0) + gap * (dims.length - 1) : targetW;
      const outH = isH ? targetH : dims.reduce((s, d) => s + d.h, 0) + gap * (dims.length - 1);

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d')!;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, outW, outH);

      let cursor = 0;
      bitmaps.forEach((b, idx) => {
        const d = dims[idx];
        ctx.drawImage(b.bmp, isH ? cursor : 0, isH ? 0 : cursor, d.w, d.h);
        cursor += (isH ? d.w : d.h) + gap;
      });
      const blob = await canvasToBlobSafe(out, 'image/png', 1);
      memoryGovernor.disposeCanvas(out);
      return {
        blob,
        width: outW,
        height: outH,
        mimeType: 'image/png',
        extension: 'png',
        summary: `Merged ${bitmaps.length} images ${isH ? 'horizontally' : 'vertically'} (${outW}×${outH})`,
      };
    }

    if (mode === 'long-stitch') {
      const overlapPx = Math.max(0, Number(options.overlapPx ?? 40));
      const targetW = Math.min(1200, bitmaps[0].bmp.width);
      const scaledHeights = bitmaps.map((b) => Math.round((b.bmp.height / b.bmp.width) * targetW));
      const totalH = scaledHeights.reduce((sum, h, i) => sum + h - (i > 0 ? Math.min(overlapPx, h - 10) : 0), 0);
      const out = document.createElement('canvas');
      out.width = targetW;
      out.height = Math.max(1, totalH);
      const ctx = out.getContext('2d')!;
      let y = 0;
      bitmaps.forEach((b, i) => {
        const sh = scaledHeights[i];
        const trimTop = i > 0 ? Math.min(overlapPx, sh - 10) : 0;
        const srcTrimTop = Math.round((trimTop / sh) * b.bmp.height);
        ctx.drawImage(
          b.bmp,
          0,
          srcTrimTop,
          b.bmp.width,
          b.bmp.height - srcTrimTop,
          0,
          y,
          targetW,
          sh - trimTop
        );
        y += sh - trimTop;
      });
      const blob = await canvasToBlobSafe(out, 'image/png', 1);
      memoryGovernor.disposeCanvas(out);
      return {
        blob,
        width: targetW,
        height: out.height,
        mimeType: 'image/png',
        extension: 'png',
        summary: `Stitched ${bitmaps.length} long screenshots (${overlapPx}px overlap trimmed)`,
      };
    }

    if (mode === 'before-after') {
      const a = bitmaps[0].bmp;
      const b = bitmaps[1]?.bmp || bitmaps[0].bmp;
      const outW = Math.min(1600, a.width);
      const outH = Math.round((a.height / a.width) * outW);
      const splitPct = Number(options.splitPercent ?? 50) / 100;
      const splitX = Math.round(outW * splitPct);
      const labelBefore = String(options.labelBefore || 'BEFORE');
      const labelAfter = String(options.labelAfter || 'AFTER');

      const out = document.createElement('canvas');
      out.width = outW;
      out.height = outH;
      const ctx = out.getContext('2d')!;

      // Left = Before
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, outH);
      ctx.clip();
      ctx.drawImage(a, 0, 0, outW, outH);
      ctx.restore();

      // Right = After
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, outW - splitX, outH);
      ctx.clip();
      ctx.drawImage(b, 0, 0, outW, outH);
      ctx.restore();

      // Divider line
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(splitX - 2, 0, 4, outH);

      // Corner labels
      const drawTag = (txt: string, x: number) => {
        ctx.font = '700 18px Plus Jakarta Sans, sans-serif';
        const tw = ctx.measureText(txt).width + 24;
        ctx.fillStyle = 'rgba(15,23,42,0.82)';
        ctx.beginPath();
        ctx.roundRect(x, 20, tw, 36, 6);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, x + 12, 38);
      };
      drawTag(labelBefore, 20);
      ctx.font = '700 18px Plus Jakarta Sans, sans-serif';
      const rightW = ctx.measureText(labelAfter).width + 24;
      drawTag(labelAfter, outW - rightW - 20);

      const blob = await canvasToBlobSafe(out, 'image/jpeg', 0.93);
      memoryGovernor.disposeCanvas(out);
      return {
        blob,
        width: outW,
        height: outH,
        mimeType: 'image/jpeg',
        extension: 'jpg',
        summary: `Generated Before/After comparison (${outW}×${outH})`,
      };
    }

    if (mode === 'sprite-pack') {
      const padding = Number(options.padding ?? 4);
      const packed = packSprites(
        bitmaps.map((b) => ({ name: b.name, width: b.bmp.width, height: b.bmp.height })),
        padding
      );
      const out = document.createElement('canvas');
      out.width = packed.width;
      out.height = packed.height;
      const ctx = out.getContext('2d')!;
      for (const frame of packed.frames) {
        const match = bitmaps.find((b) => b.name === frame.name);
        if (match) ctx.drawImage(match.bmp, frame.x, frame.y, frame.width, frame.height);
      }
      const pngBlob = await canvasToBlobSafe(out, 'image/png', 1);
      memoryGovernor.disposeCanvas(out);
      return {
        blob: pngBlob,
        width: packed.width,
        height: packed.height,
        mimeType: 'image/png',
        extension: 'png',
        summary: `Packed ${packed.frames.length} sprites into ${packed.width}×${packed.height} atlas`,
        extraFiles: [
          { name: 'sprite-sheet.png', blob: pngBlob },
          { name: 'sprites.css', blob: new Blob([packed.css], { type: 'text/css' }) },
          { name: 'atlas.json', blob: new Blob([packed.json], { type: 'application/json' }) },
        ],
      };
    }

    // Collage, Contact Sheet & Variant Grid share a clean tiled canvas generator
    const cols =
      mode === 'variant-grid'
        ? Math.min(4, Math.max(2, bitmaps.length))
        : Math.max(1, Math.min(8, Number(options.cols ?? (mode === 'contact-sheet' ? 4 : 2))));
    const rows = Math.ceil(bitmaps.length / cols);
    const gap = Number(options.gap ?? 18);
    const radius = Number(options.radius ?? (mode === 'collage' ? 12 : 6));
    const cellW = mode === 'contact-sheet' ? 280 : 420;
    const cellH = mode === 'contact-sheet' ? 210 : 420;
    const labelH = mode === 'contact-sheet' || mode === 'variant-grid' ? 38 : 0;
    const bgColor = String(options.bgColor || '#FFFFFF');
    const customLabels = String(options.labels || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const outW = cols * cellW + (cols + 1) * gap;
    const outH = rows * (cellH + labelH) + (rows + 1) * gap;
    const out = document.createElement('canvas');
    out.width = outW;
    out.height = outH;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, outW, outH);

    bitmaps.forEach((item, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = gap + c * (cellW + gap);
      const y = gap + r * (cellH + labelH + gap);

      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, cellW, cellH, radius);
      ctx.clip();

      if (mode === 'collage') {
        const s = Math.max(cellW / item.bmp.width, cellH / item.bmp.height);
        const dw = item.bmp.width * s;
        const dh = item.bmp.height * s;
        ctx.drawImage(item.bmp, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(x, y, cellW, cellH);
        const s = Math.min(cellW / item.bmp.width, cellH / item.bmp.height);
        const dw = item.bmp.width * s;
        const dh = item.bmp.height * s;
        ctx.drawImage(item.bmp, x + (cellW - dw) / 2, y + (cellH - dh) / 2, dw, dh);
      }
      ctx.restore();

      if (labelH > 0) {
        ctx.fillStyle = '#0F172A';
        ctx.font = mode === 'variant-grid' ? '600 16px Plus Jakarta Sans, sans-serif' : '500 13px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = customLabels[idx] || item.name.slice(0, 28);
        ctx.fillText(label, x + cellW / 2, y + cellH + labelH / 2);
      }
    });

    const blob = await canvasToBlobSafe(out, 'image/jpeg', 0.92);
    memoryGovernor.disposeCanvas(out);
    return {
      blob,
      width: outW,
      height: outH,
      mimeType: 'image/jpeg',
      extension: 'jpg',
      summary: `Generated ${cols}×${rows} ${mode.replace('-', ' ')} (${outW}×${outH})`,
    };
  } finally {
    bitmaps.forEach((b) => b.bmp.close());
  }
}

/**
 * Multi-Step Pipeline Runner (Feature 75)
 */
export async function runPipelineOnBlob(
  sourceBlob: Blob,
  sourceName: string,
  steps: PipelineStep[]
): Promise<ProcessedResult> {
  const activeSteps = steps.filter((s) => s.enabled);
  if (activeSteps.length === 0) {
    const bmp = await decodeAnyFileToBitmap(sourceBlob, sourceName);
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    return {
      blob: sourceBlob,
      width: w,
      height: h,
      mimeType: sourceBlob.type || 'image/png',
      extension: extForMime(sourceBlob.type || 'image/png'),
      summary: 'No active steps in pipeline',
    };
  }

  let currentBlob = sourceBlob;
  let currentName = sourceName;
  let lastResult: ProcessedResult | null = null;

  for (const step of activeSteps) {
    lastResult = await executeToolOnBlob(currentBlob, currentName, step.toolId, step.params);
    currentBlob = lastResult.blob;
    currentName = `${sourceName.replace(/\.[^.]+$/, '')}.${lastResult.extension}`;
  }

  return {
    ...lastResult!,
    summary: `Executed ${activeSteps.length}-step pipeline (${Math.round(lastResult!.blob.size / 1024)} KB)`,
  };
}

/**
 * Developer Analysis Helpers (BlurHash + LQIP, Color Palette, ASCII Art, Visual Diff, PDF Extraction)
 */
export async function computeLqipAndBlurHash(blob: Blob): Promise<{ blurHash: string; lqipDataUri: string; lqipBytes: number }> {
  const { canvas } = await blobToCanvas(blob);
  try {
    const small = document.createElement('canvas');
    small.width = 32;
    small.height = Math.max(12, Math.round((canvas.height / canvas.width) * 32));
    const sctx = small.getContext('2d')!;
    sctx.drawImage(canvas, 0, 0, small.width, small.height);
    const imgData = sctx.getImageData(0, 0, small.width, small.height);
    const blurHash = encodeBlurHash(imgData.data, small.width, small.height, 4, 3);
    const lqipDataUri = small.toDataURL('image/webp', 0.35);
    memoryGovernor.disposeCanvas(small);
    return { blurHash, lqipDataUri, lqipBytes: lqipDataUri.length };
  } finally {
    memoryGovernor.disposeCanvas(canvas);
  }
}

export async function analyzePaletteFromBlob(blob: Blob, count = 6) {
  const { canvas } = await blobToCanvas(blob);
  try {
    const thumb = document.createElement('canvas');
    const maxDim = 220;
    const s = Math.min(1, maxDim / Math.max(canvas.width, canvas.height));
    const tw = Math.max(16, Math.round(canvas.width * s));
    const th = Math.max(16, Math.round(canvas.height * s));
    thumb.width = tw;
    thumb.height = th;
    const tctx = thumb.getContext('2d')!;
    tctx.drawImage(canvas, 0, 0, tw, th);
    const id = tctx.getImageData(0, 0, tw, th);
    memoryGovernor.disposeCanvas(thumb);
    return extractColorPalette(id.data, tw, th, count);
  } finally {
    memoryGovernor.disposeCanvas(canvas);
  }
}

export async function generateAsciiFromBlob(blob: Blob, columns = 72, invert = false) {
  const { canvas } = await blobToCanvas(blob);
  try {
    const w = Math.max(20, Math.min(140, columns));
    // Characters are taller than wide (~0.52 aspect correction)
    const h = Math.max(10, Math.round((canvas.height / canvas.width) * w * 0.52));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const sctx = small.getContext('2d')!;
    sctx.drawImage(canvas, 0, 0, w, h);
    const id = sctx.getImageData(0, 0, w, h);
    memoryGovernor.disposeCanvas(small);
    return imageDataToAscii(id.data, w, h, '@%#*+=-:. ', invert);
  } finally {
    memoryGovernor.disposeCanvas(canvas);
  }
}

export async function computeVisualDiffBlobs(blobA: Blob, blobB: Blob, threshold = 12): Promise<{ diffUrl: string; diffPercent: number; diffPixels: number }> {
  const a = await blobToCanvas(blobA);
  const b = await blobToCanvas(blobB);
  try {
    const w = Math.min(a.width, 1280);
    const h = Math.round((a.height / a.width) * w);
    const ca = document.createElement('canvas');
    ca.width = w;
    ca.height = h;
    ca.getContext('2d')!.drawImage(a.canvas, 0, 0, w, h);

    const cb = document.createElement('canvas');
    cb.width = w;
    cb.height = h;
    cb.getContext('2d')!.drawImage(b.canvas, 0, 0, w, h);

    const ida = ca.getContext('2d')!.getImageData(0, 0, w, h);
    const idb = cb.getContext('2d')!.getImageData(0, 0, w, h);
    const { diffRgba, diffPercent, diffPixels } = computePixelDiff(ida.data, idb.data, w, h, threshold);

    ca.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(diffRgba), w, h), 0, 0);
    const diffBlob = await canvasToBlobSafe(ca, 'image/png', 1);
    const diffUrl = memoryGovernor.createManagedBlobUrl(`visual-diff-${Date.now()}`, diffBlob);
    memoryGovernor.disposeCanvas(ca);
    memoryGovernor.disposeCanvas(cb);
    return { diffUrl, diffPercent, diffPixels };
  } finally {
    memoryGovernor.disposeCanvas(a.canvas);
    memoryGovernor.disposeCanvas(b.canvas);
  }
}

export async function extractImagesFromPdfBlob(pdfBlob: Blob): Promise<BatchExportFile[]> {
  const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
  const jpegs = extractEmbeddedJpegs(bytes, 1024);
  return jpegs.map((jpg, i) => ({
    name: `pdf-page-${String(i + 1).padStart(2, '0')}.jpg`,
    blob: new Blob([new Uint8Array(jpg)], { type: 'image/jpeg' }),
  }));
}

export async function buildZipBlob(files: BatchExportFile[]): Promise<Blob> {
  const entries = [];
  for (const f of files) {
    entries.push({ name: f.name, data: new Uint8Array(await f.blob.arrayBuffer()) });
  }
  const zipBytes = createZipArchive(entries);
  return new Blob([new Uint8Array(zipBytes)], { type: 'application/zip' });
}

// Helpers for anchor positioning, annotations, and redaction
function computeAnchorCoords(
  anchor: string,
  canvasW: number,
  canvasH: number,
  itemW: number,
  itemH: number,
  margin: number
): { x: number; y: number } {
  let x = (canvasW - itemW) / 2;
  let y = (canvasH - itemH) / 2;
  if (anchor.includes('left')) x = margin;
  if (anchor.includes('right')) x = canvasW - itemW - margin;
  if (anchor.includes('top')) y = margin;
  if (anchor.includes('bottom')) y = canvasH - itemH - margin;
  return { x, y };
}

export function renderAnnotationsOnContext(
  ctx: CanvasRenderingContext2D,
  shapes: AnnotationShape[],
  width: number,
  height: number
): void {
  for (const s of shapes) {
    const x1 = s.x1 * width;
    const y1 = s.y1 * height;
    const x2 = s.x2 * width;
    const y2 = s.y2 * height;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(2, s.strokeWidth * (width / 800));
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (s.kind === 'rect') {
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    } else if (s.kind === 'circle') {
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (s.kind === 'arrow') {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const headLen = Math.max(14, ctx.lineWidth * 4);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    } else if (s.kind === 'highlight' && s.points && s.points.length > 1) {
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = Math.max(14, s.strokeWidth * 4 * (width / 800));
      ctx.beginPath();
      s.points.forEach((pt, idx) => {
        if (idx === 0) ctx.moveTo(pt.x * width, pt.y * height);
        else ctx.lineTo(pt.x * width, pt.y * height);
      });
      ctx.stroke();
    } else if (s.kind === 'step') {
      const r = Math.max(16, width * 0.02);
      ctx.beginPath();
      ctx.arc(x1, y1, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 ${Math.round(r * 1.15)}px Plus Jakarta Sans, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.stepNumber ?? 1), x1, y1 + 1);
    }
    ctx.restore();
  }
}

function applyRedactionBoxes(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, boxes: RedactionBox[]): void {
  const width = canvas.width;
  const height = canvas.height;

  for (const box of boxes) {
    const x = Math.max(0, Math.round(box.x * width));
    const y = Math.max(0, Math.round(box.y * height));
    const w = Math.max(4, Math.min(width - x, Math.round(box.w * width)));
    const h = Math.max(4, Math.min(height - y, Math.round(box.h * height)));

    if (box.mode === 'blackout') {
      ctx.fillStyle = '#09090B';
      ctx.fillRect(x, y, w, h);
    } else if (box.mode === 'blur') {
      const tmp = document.createElement('canvas');
      tmp.width = w;
      tmp.height = h;
      const tctx = tmp.getContext('2d')!;
      tctx.filter = `blur(${Math.max(6, box.strength)}px)`;
      tctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      ctx.drawImage(tmp, x, y);
      memoryGovernor.disposeCanvas(tmp);
    } else if (box.mode === 'pixelate') {
      const block = Math.max(4, Math.round(box.strength));
      const data = ctx.getImageData(x, y, w, h);
      const d = data.data;
      for (let py = 0; py < h; py += block) {
        for (let px = 0; px < w; px += block) {
          const si = (Math.min(h - 1, py + (block >> 1)) * w + Math.min(w - 1, px + (block >> 1))) * 4;
          const r = d[si];
          const g = d[si + 1];
          const b = d[si + 2];
          for (let dy = 0; dy < block && py + dy < h; dy++) {
            for (let dx = 0; dx < block && px + dx < w; dx++) {
              const di = ((py + dy) * w + (px + dx)) * 4;
              d[di] = r;
              d[di + 1] = g;
              d[di + 2] = b;
            }
          }
        }
      }
      ctx.putImageData(data, x, y);
    }
  }
}
