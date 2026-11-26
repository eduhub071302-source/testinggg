import { Archive, FileText, FolderOutput, Grid2x2, Layers, Upload } from 'lucide-react';
import { useState } from 'react';
import { applyRenamePattern } from '../engine/dspAlgorithms';
import { formatBytes } from '../engine/memoryGovernor';
import { StudioAsset } from '../types/studio';

interface BatchWorkspaceProps {
  assets: StudioAsset[];
  isRunning: boolean;
  progressText: string;
  mountedDirName: string | null;
  onOpenFiles: () => void;
  onBulkCompressZip: (opts: {
    format: 'image/webp' | 'image/jpeg' | 'image/png';
    quality: number;
    maxKb: number;
    renameTemplate: string;
    writeToFolder: boolean;
  }) => Promise<void>;
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
}

export function BatchWorkspace({
  assets,
  isRunning,
  progressText,
  mountedDirName,
  onOpenFiles,
  onBulkCompressZip,
  onComposeMulti,
}: BatchWorkspaceProps) {
  const [format, setFormat] = useState<'image/webp' | 'image/jpeg' | 'image/png'>('image/webp');
  const [quality, setQuality] = useState(82);
  const [maxKb, setMaxKb] = useState(0);
  const [renameTemplate, setRenameTemplate] = useState('{name}-{index:2}.{ext}');
  const [collageCols, setCollageCols] = useState(2);
  const [gapPx, setGapPx] = useState(16);
  const [overlapPx, setOverlapPx] = useState(40);
  const [variantLabels, setVariantLabels] = useState('Silver, Midnight, Sandstone, Cobalt');
  const [pdfPageSize, setPdfPageSize] = useState<'a4' | 'letter' | 'fit'>('a4');
  const [pdfOrientation, setPdfOrientation] = useState<'portrait' | 'landscape'>('portrait');

  const ext = format === 'image/webp' ? 'webp' : format === 'image/png' ? 'png' : 'jpg';
  const totalBytes = assets.reduce((sum, a) => sum + a.currentBytes, 0);

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Batch Operations & Multi-Image Compositor
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Stream 50–500 assets sequentially through OPFS into a single ZIP, PDF, Contact Sheet, Collage, Merger, or Sprite Atlas.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {assets.length} files · {formatBytes(totalBytes)} total
            </span>
            <button
              type="button"
              onClick={onOpenFiles}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 rounded-lg"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Add Images</span>
            </button>
          </div>
        </div>

        {progressText && (
          <div className="px-4 py-2.5 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 rounded-lg text-xs font-medium text-blue-800 dark:text-blue-200">
            {progressText}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Bulk Compression + Pattern Renamer (Features 8 & 61) */}
          <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Bulk Compression & SKU Pattern Renamer
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Supports tokens: <code className="text-[11px]">{'{name}'}</code>, <code className="text-[11px]">{'{index:2}'}</code>, <code className="text-[11px]">{'{width}'}</code>, <code className="text-[11px]">{'{date}'}</code>, <code className="text-[11px]">{'{ext}'}</code>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="batch-format" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Output Format
                </label>
                <select
                  id="batch-format"
                  value={format}
                  onChange={(e) => setFormat(e.target.value as 'image/webp' | 'image/jpeg' | 'image/png')}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                >
                  <option value="image/webp">WebP (Modern)</option>
                  <option value="image/jpeg">JPEG (Universal)</option>
                  <option value="image/png">PNG (Lossless)</option>
                </select>
              </div>
              <div>
                <label htmlFor="batch-quality" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Quality ({quality}%)
                </label>
                <input
                  id="batch-quality"
                  type="range"
                  min={15}
                  max={100}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  className="w-full mt-1"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="batch-max-kb" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Optional Target Cap (KB, 0 = off)
                </label>
                <input
                  id="batch-max-kb"
                  type="number"
                  min={0}
                  max={5000}
                  value={maxKb}
                  onChange={(e) => setMaxKb(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
              <div>
                <label htmlFor="batch-rename" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Filename Pattern
                </label>
                <input
                  id="batch-rename"
                  type="text"
                  value={renameTemplate}
                  onChange={(e) => setRenameTemplate(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
            </div>

            {assets.length > 0 && (
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md px-3 py-2">
                Preview:{' '}
                <span className="text-slate-900 dark:text-slate-100">
                  {applyRenamePattern(renameTemplate, {
                    originalName: assets[0].name,
                    index: 0,
                    ext,
                    width: assets[0].width,
                    height: assets[0].height,
                  })}
                </span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() =>
                  onBulkCompressZip({ format, quality, maxKb, renameTemplate, writeToFolder: false })
                }
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 rounded-lg transition-colors"
              >
                <Archive className="w-3.5 h-3.5" />
                <span>Compress All → ZIP</span>
              </button>
              {mountedDirName && (
                <button
                  type="button"
                  disabled={isRunning || assets.length === 0}
                  onClick={() =>
                    onBulkCompressZip({ format, quality, maxKb, renameTemplate, writeToFolder: true })
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 rounded-lg"
                >
                  <FolderOutput className="w-3.5 h-3.5" />
                  <span>Write Directly to /{mountedDirName}</span>
                </button>
              )}
            </div>
          </div>

          {/* Multi-Image Compositor (Features 17, 32, 33, 34, 38, 39, 62, 68) */}
          <div className="lg:col-span-6 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Multi-Image Layout, PDF & Sprite Generators
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Composes all {assets.length} loaded filmstrip assets in order into a new studio output.
              </p>
            </div>

            <div className="grid grid-cols-3 gap-2.5">
              <div>
                <label htmlFor="comp-cols" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Grid Columns
                </label>
                <input
                  id="comp-cols"
                  type="number"
                  min={1}
                  max={8}
                  value={collageCols}
                  onChange={(e) => setCollageCols(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
              <div>
                <label htmlFor="comp-gap" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Gap (px)
                </label>
                <input
                  id="comp-gap"
                  type="number"
                  min={0}
                  max={80}
                  value={gapPx}
                  onChange={(e) => setGapPx(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
              <div>
                <label htmlFor="comp-overlap" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  Stitch Overlap
                </label>
                <input
                  id="comp-overlap"
                  type="number"
                  min={0}
                  max={300}
                  value={overlapPx}
                  onChange={(e) => setOverlapPx(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="pdf-size" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  PDF Page Size
                </label>
                <select
                  id="pdf-size"
                  value={pdfPageSize}
                  onChange={(e) => setPdfPageSize(e.target.value as 'a4' | 'letter' | 'fit')}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                >
                  <option value="a4">A4 Standard</option>
                  <option value="letter">US Letter</option>
                  <option value="fit">Fit to Image</option>
                </select>
              </div>
              <div>
                <label htmlFor="pdf-orient" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                  PDF Orientation
                </label>
                <select
                  id="pdf-orient"
                  value={pdfOrientation}
                  onChange={(e) => setPdfOrientation(e.target.value as 'portrait' | 'landscape')}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
                >
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="variant-labels" className="block text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
                Variant Grid Labels (comma-separated)
              </label>
              <input
                id="variant-labels"
                type="text"
                value={variantLabels}
                onChange={(e) => setVariantLabels(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md"
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-1">
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('merge-h', { gap: gapPx })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Merge Horizontal
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('merge-v', { gap: gapPx })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Merge Vertical
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('collage', { cols: collageCols, gap: gapPx, radius: 12 })}
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                <Grid2x2 className="w-3.5 h-3.5" />
                <span>Grid Collage</span>
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('long-stitch', { overlapPx })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Long Stitcher
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('contact-sheet', { cols: Math.max(2, collageCols), gap: gapPx })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Contact Sheet
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('variant-grid', { labels: variantLabels, gap: gapPx })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Variant Grid
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length < 2}
                onClick={() => onComposeMulti('before-after', { splitPercent: 50 })}
                className="px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                Before / After
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() => onComposeMulti('sprite-pack', { padding: 4 })}
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-slate-800 dark:text-slate-100 disabled:opacity-40"
              >
                <Layers className="w-3.5 h-3.5" />
                <span>Sprite Atlas ZIP</span>
              </button>
              <button
                type="button"
                disabled={isRunning || assets.length === 0}
                onClick={() =>
                  onComposeMulti('pdf', {
                    pageSize: pdfPageSize,
                    orientation: pdfOrientation,
                    marginPt: 28,
                  })
                }
                className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg disabled:opacity-40"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Combine to PDF</span>
              </button>
            </div>
          </div>
        </div>

        {/* High-Density Queue Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
              Loaded Asset Queue
            </h2>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {assets.length} item(s)
            </span>
          </div>
          {assets.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              No assets loaded. Open files or paste screenshots to populate the batch queue.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="py-2.5 px-4 font-medium">#</th>
                    <th className="py-2.5 px-4 font-medium">File Name</th>
                    <th className="py-2.5 px-4 font-medium">Renamed Output</th>
                    <th className="py-2.5 px-4 font-medium text-right">Dimensions</th>
                    <th className="py-2.5 px-4 font-medium text-right">Current Size</th>
                    <th className="py-2.5 px-4 font-medium text-right">OPFS Path</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                  {assets.map((asset, i) => (
                    <tr key={asset.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-2 px-4 font-mono tabular-nums text-slate-400">{i + 1}</td>
                      <td className="py-2 px-4 font-medium text-slate-900 dark:text-slate-100 flex items-center gap-2.5">
                        <img
                          src={asset.previewUrl}
                          alt={asset.name}
                          referrerPolicy="no-referrer"
                          className="w-7 h-7 rounded object-cover bg-slate-200 dark:bg-slate-800 shrink-0"
                        />
                        <span className="truncate max-w-[220px]">{asset.name}</span>
                      </td>
                      <td className="py-2 px-4 font-mono text-slate-600 dark:text-slate-300">
                        {applyRenamePattern(renameTemplate, {
                          originalName: asset.name,
                          index: i,
                          ext,
                          width: asset.width,
                          height: asset.height,
                        })}
                      </td>
                      <td className="py-2 px-4 font-mono tabular-nums text-right text-slate-600 dark:text-slate-300">
                        {asset.width}×{asset.height}
                      </td>
                      <td className="py-2 px-4 font-mono tabular-nums text-right text-slate-900 dark:text-slate-100">
                        {formatBytes(asset.currentBytes)}
                      </td>
                      <td className="py-2 px-4 font-mono text-right text-[11px] text-slate-400 truncate max-w-[180px]">
                        /{asset.opfsCurrentPath}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
