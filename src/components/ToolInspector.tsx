import {
  Check,
  Copy,
  Download,
  ExternalLink,
  FileUp,
  Play,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { TOOL_BY_ID } from '../data/toolsCatalog';
import { inspectJpegEncoding, parseExifMetadata } from '../engine/binaryCodecs';
import {
  generateResponsiveHtml,
  minifySvg,
  svgToDataUri,
  svgToJsx,
} from '../engine/dspAlgorithms';
import { saveBlobToDisk } from '../engine/fileExplorer';
import {
  analyzePaletteFromBlob,
  buildZipBlob,
  computeLqipAndBlurHash,
  computeVisualDiffBlobs,
  extractImagesFromPdfBlob,
  generateAsciiFromBlob,
} from '../engine/imageProcessor';
import { formatBytes } from '../engine/memoryGovernor';
import { opfsVault } from '../engine/opfsVault';
import {
  AnnotationShape,
  BatchExportFile,
  ExifMetadata,
  PaletteColor,
  PerspectiveQuad,
  RedactionBox,
  StudioAsset,
  ToolId,
  WorkspaceTab,
} from '../types/studio';

interface ToolInspectorProps {
  activeToolId: ToolId;
  activeAsset: StudioAsset | null;
  assets: StudioAsset[];
  isProcessing: boolean;
  lastSummary: string;
  onApplyTool: (toolId: ToolId, params: Record<string, unknown>) => Promise<BatchExportFile[] | undefined>;
  onComposeMulti: (
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
    options: Record<string, unknown>
  ) => Promise<void>;
  onImportDecodedBlob: (blob: Blob, name: string) => Promise<void>;
  onNavigateTab: (tab: WorkspaceTab) => void;
  // Interactive canvas callbacks
  annotations: AnnotationShape[];
  onChangeAnnotations: (shapes: AnnotationShape[]) => void;
  activeAnnotateKind: AnnotationShape['kind'];
  onChangeAnnotateKind: (kind: AnnotationShape['kind']) => void;
  annotateColor: string;
  onChangeAnnotateColor: (c: string) => void;
  redactionBoxes: RedactionBox[];
  onChangeRedactionBoxes: (boxes: RedactionBox[]) => void;
  activeRedactMode: RedactionBox['mode'];
  onChangeRedactMode: (mode: RedactionBox['mode']) => void;
  perspectiveQuad: PerspectiveQuad;
  onResetPerspectiveQuad: () => void;
  passportStandard: string;
  onChangePassportStandard: (std: string) => void;
  onUpdateVisualDiff: (url: string | null, viewMode: 'slider' | 'onion' | 'heatmap', opacity: number) => void;
}

const DEFAULT_SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <!-- Studio Sample Mark -->
  <rect x="8" y="8" width="112" height="112" rx="24" fill="#2563EB" />
  <circle cx="64" cy="64" r="28" fill="none" stroke="#FFFFFF" stroke-width="10.000" />
</svg>`;

export function ToolInspector({
  activeToolId,
  activeAsset,
  assets,
  isProcessing,
  lastSummary,
  onApplyTool,
  onComposeMulti,
  onImportDecodedBlob,
  onNavigateTab,
  annotations,
  onChangeAnnotations,
  activeAnnotateKind,
  onChangeAnnotateKind,
  annotateColor,
  onChangeAnnotateColor,
  redactionBoxes,
  onChangeRedactionBoxes,
  activeRedactMode,
  onChangeRedactMode,
  perspectiveQuad,
  onResetPerspectiveQuad,
  passportStandard,
  onChangePassportStandard,
  onUpdateVisualDiff,
}: ToolInspectorProps) {
  const tool = TOOL_BY_ID[activeToolId];

  // Shared flexible parameters state per tool interaction
  const [targetKb, setTargetKb] = useState(150);
  const [format, setFormat] = useState('image/webp');
  const [quality, setQuality] = useState(82);
  const [allowDownscale, setAllowDownscale] = useState(true);
  const [quantColors, setQuantColors] = useState(64);
  const [quantDither, setQuantDither] = useState(true);
  const [subsampling, setSubsampling] = useState<'4:4:4' | '4:2:2' | '4:2:0'>('4:4:4');
  const [animFps, setAnimFps] = useState(8);
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [svgScale, setSvgScale] = useState(2);

  // Geometry state
  const [resizeW, setResizeW] = useState(1200);
  const [resizeH, setResizeH] = useState(800);
  const [lockAspect, setLockAspect] = useState(true);
  const [scaleMode, setScaleMode] = useState<'percent' | 'megapixels'>('percent');
  const [scalePercent, setScalePercent] = useState(50);
  const [maxMp, setMaxMp] = useState(2);
  const [padMode, setPadMode] = useState<'solid' | 'transparent' | 'blur'>('solid');
  const [marginPct, setMarginPct] = useState(8);
  const [socialPreset, setSocialPreset] = useState('1:1');
  const [passportZoom, setPassportZoom] = useState(1);
  const [passportOffsetY, setPassportOffsetY] = useState(0);
  const [sheetSize, setSheetSize] = useState<'4x6' | 'a4'>('4x6');
  const [cutLines, setCutLines] = useState(true);
  const [shapeKind, setShapeKind] = useState<'circle' | 'rounded' | 'hexagon' | 'star'>('circle');
  const [rotateAngle, setRotateAngle] = useState(90);
  const [trimTol, setTrimTol] = useState(18);
  const [trimPad, setTrimPad] = useState(8);

  // Layout state
  const [splitMode, setSplitMode] = useState<'3x3' | 'carousel'>('3x3');
  const [carouselCols, setCarouselCols] = useState(4);
  const [blendMode, setBlendMode] = useState('multiply');
  const [blendOpacity, setBlendOpacity] = useState(65);
  const [mockupStyle, setMockupStyle] = useState<'browser' | 'phone' | 'card'>('browser');
  const [mockupGradient, setMockupGradient] = useState('cobalt');

  // Color & Tone state
  const [exposure, setExposure] = useState({ brightness: 0, contrast: 8, exposure: 0, highlights: 0, shadows: 10, gamma: 1 });
  const [vibrance, setVibrance] = useState({ saturation: 10, vibrance: 15, hue: 0, temperature: 0, tint: 0 });
  const [bwPreset, setBwPreset] = useState<'classic' | 'high-contrast' | 'sepia' | 'film' | 'infrared'>('film');
  const [sharpenAmount, setSharpenAmount] = useState(1.2);
  const [blurType, setBlurType] = useState<'gaussian' | 'motion'>('gaussian');
  const [blurRadius, setBlurRadius] = useState(8);
  const [blurAngle, setBlurAngle] = useState(0);
  const [chromaTarget, setChromaTarget] = useState('#FFFFFF');
  const [chromaReplaceMode, setChromaReplaceMode] = useState<'transparent' | 'color'>('transparent');
  const [chromaReplaceColor, setChromaReplaceColor] = useState('#2563EB');
  const [chromaTol, setChromaTol] = useState(18);
  const [retroMode, setRetroMode] = useState<'floyd-steinberg' | 'halftone' | 'duotone' | 'pixel-art'>('duotone');
  const [retroColorA, setRetroColorA] = useState('#0F172A');
  const [retroColorB, setRetroColorB] = useState('#38BDF8');
  const [retroCell, setRetroCell] = useState(8);

  // Annotation / Watermark / EXIF state
  const [overlayText, setOverlayText] = useState('ChromaForge Studio');
  const [overlaySize, setOverlaySize] = useState(42);
  const [overlayColor, setOverlayColor] = useState('#FFFFFF');
  const [overlayBgBox, setOverlayBgBox] = useState(true);
  const [wmAnchor, setWmAnchor] = useState('bottom-right');
  const [wmScale, setWmScale] = useState(18);
  const [wmOpacity, setWmOpacity] = useState(75);
  const [wmLogoBlob, setWmLogoBlob] = useState<Blob | null>(null);
  const [tiledText, setTiledText] = useState('© CONFIDENTIAL PROOF');
  const [tiledOpacity, setTiledOpacity] = useState(22);
  const [exifData, setExifData] = useState<ExifMetadata | null>(null);
  const [jpegInfo, setJpegInfo] = useState<{ isProgressive: boolean; chromaSubsampling: string } | null>(null);
  const [exifCopyright, setExifCopyright] = useState('© 2026 ChromaForge Studio');
  const [exifAuthor, setExifAuthor] = useState('Studio Engineer');
  const [exifDesc, setExifDesc] = useState('Master local studio export');

  // E-Commerce state
  const [marketplace, setMarketplace] = useState('amazon');
  const [promoText, setPromoText] = useState('50% OFF');
  const [promoCorner, setPromoCorner] = useState('top-right');
  const [promoBg, setPromoBg] = useState('#DC2626');
  const [promoStyle, setPromoStyle] = useState<'ribbon' | 'tag'>('ribbon');
  const [multiWidths, setMultiWidths] = useState('200, 800, 2000');

  // Developer Tools state
  const [svgInput, setSvgInput] = useState(DEFAULT_SAMPLE_SVG);
  const [svgComponentName, setSvgComponentName] = useState('BrandMark');
  const [base64Text, setBase64Text] = useState('');
  const [lqipInfo, setLqipInfo] = useState<{ blurHash: string; lqipDataUri: string; lqipBytes: number } | null>(null);
  const [paletteInfo, setPaletteInfo] = useState<{ colors: PaletteColor[]; cssVariables: string } | null>(null);
  const [asciiInfo, setAsciiInfo] = useState<{ text: string; html: string } | null>(null);
  const [asciiCols, setAsciiCols] = useState(64);
  const [asciiColorMode, setAsciiColorMode] = useState(false);
  const [dpiValue, setDpiValue] = useState(300);
  const [sliceCols, setSliceCols] = useState(4);
  const [sliceRows, setSliceRows] = useState(4);
  const [pwaAppName, setPwaAppName] = useState('ChromaForge App');
  const [pwaTheme, setPwaTheme] = useState('#0F172A');
  const [diffMode, setDiffMode] = useState<'slider' | 'onion' | 'heatmap'>('heatmap');
  const [diffOpacity, setDiffOpacity] = useState(50);
  const [diffStats, setDiffStats] = useState<{ diffPercent: number; diffPixels: number } | null>(null);
  const [diffCompareId, setDiffCompareId] = useState('');
  const [extractedPdfFiles, setExtractedPdfFiles] = useState<BatchExportFile[]>([]);
  const [extraExportFiles, setExtraExportFiles] = useState<BatchExportFile[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Sync pixel dimensions when switching active image
  useEffect(() => {
    if (!activeAsset) return;
    setResizeW(activeAsset.width);
    setResizeH(activeAsset.height);
    setExtraExportFiles([]);
  }, [activeAsset?.id, activeAsset?.width, activeAsset?.height]);

  // Auto-run lightweight live analyzers when developer/inspection tools open
  useEffect(() => {
    let cancelled = false;
    if (!activeAsset) return;

    const runAnalysis = async () => {
      const blob = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
      if (!blob || cancelled) return;

      if (activeToolId === 'exif-viewer' || activeToolId === 'exif-editor' || activeToolId === 'dpi-changer') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!cancelled) {
          setExifData(parseExifMetadata(bytes));
        }
      }
      if (activeToolId === 'progressive-jpeg' || activeToolId === 'chroma-subsampling') {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (!cancelled) {
          setJpegInfo(inspectJpegEncoding(bytes));
        }
      }
      if (activeToolId === 'lqip-blurhash') {
        const res = await computeLqipAndBlurHash(blob);
        if (!cancelled) setLqipInfo(res);
      }
      if (activeToolId === 'palette-extractor') {
        const res = await analyzePaletteFromBlob(blob, 6);
        if (!cancelled) setPaletteInfo(res);
      }
      if (activeToolId === 'ascii-art') {
        const res = await generateAsciiFromBlob(blob, asciiCols, false);
        if (!cancelled) setAsciiInfo(res);
      }
      if (activeToolId === 'base64-codec') {
        const reader = new FileReader();
        reader.onload = () => {
          if (!cancelled && typeof reader.result === 'string') {
            setBase64Text(reader.result);
          }
        };
        reader.readAsDataURL(blob);
      }
    };

    runAnalysis().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeToolId, activeAsset?.id, activeAsset?.opfsCurrentPath, asciiCols]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Ignore clipboard permissions in headless mode
    }
  };

  const handleApplyAndCaptureExtras = async (id: ToolId, params: Record<string, unknown>) => {
    const extras = await onApplyTool(id, params);
    if (extras && extras.length > 0) {
      setExtraExportFiles(extras);
    }
  };

  const handleDownloadExtrasZip = async (zipName: string, files = extraExportFiles) => {
    if (files.length === 0) return;
    if (files.length === 1) {
      await saveBlobToDisk(files[0].blob, files[0].name);
      return;
    }
    const zipBlob = await buildZipBlob(files);
    await saveBlobToDisk(zipBlob, zipName);
  };

  const handleRunVisualDiff = async () => {
    if (!activeAsset) return;
    const blobA = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
    const compareAsset = assets.find((a) => a.id === diffCompareId) || activeAsset;
    const blobB =
      compareAsset.id === activeAsset.id
        ? await opfsVault.readBlob(activeAsset.opfsOriginalPath)
        : await opfsVault.readBlob(compareAsset.opfsCurrentPath);
    if (!blobA || !blobB) return;
    const res = await computeVisualDiffBlobs(blobA, blobB, 10);
    setDiffStats({ diffPercent: res.diffPercent, diffPixels: res.diffPixels });
    onUpdateVisualDiff(res.diffUrl, diffMode, diffOpacity);
  };

  const handleDecodeBase64 = async () => {
    const raw = base64Text.trim();
    if (!raw) return;
    const dataUri = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    const res = await fetch(dataUri);
    const blob = await res.blob();
    await onImportDecodedBlob(blob, `decoded-base64.${blob.type.includes('jpeg') ? 'jpg' : 'png'}`);
  };

  const handleExtractPdfFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const extracted = await extractImagesFromPdfBlob(file);
    setExtractedPdfFiles(extracted);
    if (extracted[0]) {
      await onImportDecodedBlob(extracted[0].blob, extracted[0].name);
    }
  };

  if (!tool) return null;

  const svgMinResult = activeToolId === 'svg-minifier' ? minifySvg(svgInput, 2) : null;
  const svgJsxCode = activeToolId === 'svg-to-jsx' ? svgToJsx(svgInput, svgComponentName || 'VectorIcon') : '';
  const svgCssUri = activeToolId === 'svg-to-jsx' ? svgToDataUri(svgInput) : '';
  const responsiveSnippet =
    activeToolId === 'responsive-srcset'
      ? generateResponsiveHtml(activeAsset?.name || 'hero.jpg', [320, 640, 1024, 1920], ['webp', 'jpg'])
      : '';

  return (
    <aside
      aria-label="Tool controls"
      className="w-full lg:w-[348px] shrink-0 border-t lg:border-t-0 lg:border-l border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col lg:h-full overflow-hidden"
    >
      {/* Active Tool Header */}
      <div className="p-4 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-500 dark:text-slate-400">
          <span>Tool {String(tool.number).padStart(2, '0')} / 80</span>
          <span>{tool.supportsBatch ? 'Single & Batch' : 'Interactive Studio'}</span>
        </div>
        <h2 className="mt-1 text-sm font-bold text-slate-900 dark:text-slate-100 leading-snug">
          {tool.name}
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
          {tool.description}
        </p>
      </div>

      {/* Scrollable Controls Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {lastSummary && (
          <div className="px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-700 dark:text-slate-300">
            {lastSummary}
          </div>
        )}

        {/* 1. Target File Size Compressor */}
        {activeToolId === 'target-size' && (
          <div className="space-y-3">
            <div>
              <label htmlFor="target-kb-input" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Exact Max File Size (KB)
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="target-kb-input"
                  type="number"
                  min={10}
                  max={10240}
                  value={targetKb}
                  onChange={(e) => setTargetKb(Number(e.target.value))}
                  className="flex-1 px-3 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
                <div className="flex gap-1">
                  {[50, 150, 500].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setTargetKb(v)}
                      className="px-2 py-1 text-[11px] font-mono bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded"
                    >
                      {v}K
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <label htmlFor="target-fmt" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Codec Format
              </label>
              <select
                id="target-fmt"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
              >
                <option value="image/webp">WebP (Best Size/Quality)</option>
                <option value="image/jpeg">JPEG (Universal)</option>
                <option value="image/avif">AVIF (Next-Gen)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input
                type="checkbox"
                checked={allowDownscale}
                onChange={(e) => setAllowDownscale(e.target.checked)}
              />
              <span>Auto-downscale resolution if quality floor is reached</span>
            </label>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('target-size', { targetKb, format, allowDownscale })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 rounded-lg"
            >
              {isProcessing ? 'Solving binary search...' : `Compress Under ${targetKb} KB`}
            </button>
          </div>
        )}

        {/* 2, 4, 5, 9, 10, 11, 12, 19, 20, 47 — Quality & Format Conversion Controls */}
        {(activeToolId === 'quality-slider' ||
          activeToolId === 'progressive-jpeg' ||
          activeToolId === 'chroma-subsampling' ||
          activeToolId === 'heic-convert' ||
          activeToolId === 'webp-to-standard' ||
          activeToolId === 'standard-to-webp' ||
          activeToolId === 'avif-convert' ||
          activeToolId === 'legacy-to-web' ||
          activeToolId === 'raw-exporter' ||
          activeToolId === 'srgb-standardize') && (
          <div className="space-y-3">
            {jpegInfo && (activeToolId === 'progressive-jpeg' || activeToolId === 'chroma-subsampling') && (
              <div className="text-[11px] font-mono text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md p-2.5">
                Current stream: {jpegInfo.isProgressive ? 'Progressive SOF2' : 'Baseline SOF0'} · Chroma {jpegInfo.chromaSubsampling}
              </div>
            )}

            {activeToolId === 'chroma-subsampling' && (
              <div>
                <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">Chroma Sampling</p>
                <div className="grid grid-cols-3 gap-1.5">
                  {(['4:4:4', '4:2:2', '4:2:0'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setSubsampling(mode)}
                      className={`py-1.5 text-xs font-mono rounded-md border ${
                        subsampling === mode
                          ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold'
                          : 'border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-400'
                      }`}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="codec-format" className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                Output Format
              </label>
              <select
                id="codec-format"
                value={
                  activeToolId === 'progressive-jpeg' || activeToolId === 'chroma-subsampling'
                    ? 'image/jpeg'
                    : activeToolId === 'standard-to-webp'
                    ? 'image/webp'
                    : format
                }
                onChange={(e) => setFormat(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
              >
                <option value="image/webp">WebP (.webp)</option>
                <option value="image/jpeg">JPEG (.jpg)</option>
                <option value="image/png">PNG Lossless (.png)</option>
                <option value="image/avif">AVIF (.avif)</option>
              </select>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <label htmlFor="quality-range" className="font-medium text-slate-700 dark:text-slate-300">
                  Quality
                </label>
                <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">{quality}%</span>
              </div>
              <input
                id="quality-range"
                type="range"
                min={10}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() =>
                handleApplyAndCaptureExtras(activeToolId, {
                  quality,
                  subsampling,
                  format:
                    activeToolId === 'progressive-jpeg' || activeToolId === 'chroma-subsampling'
                      ? 'image/jpeg'
                      : activeToolId === 'standard-to-webp'
                      ? 'image/webp'
                      : activeToolId === 'srgb-standardize'
                      ? 'image/png'
                      : format,
                })
              }
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 rounded-lg"
            >
              {isProcessing ? 'Encoding...' : 'Apply Encoding'}
            </button>
          </div>
        )}

        {/* 3. PNG Color Quantization */}
        {activeToolId === 'png-quantize' && (
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <label htmlFor="quant-colors" className="font-medium text-slate-700 dark:text-slate-300">
                  Palette Size (8-bit indexed)
                </label>
                <span className="font-mono tabular-nums">{quantColors} colors</span>
              </div>
              <input
                id="quant-colors"
                type="range"
                min={4}
                max={256}
                value={quantColors}
                onChange={(e) => setQuantColors(Number(e.target.value))}
                className="w-full"
              />
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={quantDither} onChange={(e) => setQuantDither(e.target.checked)} />
              <span>Floyd-Steinberg error diffusion dithering</span>
            </label>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('png-quantize', { colors: quantColors, dither: quantDither })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 rounded-lg"
            >
              Quantize PNG Palette
            </button>
          </div>
        )}

        {/* 6 & 16. Animated GIF/WebP/APNG */}
        {(activeToolId === 'animated-compress' || activeToolId === 'gif-to-animated') && (
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <label htmlFor="anim-fps" className="font-medium">Frame Rate (FPS)</label>
                <span className="font-mono tabular-nums">{animFps} fps</span>
              </div>
              <input id="anim-fps" type="range" min={1} max={24} value={animFps} onChange={(e) => setAnimFps(Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <label htmlFor="anim-colors" className="font-medium">Color Table Limit</label>
                <span className="font-mono tabular-nums">{quantColors}</span>
              </div>
              <input id="anim-colors" type="range" min={16} max={256} value={quantColors} onChange={(e) => setQuantColors(Number(e.target.value))} className="w-full" />
            </div>
            <p className="text-[11px] text-slate-500">
              Uses all {assets.length} loaded filmstrip frames to encode a compact multi-frame APNG container.
            </p>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras(activeToolId, { fps: animFps, colors: quantColors })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Build Compressed APNG
            </button>
          </div>
        )}

        {/* 7 & 55. Metadata / EXIF Scrubber */}
        {(activeToolId === 'metadata-strip' || activeToolId === 'exif-scrubber') && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              Removes binary APP1 (EXIF/GPS/XMP), APP2 (ICC profiles), APP13 (IPTC), COM comments, and PNG metadata chunks directly on raw bytes without re-compressing pixels.
            </p>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras(activeToolId, {})}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Strip All Metadata & GPS
            </button>
          </div>
        )}

        {/* 13. PNG to JPG with Background Fill */}
        {activeToolId === 'png-to-jpg-fill' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label htmlFor="flatten-bg" className="text-xs font-medium">Background Fill</label>
              <div className="flex items-center gap-2">
                <input id="flatten-bg" type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="w-7 h-7 rounded cursor-pointer" />
                <span className="font-mono text-xs">{bgColor}</span>
              </div>
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span>JPEG Quality</span>
                <span className="font-mono">{quality}%</span>
              </div>
              <input type="range" min={30} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} className="w-full" />
            </div>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('png-to-jpg-fill', { bgColor, quality })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Flatten to JPG
            </button>
          </div>
        )}

        {/* 14. SVG to High-DPI PNG */}
        {activeToolId === 'svg-to-png' && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1.5">
              {[1, 2, 3].map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSvgScale(s)}
                  className={`py-1.5 text-xs font-mono rounded-md border ${
                    svgScale === s ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300 font-semibold' : 'border-slate-200 dark:border-slate-800'
                  }`}
                >
                  {s}x DPI
                </button>
              ))}
            </div>
            <textarea
              rows={5}
              value={svgInput}
              onChange={(e) => setSvgInput(e.target.value)}
              aria-label="Optional raw SVG markup"
              className="w-full p-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
            />
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('svg-to-png', { scale: svgScale, svgMarkup: svgInput })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Rasterize {svgScale}x PNG
            </button>
          </div>
        )}

        {/* 15. Multi-Res ICO Converter */}
        {activeToolId === 'ico-convert' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Bundles crisp 16×16, 32×32, 48×48, and 256×256 PNG frames into a single Windows & browser-compatible binary <code className="text-[11px]">.ico</code> container.
            </p>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('ico-convert', { sizes: [16, 32, 48, 256] })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Build Multi-Res .ICO
            </button>
          </div>
        )}

        {/* 17. Images to Single PDF */}
        {activeToolId === 'images-to-pdf' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Combines all {assets.length} loaded filmstrip images into an A4 portrait PDF 1.4 document.
            </p>
            <button
              type="button"
              disabled={assets.length === 0 || isProcessing}
              onClick={() => onComposeMulti('pdf', { pageSize: 'a4', orientation: 'portrait', marginPt: 28 })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Compile {assets.length} Image(s) to PDF
            </button>
          </div>
        )}

        {/* 18. PDF to Images */}
        {activeToolId === 'pdf-to-images' && (
          <div className="space-y-3">
            <label className="flex flex-col items-center justify-center gap-2 p-4 border border-dashed border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer hover:border-blue-500">
              <FileUp className="w-5 h-5 text-slate-500" />
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">Select local .PDF to extract pages</span>
              <input type="file" accept="application/pdf,.pdf" onChange={handleExtractPdfFile} className="hidden" />
            </label>
            {extractedPdfFiles.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-mono text-emerald-700 dark:text-emerald-400">
                  Extracted {extractedPdfFiles.length} high-res image stream(s)
                </p>
                <button
                  type="button"
                  onClick={() => handleDownloadExtrasZip('pdf-extracted-images.zip', extractedPdfFiles)}
                  className="w-full py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg"
                >
                  Download Extracted Images ZIP
                </button>
              </div>
            )}
          </div>
        )}

        {/* 21. Exact Pixel Resizer */}
        {activeToolId === 'exact-resize' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="exact-w" className="block text-[11px] font-medium mb-1">Width (px)</label>
                <input
                  id="exact-w"
                  type="number"
                  min={1}
                  max={8192}
                  value={resizeW}
                  onChange={(e) => {
                    const nw = Math.max(1, Number(e.target.value));
                    setResizeW(nw);
                    if (lockAspect && activeAsset) {
                      setResizeH(Math.max(1, Math.round((activeAsset.height / activeAsset.width) * nw)));
                    }
                  }}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
              <div>
                <label htmlFor="exact-h" className="block text-[11px] font-medium mb-1">Height (px)</label>
                <input
                  id="exact-h"
                  type="number"
                  min={1}
                  max={8192}
                  value={resizeH}
                  onChange={(e) => {
                    const nh = Math.max(1, Number(e.target.value));
                    setResizeH(nh);
                    if (lockAspect && activeAsset) {
                      setResizeW(Math.max(1, Math.round((activeAsset.width / activeAsset.height) * nh)));
                    }
                  }}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
              <span>Lock original aspect ratio</span>
            </label>
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('exact-resize', { width: resizeW, height: resizeH })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Resize to {resizeW}×{resizeH}
            </button>
          </div>
        )}

        {/* 22. Percentage & Megapixel Scaler */}
        {activeToolId === 'percent-mp-scale' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setScaleMode('percent')}
                className={`py-1.5 text-xs rounded-md border ${scaleMode === 'percent' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}
              >
                Percentage
              </button>
              <button
                type="button"
                onClick={() => setScaleMode('megapixels')}
                className={`py-1.5 text-xs rounded-md border ${scaleMode === 'megapixels' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}
              >
                Max Megapixels
              </button>
            </div>
            {scaleMode === 'percent' ? (
              <div className="space-y-2">
                <div className="flex gap-1.5">
                  {[25, 50, 75].map((pct) => (
                    <button key={pct} type="button" onClick={() => setScalePercent(pct)} className="flex-1 py-1 text-xs font-mono bg-slate-100 dark:bg-slate-800 rounded">
                      {pct}%
                    </button>
                  ))}
                </div>
                <input type="range" min={10} max={200} value={scalePercent} onChange={(e) => setScalePercent(Number(e.target.value))} className="w-full" />
              </div>
            ) : (
              <div>
                <label className="block text-xs mb-1">Max Megapixel Cap ({maxMp} MP)</label>
                <input type="range" min={0.5} max={12} step={0.5} value={maxMp} onChange={(e) => setMaxMp(Number(e.target.value))} className="w-full" />
              </div>
            )}
            <button
              type="button"
              disabled={!activeAsset || isProcessing}
              onClick={() => handleApplyAndCaptureExtras('percent-mp-scale', { mode: scaleMode, percent: scalePercent, megapixels: maxMp })}
              className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              Scale Image
            </button>
          </div>
        )}

        {/* 23. Resize with Padding (Canvas Fit) */}
        {activeToolId === 'canvas-fit-pad' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <input type="number" value={resizeW} onChange={(e) => setResizeW(Number(e.target.value))} aria-label="Canvas width" className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
              <input type="number" value={resizeH} onChange={(e) => setResizeH(Number(e.target.value))} aria-label="Canvas height" className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['solid', 'transparent', 'blur'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setPadMode(m)} className={`py-1.5 text-xs capitalize rounded border ${padMode === m ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {m}
                </button>
              ))}
            </div>
            {padMode === 'solid' && (
              <div className="flex items-center justify-between text-xs">
                <span>Fill Color</span>
                <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
              </div>
            )}
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Margin</span><span className="font-mono">{marginPct}%</span></div>
              <input type="range" min={0} max={30} value={marginPct} onChange={(e) => setMarginPct(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('canvas-fit-pad', { width: resizeW, height: resizeH, padMode, bgColor, marginPercent: marginPct })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Fit with Padding
            </button>
          </div>
        )}

        {/* 24. Social Media Aspect Ratio Presets */}
        {activeToolId === 'social-presets' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {[
                ['1:1', '1:1 Square (1080)'],
                ['4:5', '4:5 IG Portrait'],
                ['9:16', '9:16 Reels/Story'],
                ['16:9', '16:9 HD Landscape'],
                ['youtube', 'YouTube 1280×720'],
                ['linkedin', 'LinkedIn Banner'],
              ].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setSocialPreset(id)} className={`p-2 text-left text-xs rounded-md border ${socialPreset === id ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {label}
                </button>
              ))}
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('social-presets', { preset: socialPreset })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Social Crop
            </button>
          </div>
        )}

        {/* 25. Passport & ID Photo Cropper */}
        {activeToolId === 'passport-id' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-1.5">
              {[
                ['us-2x2', 'US Passport (2×2 in · 600×600 @ 300 DPI)'],
                ['eu-35x45', 'EU / UK / Schengen (35×45 mm @ 300 DPI)'],
                ['visa-35x35', 'Biometric Square (35×35 mm @ 300 DPI)'],
              ].map(([id, label]) => (
                <button key={id} type="button" onClick={() => onChangePassportStandard(id)} className={`p-2 text-left text-xs rounded-md border ${passportStandard === id ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {label}
                </button>
              ))}
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Head Zoom</span><span className="font-mono">{passportZoom.toFixed(2)}x</span></div>
              <input type="range" min={0.8} max={2.0} step={0.05} value={passportZoom} onChange={(e) => setPassportZoom(Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Vertical Alignment</span><span className="font-mono">{passportOffsetY}</span></div>
              <input type="range" min={-40} max={40} value={passportOffsetY} onChange={(e) => setPassportOffsetY(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('passport-id', { standard: passportStandard, zoom: passportZoom, offsetY: passportOffsetY })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Crop 300 DPI ID Photo
            </button>
          </div>
        )}

        {/* 26. Printable ID Sheet Tiler */}
        {activeToolId === 'id-sheet-tiler' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => setSheetSize('4x6')} className={`py-2 text-xs rounded-md border ${sheetSize === '4x6' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>4×6 in (Photo Lab)</button>
              <button type="button" onClick={() => setSheetSize('a4')} className={`py-2 text-xs rounded-md border ${sheetSize === 'a4' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>A4 Sheet</button>
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={cutLines} onChange={(e) => setCutLines(e.target.checked)} />
              <span>Print dashed scissor cut lines</span>
            </label>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('id-sheet-tiler', { sheet: sheetSize, cutLines })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Generate 300 DPI Print Sheet
            </button>
          </div>
        )}

        {/* 27. Shape Cropper */}
        {activeToolId === 'shape-cropper' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {(['circle', 'rounded', 'hexagon', 'star'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setShapeKind(s)} className={`py-2 text-xs capitalize rounded-md border ${shapeKind === s ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {s}
                </button>
              ))}
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('shape-cropper', { shape: shapeKind, radius: 20 })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Mask to Transparent PNG
            </button>
          </div>
        )}

        {/* 28. Rotate & Straighten */}
        {activeToolId === 'rotate-straighten' && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1.5">
              {[-90, 90, 180].map((a) => (
                <button key={a} type="button" onClick={() => setRotateAngle(a)} className="py-1.5 text-xs font-mono bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded">
                  {a > 0 ? `+${a}°` : `${a}°`}
                </button>
              ))}
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Custom Straighten Angle</span><span className="font-mono">{rotateAngle}°</span></div>
              <input type="range" min={-180} max={180} step={0.5} value={rotateAngle} onChange={(e) => setRotateAngle(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('rotate-straighten', { angle: rotateAngle })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply {rotateAngle}° Rotation
            </button>
          </div>
        )}

        {/* 29. Flip / Mirror */}
        {activeToolId === 'flip-mirror' && (
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('flip-mirror', { horizontal: true, vertical: false })} className="py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Flip Horizontal
            </button>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('flip-mirror', { horizontal: false, vertical: true })} className="py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 rounded-lg">
              Flip Vertical
            </button>
          </div>
        )}

        {/* 30. Perspective Deskew */}
        {activeToolId === 'perspective-deskew' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Drag the 4 blue corner handles directly on the canvas around the whiteboard, receipt, or document to solve the projective homography matrix.
            </p>
            <div className="flex gap-2">
              <button type="button" onClick={onResetPerspectiveQuad} className="flex-1 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 rounded-lg">
                Reset Quad
              </button>
              <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('perspective-deskew', { quad: perspectiveQuad })} className="flex-1 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
                Warp & Flatten
              </button>
            </div>
          </div>
        )}

        {/* 31. Auto-Trim Whitespace */}
        {activeToolId === 'auto-trim' && (
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Color Tolerance</span><span className="font-mono">{trimTol}</span></div>
              <input type="range" min={1} max={64} value={trimTol} onChange={(e) => setTrimTol(Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Safety Padding</span><span className="font-mono">{trimPad}px</span></div>
              <input type="range" min={0} max={60} value={trimPad} onChange={(e) => setTrimPad(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('auto-trim', { tolerance: trimTol, padding: trimPad })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Auto-Trim Margins
            </button>
          </div>
        )}

        {/* 32, 33, 34, 38, 39, 62, 68 — Multi-Image Shortcuts */}
        {(activeToolId === 'image-merger' ||
          activeToolId === 'grid-collage' ||
          activeToolId === 'long-stitcher' ||
          activeToolId === 'before-after-gen' ||
          activeToolId === 'contact-sheet' ||
          activeToolId === 'variant-grid' ||
          activeToolId === 'sprite-packer') && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300">
              Uses all {assets.length} loaded filmstrip image(s) to generate the composed layout directly into the editor.
            </p>
            <div className="grid grid-cols-1 gap-2">
              {activeToolId === 'image-merger' ? (
                <>
                  <button type="button" disabled={assets.length === 0 || isProcessing} onClick={() => onComposeMulti('merge-h', { gap: 12 })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
                    Merge Side-by-Side (Horizontal)
                  </button>
                  <button type="button" disabled={assets.length === 0 || isProcessing} onClick={() => onComposeMulti('merge-v', { gap: 12 })} className="w-full py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-slate-100 dark:bg-slate-800 rounded-lg">
                    Merge Stacked (Vertical)
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={assets.length === 0 || isProcessing}
                  onClick={() => {
                    const map: Record<string, Parameters<typeof onComposeMulti>[0]> = {
                      'grid-collage': 'collage',
                      'long-stitcher': 'long-stitch',
                      'before-after-gen': 'before-after',
                      'contact-sheet': 'contact-sheet',
                      'variant-grid': 'variant-grid',
                      'sprite-packer': 'sprite-pack',
                    };
                    onComposeMulti(map[activeToolId], { cols: 2, gap: 16, overlapPx: 40 });
                  }}
                  className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
                >
                  Generate {tool.shortName}
                </button>
              )}
              <button
                type="button"
                onClick={() => onNavigateTab('batch')}
                className="inline-flex items-center justify-center gap-1.5 py-1.5 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
              >
                <span>Open Full Batch Compositor</span>
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          </div>
        )}

        {/* 35. 9-Grid & Carousel Splitter */}
        {activeToolId === 'grid-splitter' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => setSplitMode('3x3')} className={`py-2 text-xs rounded border ${splitMode === '3x3' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>3×3 Instagram Grid</button>
              <button type="button" onClick={() => setSplitMode('carousel')} className={`py-2 text-xs rounded border ${splitMode === 'carousel' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>Carousel Slides</button>
            </div>
            {splitMode === 'carousel' && (
              <div>
                <div className="flex justify-between text-xs mb-1"><span>Slide Count</span><span className="font-mono">{carouselCols} slides</span></div>
                <input type="range" min={2} max={8} value={carouselCols} onChange={(e) => setCarouselCols(Number(e.target.value))} className="w-full" />
              </div>
            )}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('grid-splitter', { splitMode, cols: carouselCols })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Slice & Prepare ZIP
            </button>
          </div>
        )}

        {/* 36. Image Overlay & Blending */}
        {activeToolId === 'overlay-blend' && (
          <div className="space-y-3">
            <select value={blendMode} onChange={(e) => setBlendMode(e.target.value)} aria-label="Blend mode" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
              {['multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'soft-light'].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Overlay Opacity</span><span className="font-mono">{blendOpacity}%</span></div>
              <input type="range" min={5} max={100} value={blendOpacity} onChange={(e) => setBlendOpacity(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('overlay-blend', { blendMode, opacity: blendOpacity })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Blend with Next Filmstrip Image
            </button>
          </div>
        )}

        {/* 37. Mockup Frame Wrapper */}
        {activeToolId === 'mockup-wrapper' && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1.5">
              {(['browser', 'phone', 'card'] as const).map((s) => (
                <button key={s} type="button" onClick={() => setMockupStyle(s)} className={`py-1.5 text-xs capitalize rounded border ${mockupStyle === s ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {s}
                </button>
              ))}
            </div>
            <select value={mockupGradient} onChange={(e) => setMockupGradient(e.target.value)} aria-label="Backdrop gradient" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
              <option value="cobalt">Midnight Cobalt</option>
              <option value="slate">Architectural Slate</option>
              <option value="warm">Warm Charcoal</option>
              <option value="light">Alabaster Studio</option>
            </select>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('mockup-wrapper', { frameStyle: mockupStyle, gradient: mockupGradient })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Wrap Screenshot Mockup
            </button>
          </div>
        )}

        {/* 40. Core Exposure */}
        {activeToolId === 'core-exposure' && (
          <div className="space-y-2.5">
            {(
              [
                ['brightness', 'Brightness', -60, 60, 1],
                ['contrast', 'Contrast', -60, 60, 1],
                ['exposure', 'Exposure EV', -1.5, 1.5, 0.1],
                ['highlights', 'Highlights', -80, 80, 1],
                ['shadows', 'Shadows', -80, 80, 1],
                ['gamma', 'Gamma', 0.4, 2.2, 0.05],
              ] as const
            ).map(([key, label, min, max, step]) => (
              <div key={key}>
                <div className="flex justify-between text-xs">
                  <span>{label}</span>
                  <span className="font-mono tabular-nums">{exposure[key]}</span>
                </div>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={exposure[key]}
                  onChange={(e) => setExposure((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                  className="w-full"
                />
              </div>
            ))}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('core-exposure', exposure)} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Exposure Curve
            </button>
          </div>
        )}

        {/* 41. Color & Vibrance */}
        {activeToolId === 'color-vibrance' && (
          <div className="space-y-2.5">
            {(
              [
                ['saturation', 'Saturation', -100, 100],
                ['vibrance', 'Vibrance', -100, 100],
                ['hue', 'Hue Shift (°)', -180, 180],
                ['temperature', 'Temperature', -80, 80],
                ['tint', 'Tint', -80, 80],
              ] as const
            ).map(([key, label, min, max]) => (
              <div key={key}>
                <div className="flex justify-between text-xs"><span>{label}</span><span className="font-mono tabular-nums">{vibrance[key]}</span></div>
                <input type="range" min={min} max={max} value={vibrance[key]} onChange={(e) => setVibrance((prev) => ({ ...prev, [key]: Number(e.target.value) }))} className="w-full" />
              </div>
            ))}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('color-vibrance', vibrance)} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Color Grade
            </button>
          </div>
        )}

        {/* 42. B&W Grayscale */}
        {activeToolId === 'bw-grayscale' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-1.5">
              {(['classic', 'high-contrast', 'sepia', 'film', 'infrared'] as const).map((p) => (
                <button key={p} type="button" onClick={() => setBwPreset(p)} className={`p-2 text-left text-xs capitalize rounded-md border ${bwPreset === p ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {p.replace('-', ' ')} Channel Mixer
                </button>
              ))}
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('bw-grayscale', { preset: bwPreset })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Convert to Monochrome
            </button>
          </div>
        )}

        {/* 43. Sharpen / Unsharp Mask */}
        {activeToolId === 'sharpen-unsharp' && (
          <div className="space-y-3">
            <div className="flex justify-between text-xs"><span>Amount</span><span className="font-mono">{sharpenAmount.toFixed(1)}</span></div>
            <input type="range" min={0.2} max={3.5} step={0.1} value={sharpenAmount} onChange={(e) => setSharpenAmount(Number(e.target.value))} className="w-full" />
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('sharpen-unsharp', { amount: sharpenAmount })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Unsharp Mask
            </button>
          </div>
        )}

        {/* 44. Gaussian & Motion Blur */}
        {activeToolId === 'blur-motion' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => setBlurType('gaussian')} className={`py-1.5 text-xs rounded border ${blurType === 'gaussian' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>Gaussian</button>
              <button type="button" onClick={() => setBlurType('motion')} className={`py-1.5 text-xs rounded border ${blurType === 'motion' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>Motion Blur</button>
            </div>
            <div>
              <div className="flex justify-between text-xs"><span>Radius</span><span className="font-mono">{blurRadius}px</span></div>
              <input type="range" min={1} max={32} value={blurRadius} onChange={(e) => setBlurRadius(Number(e.target.value))} className="w-full" />
            </div>
            {blurType === 'motion' && (
              <div>
                <div className="flex justify-between text-xs"><span>Angle</span><span className="font-mono">{blurAngle}°</span></div>
                <input type="range" min={0} max={180} value={blurAngle} onChange={(e) => setBlurAngle(Number(e.target.value))} className="w-full" />
              </div>
            )}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('blur-motion', { blurType, radius: blurRadius, angle: blurAngle })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Blur
            </button>
          </div>
        )}

        {/* 45. Color Invert */}
        {activeToolId === 'color-invert' && (
          <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('color-invert', {})} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
            Invert RGB Channels (Negative)
          </button>
        )}

        {/* 46. Chroma Key / Color Replacer */}
        {activeToolId === 'chroma-key' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span>Target Color to Key</span>
              <input type="color" value={chromaTarget} onChange={(e) => setChromaTarget(e.target.value)} />
            </div>
            <div>
              <div className="flex justify-between text-xs"><span>Tolerance</span><span className="font-mono">{chromaTol}%</span></div>
              <input type="range" min={2} max={60} value={chromaTol} onChange={(e) => setChromaTol(Number(e.target.value))} className="w-full" />
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button type="button" onClick={() => setChromaReplaceMode('transparent')} className={`py-1.5 text-xs rounded border ${chromaReplaceMode === 'transparent' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>Transparent</button>
              <button type="button" onClick={() => setChromaReplaceMode('color')} className={`py-1.5 text-xs rounded border ${chromaReplaceMode === 'color' ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>Swap Color</button>
            </div>
            {chromaReplaceMode === 'color' && (
              <div className="flex items-center justify-between text-xs">
                <span>Replacement Color</span>
                <input type="color" value={chromaReplaceColor} onChange={(e) => setChromaReplaceColor(e.target.value)} />
              </div>
            )}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('chroma-key', { targetColor: chromaTarget, tolerance: chromaTol, replaceMode: chromaReplaceMode, replaceColor: chromaReplaceColor })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Chroma Key
            </button>
          </div>
        )}

        {/* 48. Dither & Retro FX */}
        {activeToolId === 'dither-retro' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1.5">
              {(['floyd-steinberg', 'halftone', 'duotone', 'pixel-art'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setRetroMode(m)} className={`py-1.5 text-xs capitalize rounded border ${retroMode === m ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {m.replace('-', ' ')}
                </button>
              ))}
            </div>
            {(retroMode === 'duotone' || retroMode === 'halftone') && (
              <div className="flex items-center justify-between text-xs">
                <label className="flex items-center gap-1.5"><span>Dark</span><input type="color" value={retroColorA} onChange={(e) => setRetroColorA(e.target.value)} /></label>
                <label className="flex items-center gap-1.5"><span>Light</span><input type="color" value={retroColorB} onChange={(e) => setRetroColorB(e.target.value)} /></label>
              </div>
            )}
            {(retroMode === 'halftone' || retroMode === 'pixel-art') && (
              <div>
                <div className="flex justify-between text-xs"><span>Cell Size</span><span className="font-mono">{retroCell}px</span></div>
                <input type="range" min={3} max={24} value={retroCell} onChange={(e) => setRetroCell(Number(e.target.value))} className="w-full" />
              </div>
            )}
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('dither-retro', { retroMode, colorA: retroColorA, colorB: retroColorB, cellSize: retroCell })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Retro Effect
            </button>
          </div>
        )}

        {/* 49. Screenshot Annotator */}
        {activeToolId === 'screenshot-annotate' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">Click or drag directly on the canvas stage to draw markup.</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(['arrow', 'rect', 'circle', 'highlight', 'step'] as const).map((k) => (
                <button key={k} type="button" onClick={() => onChangeAnnotateKind(k)} className={`py-1.5 text-xs capitalize rounded border ${activeAnnotateKind === k ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {k === 'step' ? 'Step 1,2,3' : k}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between text-xs">
              <span>Stroke Color</span>
              <input type="color" value={annotateColor} onChange={(e) => onChangeAnnotateColor(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => onChangeAnnotations([])} disabled={annotations.length === 0} className="flex-1 py-2 text-xs bg-slate-100 dark:bg-slate-800 rounded-lg disabled:opacity-40">
                Clear ({annotations.length})
              </button>
              <button type="button" disabled={!activeAsset || annotations.length === 0 || isProcessing} onClick={async () => { await handleApplyAndCaptureExtras('screenshot-annotate', { shapes: annotations }); onChangeAnnotations([]); }} className="flex-1 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-40">
                Bake Markup
              </button>
            </div>
          </div>
        )}

        {/* 50. Text Overlay */}
        {activeToolId === 'text-overlay' && (
          <div className="space-y-3">
            <input type="text" value={overlayText} onChange={(e) => setOverlayText(e.target.value)} aria-label="Overlay text" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div className="flex items-center justify-between text-xs">
              <span>Font Size ({overlaySize}px)</span>
              <input type="color" value={overlayColor} onChange={(e) => setOverlayColor(e.target.value)} />
            </div>
            <input type="range" min={14} max={120} value={overlaySize} onChange={(e) => setOverlaySize(Number(e.target.value))} className="w-full" />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={overlayBgBox} onChange={(e) => setOverlayBgBox(e.target.checked)} />
              <span>Solid caption background box</span>
            </label>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('text-overlay', { text: overlayText, fontSize: overlaySize, color: overlayColor, bgBox: overlayBgBox })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Stamp Text Overlay
            </button>
          </div>
        )}

        {/* 51. Logo Watermark */}
        {activeToolId === 'logo-watermark' && (
          <div className="space-y-3">
            <label className="block p-2.5 text-center text-xs border border-dashed border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer hover:border-blue-500">
              <span>{wmLogoBlob ? 'Custom PNG Logo Loaded' : 'Optional: Pick Transparent PNG Logo'}</span>
              <input type="file" accept="image/png,image/svg+xml,image/webp" className="hidden" onChange={(e) => setWmLogoBlob(e.target.files?.[0] || null)} />
            </label>
            <select value={wmAnchor} onChange={(e) => setWmAnchor(e.target.value)} aria-label="Watermark anchor" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
              <option value="bottom-right">Bottom Right</option>
              <option value="bottom-left">Bottom Left</option>
              <option value="top-right">Top Right</option>
              <option value="top-left">Top Left</option>
              <option value="center">Center</option>
            </select>
            <div>
              <div className="flex justify-between text-xs"><span>Scale</span><span className="font-mono">{wmScale}%</span></div>
              <input type="range" min={8} max={45} value={wmScale} onChange={(e) => setWmScale(Number(e.target.value))} className="w-full" />
            </div>
            <div>
              <div className="flex justify-between text-xs"><span>Opacity</span><span className="font-mono">{wmOpacity}%</span></div>
              <input type="range" min={10} max={100} value={wmOpacity} onChange={(e) => setWmOpacity(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('logo-watermark', { logoBlob: wmLogoBlob, anchor: wmAnchor, scale: wmScale, opacity: wmOpacity })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Stamp Watermark
            </button>
          </div>
        )}

        {/* 52. Tiled Copyright Watermarker */}
        {activeToolId === 'tiled-watermark' && (
          <div className="space-y-3">
            <input type="text" value={tiledText} onChange={(e) => setTiledText(e.target.value)} aria-label="Copyright watermark text" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div>
              <div className="flex justify-between text-xs"><span>Opacity</span><span className="font-mono">{tiledOpacity}%</span></div>
              <input type="range" min={5} max={65} value={tiledOpacity} onChange={(e) => setTiledOpacity(Number(e.target.value))} className="w-full" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('tiled-watermark', { text: tiledText, opacity: tiledOpacity })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Apply Diagonal Copyright Tile
            </button>
          </div>
        )}

        {/* 53. Region Blur & Pixelate Redaction */}
        {activeToolId === 'region-redact' && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">Drag rectangles over sensitive areas (faces, plates, numbers) on the canvas.</p>
            <div className="grid grid-cols-3 gap-1.5">
              {(['blur', 'pixelate', 'blackout'] as const).map((m) => (
                <button key={m} type="button" onClick={() => onChangeRedactMode(m)} className={`py-1.5 text-xs capitalize rounded border ${activeRedactMode === m ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {m}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => onChangeRedactionBoxes([])} disabled={redactionBoxes.length === 0} className="flex-1 py-2 text-xs bg-slate-100 dark:bg-slate-800 rounded-lg disabled:opacity-40">
                Clear ({redactionBoxes.length})
              </button>
              <button type="button" disabled={!activeAsset || redactionBoxes.length === 0 || isProcessing} onClick={async () => { await handleApplyAndCaptureExtras('region-redact', { boxes: redactionBoxes }); onChangeRedactionBoxes([]); }} className="flex-1 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-40">
                Burn Redaction
              </button>
            </div>
          </div>
        )}

        {/* 54. EXIF Metadata Viewer */}
        {activeToolId === 'exif-viewer' && (
          <div className="space-y-2.5">
            {exifData ? (
              <dl className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg text-xs">
                {[
                  ['Dimensions', `${activeAsset?.width ?? exifData.width ?? '-'} × ${activeAsset?.height ?? exifData.height ?? '-'}`],
                  ['DPI / PPI', exifData.dpiX ? `${exifData.dpiX} × ${exifData.dpiY ?? exifData.dpiX} DPI` : 'Default (72 DPI)'],
                  ['Camera Make', exifData.make || 'Not embedded'],
                  ['Camera Model', exifData.model || 'Not embedded'],
                  ['Lens', exifData.lens || 'Not embedded'],
                  ['Exposure / ISO', [exifData.exposureTime, exifData.fNumber, exifData.iso].filter(Boolean).join(' · ') || 'Not embedded'],
                  ['GPS Coords', exifData.gpsLat ? `${exifData.gpsLat}, ${exifData.gpsLng}` : 'Clean (No GPS)'],
                  ['Author', exifData.artist || 'None'],
                  ['Copyright', exifData.copyright || 'None'],
                  ['Description', exifData.description || 'None'],
                  ['Segments', exifData.rawSegments.slice(0, 8).join(', ') || 'Standard'],
                ].map(([label, val]) => (
                  <div key={label} className="px-3 py-2 flex items-center justify-between gap-2">
                    <dt className="text-slate-500">{label}</dt>
                    <dd className="font-mono text-right text-slate-900 dark:text-slate-100 truncate max-w-[180px]">{val}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-xs text-slate-500">Reading binary header segments...</p>
            )}
          </div>
        )}

        {/* 56. EXIF Metadata Editor */}
        {activeToolId === 'exif-editor' && (
          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium mb-1">Copyright Notice</label>
              <input type="text" value={exifCopyright} onChange={(e) => setExifCopyright(e.target.value)} className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Author / Artist</label>
              <input type="text" value={exifAuthor} onChange={(e) => setExifAuthor(e.target.value)} className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            </div>
            <div>
              <label className="block text-[11px] font-medium mb-1">Description</label>
              <input type="text" value={exifDesc} onChange={(e) => setExifDesc(e.target.value)} className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('exif-editor', { copyright: exifCopyright, artist: exifAuthor, description: exifDesc })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Write Metadata Tags
            </button>
          </div>
        )}

        {/* 57. Canvas Squaring (1:1 Auto-Pad) */}
        {activeToolId === 'canvas-squaring' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span>Square Fill Background</span>
              <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} />
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('canvas-squaring', { bgColor })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Auto-Pad to 1:1 Square
            </button>
          </div>
        )}

        {/* 58. Marketplace Compliance Presets */}
        {activeToolId === 'marketplace-presets' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              {[
                ['amazon', 'Amazon Main (2000×2000 · 15% #FFF margin)'],
                ['ebay', 'eBay Catalog (1600×1600 · 10% #FFF margin)'],
                ['shopify', 'Shopify Product (2048×2048 · 12% #FFF margin)'],
              ].map(([id, label]) => (
                <button key={id} type="button" onClick={() => setMarketplace(id)} className={`w-full p-2 text-left text-xs rounded border ${marketplace === id ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {label}
                </button>
              ))}
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('marketplace-presets', { marketplace })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Enforce Compliance Preset
            </button>
          </div>
        )}

        {/* 59. Promo Badge & Ribbon Stamper */}
        {activeToolId === 'promo-badge' && (
          <div className="space-y-3">
            <div className="flex gap-1.5">
              {['50% OFF', 'NEW', 'SOLD OUT'].map((t) => (
                <button key={t} type="button" onClick={() => setPromoText(t)} className="flex-1 py-1 text-[11px] font-semibold bg-slate-100 dark:bg-slate-800 rounded">{t}</button>
              ))}
            </div>
            <input type="text" value={promoText} onChange={(e) => setPromoText(e.target.value)} aria-label="Promo badge text" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div className="grid grid-cols-2 gap-2">
              <select value={promoCorner} onChange={(e) => setPromoCorner(e.target.value)} aria-label="Corner" className="px-2 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
                <option value="top-right">Top Right</option>
                <option value="top-left">Top Left</option>
                <option value="bottom-right">Bottom Right</option>
                <option value="bottom-left">Bottom Left</option>
              </select>
              <select value={promoStyle} onChange={(e) => setPromoStyle(e.target.value as 'ribbon' | 'tag')} aria-label="Style" className="px-2 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
                <option value="ribbon">Diagonal Ribbon</option>
                <option value="tag">Corner Tag</option>
              </select>
            </div>
            <div className="flex items-center justify-between text-xs"><span>Accent Color</span><input type="color" value={promoBg} onChange={(e) => setPromoBg(e.target.value)} /></div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('promo-badge', { text: promoText, corner: promoCorner, bgColor: promoBg, badgeStyle: promoStyle })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Stamp Promo Ribbon
            </button>
          </div>
        )}

        {/* 60. Multi-Size Export Profiles */}
        {activeToolId === 'multi-size-export' && (
          <div className="space-y-3">
            <label className="block text-xs font-medium">Target Widths (px, comma-separated)</label>
            <input type="text" value={multiWidths} onChange={(e) => setMultiWidths(e.target.value)} className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('multi-size-export', { widths: multiWidths, format: 'image/webp' })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Generate Multi-Size ZIP
            </button>
          </div>
        )}

        {/* 63. Responsive srcset & <picture> Generator */}
        {activeToolId === 'responsive-srcset' && (
          <div className="space-y-3">
            <pre className="p-2.5 text-[10px] font-mono bg-slate-950 text-slate-200 rounded-lg overflow-x-auto max-h-48">
              {responsiveSnippet}
            </pre>
            <div className="flex gap-2">
              <button type="button" onClick={() => copyText('srcset', responsiveSnippet)} className="flex-1 inline-flex items-center justify-center gap-1 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 rounded-lg">
                {copiedKey === 'srcset' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>Copy HTML</span>
              </button>
              <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('responsive-srcset', {})} className="flex-1 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
                Build Breakpoints ZIP
              </button>
            </div>
          </div>
        )}

        {/* 64. Favicon & PWA Packager */}
        {activeToolId === 'favicon-pwa' && (
          <div className="space-y-3">
            <input type="text" value={pwaAppName} onChange={(e) => setPwaAppName(e.target.value)} aria-label="PWA app name" className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div className="flex items-center justify-between text-xs"><span>Maskable Theme Color</span><input type="color" value={pwaTheme} onChange={(e) => setPwaTheme(e.target.value)} /></div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('favicon-pwa', { appName: pwaAppName, themeColor: pwaTheme })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Build Favicon + PWA ZIP
            </button>
          </div>
        )}

        {/* 65. SVG Minifier */}
        {activeToolId === 'svg-minifier' && svgMinResult && (
          <div className="space-y-3">
            <textarea rows={5} value={svgInput} onChange={(e) => setSvgInput(e.target.value)} aria-label="Raw SVG input" className="w-full p-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400">
              Minified: {svgMinResult.minified.length} B (saved {svgMinResult.savedPercent}%)
            </div>
            <pre className="p-2 text-[10px] font-mono bg-slate-950 text-slate-200 rounded-lg overflow-x-auto max-h-32">{svgMinResult.minified}</pre>
            <button type="button" onClick={() => copyText('svgmin', svgMinResult.minified)} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              {copiedKey === 'svgmin' ? 'Copied Minified SVG' : 'Copy Minified SVG'}
            </button>
          </div>
        )}

        {/* 66. SVG to JSX / React / Data URI */}
        {activeToolId === 'svg-to-jsx' && (
          <div className="space-y-3">
            <input type="text" value={svgComponentName} onChange={(e) => setSvgComponentName(e.target.value)} aria-label="React component name" className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <textarea rows={4} value={svgInput} onChange={(e) => setSvgInput(e.target.value)} aria-label="Source SVG" className="w-full p-2 text-[11px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <pre className="p-2 text-[10px] font-mono bg-slate-950 text-slate-200 rounded-lg overflow-x-auto max-h-32">{svgJsxCode}</pre>
            <div className="flex gap-2">
              <button type="button" onClick={() => copyText('jsx', svgJsxCode)} className="flex-1 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg">
                {copiedKey === 'jsx' ? 'Copied JSX' : 'Copy React JSX'}
              </button>
              <button type="button" onClick={() => copyText('uri', svgCssUri)} className="flex-1 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 rounded-lg">
                {copiedKey === 'uri' ? 'Copied CSS URI' : 'Copy CSS URI'}
              </button>
            </div>
          </div>
        )}

        {/* 67. Base64 Encoder & Decoder */}
        {activeToolId === 'base64-codec' && (
          <div className="space-y-3">
            <div className="flex justify-between text-[11px] font-mono text-slate-500">
              <span>Data URI Payload</span>
              <span>{formatBytes(base64Text.length)}</span>
            </div>
            <textarea rows={6} value={base64Text} onChange={(e) => setBase64Text(e.target.value)} aria-label="Base64 Data URI" className="w-full p-2 text-[10px] font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
            <div className="flex gap-2">
              <button type="button" onClick={() => copyText('b64', base64Text)} className="flex-1 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 rounded-lg">
                {copiedKey === 'b64' ? 'Copied' : 'Copy Data URI'}
              </button>
              <button type="button" onClick={handleDecodeBase64} className="flex-1 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg">
                Decode to Stage
              </button>
            </div>
          </div>
        )}

        {/* 69. Sprite Sheet Slicer */}
        {activeToolId === 'sprite-slicer' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] mb-1">Columns</label>
                <input type="number" min={1} max={16} value={sliceCols} onChange={(e) => setSliceCols(Number(e.target.value))} className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
              </div>
              <div>
                <label className="block text-[11px] mb-1">Rows</label>
                <input type="number" min={1} max={16} value={sliceRows} onChange={(e) => setSliceRows(Number(e.target.value))} className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md" />
              </div>
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('sprite-slicer', { cols: sliceCols, rows: sliceRows })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Slice {sliceCols * sliceRows} Frames → ZIP
            </button>
          </div>
        )}

        {/* 70. LQIP & BlurHash Generator */}
        {activeToolId === 'lqip-blurhash' && lqipInfo && (
          <div className="space-y-3">
            <div>
              <p className="text-[11px] font-medium text-slate-500 mb-1">BlurHash (4×3 DCT)</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md truncate">
                  {lqipInfo.blurHash}
                </code>
                <button type="button" onClick={() => copyText('bh', lqipInfo.blurHash)} className="px-2.5 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 rounded-md">
                  {copiedKey === 'bh' ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-medium text-slate-500 mb-1">
                LQIP Micro-Placeholder ({lqipInfo.lqipBytes} chars)
              </p>
              <img src={lqipInfo.lqipDataUri} alt="LQIP preview" className="w-full h-24 object-cover rounded-lg blur-sm border border-slate-200 dark:border-slate-800" />
              <button type="button" onClick={() => copyText('lqip', lqipInfo.lqipDataUri)} className="mt-2 w-full py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg">
                {copiedKey === 'lqip' ? 'Copied LQIP Data URI' : 'Copy LQIP Base64 URI'}
              </button>
            </div>
          </div>
        )}

        {/* 71. Visual Diff Comparator */}
        {activeToolId === 'visual-diff' && (
          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium mb-1">Compare Against</label>
              <select value={diffCompareId} onChange={(e) => setDiffCompareId(e.target.value)} className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md">
                <option value="">Original unedited version</option>
                {assets.filter((a) => a.id !== activeAsset?.id).map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['slider', 'onion', 'heatmap'] as const).map((m) => (
                <button key={m} type="button" onClick={() => { setDiffMode(m); onUpdateVisualDiff(null, m, diffOpacity); }} className={`py-1.5 text-xs capitalize rounded border ${diffMode === m ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {m}
                </button>
              ))}
            </div>
            {diffMode === 'onion' && (
              <input type="range" min={0} max={100} value={diffOpacity} onChange={(e) => { const v = Number(e.target.value); setDiffOpacity(v); onUpdateVisualDiff(null, 'onion', v); }} className="w-full" />
            )}
            <button type="button" disabled={!activeAsset} onClick={handleRunVisualDiff} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Compute Pixel Diff Heatmap
            </button>
            {diffStats && (
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums">
                Changed pixels: {diffStats.diffPixels.toLocaleString()} ({diffStats.diffPercent}%)
              </div>
            )}
          </div>
        )}

        {/* 72. Color Palette & CSS Variable Extractor */}
        {activeToolId === 'palette-extractor' && paletteInfo && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              {paletteInfo.colors.map((c) => (
                <div key={c.hex} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-slate-200 dark:border-slate-800 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="w-6 h-6 rounded border border-black/10 shrink-0" style={{ backgroundColor: c.hex }} />
                    <div className="min-w-0">
                      <p className="font-mono font-semibold text-slate-900 dark:text-slate-100">{c.hex}</p>
                      <p className="font-mono text-[10px] text-slate-500 truncate">{c.hsl}</p>
                    </div>
                  </div>
                  <span className="font-mono tabular-nums text-[11px] text-slate-500">{c.percent}%</span>
                </div>
              ))}
            </div>
            <pre className="p-2.5 text-[10px] font-mono bg-slate-950 text-slate-200 rounded-lg overflow-x-auto">{paletteInfo.cssVariables}</pre>
            <button type="button" onClick={() => copyText('cssvars', paletteInfo.cssVariables)} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg">
              {copiedKey === 'cssvars' ? 'Copied CSS Variables' : 'Copy CSS :root Variables'}
            </button>
          </div>
        )}

        {/* 73. DPI / PPI Changer */}
        {activeToolId === 'dpi-changer' && (
          <div className="space-y-3">
            {exifData?.dpiX && (
              <p className="text-xs font-mono text-slate-500">Current header: {exifData.dpiX} DPI</p>
            )}
            <div className="grid grid-cols-4 gap-1.5">
              {[72, 150, 300, 600].map((d) => (
                <button key={d} type="button" onClick={() => setDpiValue(d)} className={`py-1.5 text-xs font-mono rounded border ${dpiValue === d ? 'border-blue-600 bg-blue-50 dark:bg-blue-950/50 font-semibold' : 'border-slate-200 dark:border-slate-800'}`}>
                  {d}
                </button>
              ))}
            </div>
            <button type="button" disabled={!activeAsset || isProcessing} onClick={() => handleApplyAndCaptureExtras('dpi-changer', { dpi: dpiValue })} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg">
              Patch Header to {dpiValue} DPI
            </button>
          </div>
        )}

        {/* 74. Image to ASCII Art */}
        {activeToolId === 'ascii-art' && asciiInfo && (
          <div className="space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1"><span>Columns</span><span className="font-mono">{asciiCols} chars</span></div>
              <input type="range" min={32} max={110} value={asciiCols} onChange={(e) => setAsciiCols(Number(e.target.value))} className="w-full" />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={asciiColorMode} onChange={(e) => setAsciiColorMode(e.target.checked)} />
              <span>Full-color HTML output</span>
            </label>
            <div className="p-2 bg-slate-950 text-slate-100 rounded-lg overflow-auto max-h-56 text-[6px] leading-[6px] font-mono whitespace-pre">
              {asciiColorMode ? (
                <div dangerouslySetInnerHTML={{ __html: asciiInfo.html }} />
              ) : (
                asciiInfo.text
              )}
            </div>
            <button type="button" onClick={() => copyText('ascii', asciiColorMode ? asciiInfo.html : asciiInfo.text)} className="w-full py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg">
              {copiedKey === 'ascii' ? 'Copied ASCII Art' : 'Copy ASCII Output'}
            </button>
          </div>
        )}

        {/* 8, 61, 75-80 — Workflow / Batch / Storage Workspace Launchers */}
        {(activeToolId === 'bulk-zip' ||
          activeToolId === 'bulk-renamer' ||
          activeToolId === 'pipeline-chain' ||
          activeToolId === 'saved-presets' ||
          activeToolId === 'local-privacy' ||
          activeToolId === 'clipboard-io' ||
          activeToolId === 'history-manager' ||
          activeToolId === 'clean-export') && (
          <div className="space-y-3">
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              This workstation feature is active globally across ChromaForge. Jump straight into its dedicated panel:
            </p>
            <button
              type="button"
              onClick={() => {
                if (activeToolId === 'pipeline-chain' || activeToolId === 'saved-presets') onNavigateTab('pipeline');
                else if (activeToolId === 'bulk-zip' || activeToolId === 'bulk-renamer') onNavigateTab('batch');
                else onNavigateTab('storage');
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Open Dedicated Workspace</span>
            </button>
          </div>
        )}

        {/* Multi-file package download banner (ICO, PWA, srcset, 9-Grid, Sprite Slicer, Multi-Size) */}
        {extraExportFiles.length > 0 && (
          <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 space-y-2">
            <div className="flex items-center justify-between text-xs font-semibold text-emerald-800 dark:text-emerald-300">
              <span>{extraExportFiles.length} output file(s) ready</span>
              <button type="button" onClick={() => setExtraExportFiles([])} aria-label="Clear generated package" className="text-emerald-700/70 hover:text-emerald-900">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => handleDownloadExtrasZip(`${activeToolId}-bundle.zip`)}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{extraExportFiles.length === 1 ? `Save ${extraExportFiles[0].name}` : `Download ${extraExportFiles.length} Files (.ZIP)`}</span>
            </button>
          </div>
        )}
      </div>

      {/* Footer Quick Info */}
      {activeAsset && (
        <div className="px-4 py-2.5 border-t border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-500 shrink-0">
          <span>Rev {activeAsset.historyIndex + 1}/{activeAsset.historyIds.length}</span>
          <span className="inline-flex items-center gap-1">
            {isProcessing && <RefreshCw className="w-3 h-3 animate-spin" />}
            {formatBytes(activeAsset.originalBytes)} → {formatBytes(activeAsset.currentBytes)}
          </span>
        </div>
      )}
    </aside>
  );
}
