import {
  Check,
  Columns2,
  Copy,
  FolderOpen,
  ImagePlus,
  Moon,
  Redo2,
  RotateCcw,
  Sun,
  Trash2,
  Undo2,
  Upload,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import React, { useRef, useState } from 'react';
import { formatBytes } from '../engine/memoryGovernor';
import {
  AnnotationShape,
  MemoryStats,
  PerspectiveQuad,
  RedactionBox,
  StudioAsset,
  ToolId,
} from '../types/studio';

interface CanvasStageProps {
  assets: StudioAsset[];
  activeAsset: StudioAsset | null;
  activeToolId: ToolId;
  memoryStats: MemoryStats;
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onSelectAsset: (id: string) => void;
  onRemoveAsset: (id: string) => void;
  onOpenFiles: () => void;
  onMountFolder: () => void;
  onLoadSamples: () => void;
  onDropFiles: (files: File[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onResetOriginal: () => void;
  onCopyClipboard: () => Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  // Interactive canvas state
  splitMode: boolean;
  onToggleSplitMode: () => void;
  annotations: AnnotationShape[];
  onChangeAnnotations: (shapes: AnnotationShape[]) => void;
  activeAnnotateKind: AnnotationShape['kind'];
  annotateColor: string;
  redactionBoxes: RedactionBox[];
  onChangeRedactionBoxes: (boxes: RedactionBox[]) => void;
  activeRedactMode: RedactionBox['mode'];
  perspectiveQuad: PerspectiveQuad;
  onChangePerspectiveQuad: (quad: PerspectiveQuad) => void;
  visualDiffOverlayUrl: string | null;
  visualDiffViewMode: 'slider' | 'onion' | 'heatmap';
  visualDiffOnionOpacity: number;
  passportStandard: string;
}

export function CanvasStage({
  assets,
  activeAsset,
  activeToolId,
  memoryStats,
  darkMode,
  onToggleDarkMode,
  onSelectAsset,
  onRemoveAsset,
  onOpenFiles,
  onMountFolder,
  onLoadSamples,
  onDropFiles,
  onUndo,
  onRedo,
  onResetOriginal,
  onCopyClipboard,
  canUndo,
  canRedo,
  splitMode,
  onToggleSplitMode,
  annotations,
  onChangeAnnotations,
  activeAnnotateKind,
  annotateColor,
  redactionBoxes,
  onChangeRedactionBoxes,
  activeRedactMode,
  perspectiveQuad,
  onChangePerspectiveQuad,
  visualDiffOverlayUrl,
  visualDiffViewMode,
  visualDiffOnionOpacity,
  passportStandard,
}: CanvasStageProps) {
  const [zoom, setZoom] = useState(1);
  const [splitPos, setSplitPos] = useState(50);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const stageOverlayRef = useRef<HTMLDivElement>(null);
  const drawingRef = useRef<{ startX: number; startY: number; id: string } | null>(null);
  const draggingCornerRef = useRef<keyof PerspectiveQuad | null>(null);

  const isAnnotating = activeToolId === 'screenshot-annotate';
  const isRedacting = activeToolId === 'region-redact';
  const isPerspective = activeToolId === 'perspective-deskew';
  const isPassport = activeToolId === 'passport-id';
  const isVisualDiff = activeToolId === 'visual-diff';

  const getNormalizedCoords = (e: React.PointerEvent) => {
    const rect = stageOverlayRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handleOverlayPointerDown = (e: React.PointerEvent) => {
    if (!isAnnotating && !isRedacting) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = getNormalizedCoords(e);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (isAnnotating) {
      if (activeAnnotateKind === 'step') {
        const nextNum = annotations.filter((a) => a.kind === 'step').length + 1;
        onChangeAnnotations([
          ...annotations,
          { id, kind: 'step', x1: x, y1: y, x2: x, y2: y, color: annotateColor, strokeWidth: 4, stepNumber: nextNum },
        ]);
        return;
      }
      drawingRef.current = { startX: x, startY: y, id };
      onChangeAnnotations([
        ...annotations,
        {
          id,
          kind: activeAnnotateKind,
          x1: x,
          y1: y,
          x2: x,
          y2: y,
          color: annotateColor,
          strokeWidth: 4,
          points: activeAnnotateKind === 'highlight' ? [{ x, y }] : undefined,
        },
      ]);
    } else if (isRedacting) {
      drawingRef.current = { startX: x, startY: y, id };
      onChangeRedactionBoxes([
        ...redactionBoxes,
        { id, x, y, w: 0.01, h: 0.01, mode: activeRedactMode, strength: 14 },
      ]);
    }
  };

  const handleOverlayPointerMove = (e: React.PointerEvent) => {
    if (draggingCornerRef.current && isPerspective) {
      const { x, y } = getNormalizedCoords(e);
      onChangePerspectiveQuad({
        ...perspectiveQuad,
        [draggingCornerRef.current]: { x, y },
      });
      return;
    }

    if (!drawingRef.current) return;
    const { x, y } = getNormalizedCoords(e);
    const { startX, startY, id } = drawingRef.current;

    if (isAnnotating) {
      onChangeAnnotations(
        annotations.map((shape) => {
          if (shape.id !== id) return shape;
          if (shape.kind === 'highlight') {
            return { ...shape, x2: x, y2: y, points: [...(shape.points || []), { x, y }] };
          }
          return { ...shape, x2: x, y2: y };
        })
      );
    } else if (isRedacting) {
      onChangeRedactionBoxes(
        redactionBoxes.map((b) =>
          b.id === id
            ? {
                ...b,
                x: Math.min(startX, x),
                y: Math.min(startY, y),
                w: Math.max(0.01, Math.abs(x - startX)),
                h: Math.max(0.01, Math.abs(y - startY)),
              }
            : b
        )
      );
    }
  };

  const handleOverlayPointerUp = () => {
    drawingRef.current = null;
    draggingCornerRef.current = null;
  };

  const handleCopy = async () => {
    await onCopyClipboard();
    setCopiedFlash(true);
    setTimeout(() => setCopiedFlash(false), 1800);
  };

  const savingsPct =
    activeAsset && activeAsset.originalBytes > 0
      ? Math.round(((activeAsset.originalBytes - activeAsset.currentBytes) / activeAsset.originalBytes) * 100)
      : 0;

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-slate-50 dark:bg-slate-950 overflow-hidden">
      {/* Contextual Studio Action Bar */}
      <div className="min-h-11 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center justify-between gap-2 shrink-0 overflow-x-auto">
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onOpenFiles}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0 transition-colors"
          >
            <Upload className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Files</span>
          </button>
          <button
            type="button"
            onClick={onMountFolder}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md whitespace-nowrap shrink-0 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Folder</span>
          </button>

          <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" aria-hidden="true" />

          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="Undo edit"
            title="Undo (Ctrl+Z)"
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-md transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label="Redo edit"
            title="Redo (Ctrl+Shift+Z)"
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-md transition-colors"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onResetOriginal}
            disabled={!activeAsset || activeAsset.historyIndex === 0}
            aria-label="Revert to original"
            title="Revert to original"
            className="p-1.5 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-md transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" aria-hidden="true" />

          <button
            type="button"
            onClick={onToggleSplitMode}
            disabled={!activeAsset}
            aria-pressed={splitMode}
            className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors ${
              splitMode
                ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300'
                : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            <Columns2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Split</span>
          </button>

          <button
            type="button"
            onClick={handleCopy}
            disabled={!activeAsset}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-35 rounded-md whitespace-nowrap shrink-0 transition-colors"
          >
            {copiedFlash ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copiedFlash ? 'Copied' : 'Copy'}</span>
          </button>
        </div>

        {/* Clean Unboxed Tabular Metadata + Zoom + Theme */}
        <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 shrink-0">
          {activeAsset && (
            <div className="hidden xl:flex items-center gap-1.5 font-mono tabular-nums text-[11px] whitespace-nowrap">
              <span>
                {activeAsset.width}×{activeAsset.height}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatBytes(activeAsset.currentBytes)}</span>
              {savingsPct !== 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={savingsPct > 0 ? 'text-emerald-600 dark:text-emerald-400 font-semibold' : 'text-amber-600'}>
                    {savingsPct > 0 ? `-${savingsPct}%` : `+${Math.abs(savingsPct)}%`}
                  </span>
                </>
              )}
              <span aria-hidden="true">·</span>
              <span>
                {formatBytes(memoryStats.trackedBytes)} / 300 MB
              </span>
            </div>
          )}

          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.25, +(z - 0.25).toFixed(2)))}
              aria-label="Zoom out"
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-600 dark:text-slate-300"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <span className="font-mono tabular-nums text-[11px] w-9 text-center text-slate-700 dark:text-slate-200">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}
              aria-label="Zoom in"
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-600 dark:text-slate-300"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleDarkMode}
              aria-label={darkMode ? 'Switch to light theme' : 'Switch to darkroom theme'}
              className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded text-slate-600 dark:text-slate-300 ml-0.5"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Main Optical Viewport */}
      <div
        data-testid="canvas-viewport"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length > 0) onDropFiles(dropped);
        }}
        className={`relative flex-1 min-h-[340px] studio-checkerboard overflow-auto flex items-center justify-center p-6 transition-colors ${
          dragOver ? 'ring-2 ring-inset ring-blue-500' : ''
        }`}
      >
        {!activeAsset ? (
          <div className="max-w-md w-full bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center shadow-sm">
            <div className="w-11 h-11 mx-auto rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-700 dark:text-slate-200 mb-4">
              <ImagePlus className="w-5 h-5" aria-hidden="true" />
            </div>
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Drop images, paste (Ctrl+V), or open a local folder
            </h2>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
              Every file stays 100% local in your browser OPFS vault with automatic 300 MB memory governance.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onOpenFiles}
                className="px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
              >
                Open Local Files
              </button>
              <button
                type="button"
                onClick={onLoadSamples}
                className="px-4 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
              >
                Load Sample Studio Set
              </button>
            </div>
          </div>
        ) : (
          <div
            className="relative inline-block select-none shadow-2xl"
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
              transition: 'transform 160ms cubic-bezier(0.16, 1, 0.3, 1)',
            }}
          >
            {/* Base Current Image */}
            <img
              src={activeAsset.previewUrl}
              alt={activeAsset.name}
              referrerPolicy="no-referrer"
              draggable={false}
              className="block max-h-[62vh] max-w-full w-auto h-auto object-contain rounded-sm"
            />

            {/* Before/After Split-Screen Preview Overlay */}
            {(splitMode || (isVisualDiff && visualDiffViewMode === 'slider')) && (
              <>
                <div
                  className="absolute inset-0 overflow-hidden pointer-events-none"
                  style={{ clipPath: `inset(0 ${100 - splitPos}% 0 0)` }}
                >
                  <img
                    src={activeAsset.originalPreviewUrl}
                    alt={`${activeAsset.name} original`}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    className="w-full h-full object-contain"
                  />
                </div>
                <div
                  className="absolute inset-y-0 w-0.5 bg-white shadow pointer-events-none"
                  style={{ left: `${splitPos}%` }}
                />
                <div className="absolute top-2.5 left-2.5 px-2 py-0.5 text-[10px] font-semibold bg-slate-950/75 text-white rounded pointer-events-none">
                  Original · {formatBytes(activeAsset.originalBytes)}
                </div>
                <div className="absolute top-2.5 right-2.5 px-2 py-0.5 text-[10px] font-semibold bg-slate-950/75 text-white rounded pointer-events-none">
                  Output · {formatBytes(activeAsset.currentBytes)}
                </div>
                <input
                  type="range"
                  min={2}
                  max={98}
                  value={splitPos}
                  onChange={(e) => setSplitPos(Number(e.target.value))}
                  aria-label="Before and after split comparison position"
                  className="absolute inset-x-0 bottom-3 mx-auto w-48 z-20 cursor-ew-resize"
                />
              </>
            )}

            {/* Visual Diff Onion-Skin or Heatmap Overlay */}
            {isVisualDiff && visualDiffOverlayUrl && visualDiffViewMode === 'heatmap' && (
              <img
                src={visualDiffOverlayUrl}
                alt="Pixel difference heatmap"
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              />
            )}
            {isVisualDiff && visualDiffViewMode === 'onion' && (
              <img
                src={activeAsset.originalPreviewUrl}
                alt="Onion skin comparison"
                style={{ opacity: visualDiffOnionOpacity / 100 }}
                className="absolute inset-0 w-full h-full object-contain pointer-events-none"
              />
            )}

            {/* Interactive Passport Biometric Alignment Guides (Feature 25) */}
            {isPassport && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div
                  className={`border-2 border-dashed border-blue-400/90 relative ${
                    passportStandard === 'eu-35x45' ? 'w-[62%] h-[80%]' : 'w-[72%] h-[72%]'
                  }`}
                >
                  <div className="absolute inset-x-[22%] top-[14%] bottom-[24%] rounded-full border-2 border-emerald-400/90" />
                  <div className="absolute inset-x-0 top-[44%] border-t border-emerald-300/80" />
                  <span className="absolute -top-6 left-0 text-[10px] font-mono bg-slate-950/80 text-white px-1.5 py-0.5 rounded">
                    Eye line & crown guide
                  </span>
                </div>
              </div>
            )}

            {/* Interactive 4-Corner Perspective Deskew Handles (Feature 30) */}
            {isPerspective && (
              <div
                ref={stageOverlayRef}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                className="absolute inset-0 z-10"
              >
                <svg className="w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
                  <polygon
                    points={`${perspectiveQuad.tl.x * 100},${perspectiveQuad.tl.y * 100} ${perspectiveQuad.tr.x * 100},${perspectiveQuad.tr.y * 100} ${perspectiveQuad.br.x * 100},${perspectiveQuad.br.y * 100} ${perspectiveQuad.bl.x * 100},${perspectiveQuad.bl.y * 100}`}
                    fill="rgba(37, 99, 235, 0.14)"
                    stroke="#3B82F6"
                    strokeWidth="0.6"
                  />
                </svg>
                {(['tl', 'tr', 'br', 'bl'] as const).map((corner) => (
                  <button
                    key={corner}
                    type="button"
                    aria-label={`Drag ${corner.toUpperCase()} perspective corner`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      draggingCornerRef.current = corner;
                      stageOverlayRef.current?.setPointerCapture(e.pointerId);
                    }}
                    style={{
                      left: `${perspectiveQuad[corner].x * 100}%`,
                      top: `${perspectiveQuad[corner].y * 100}%`,
                    }}
                    className="absolute -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow cursor-move"
                  />
                ))}
              </div>
            )}

            {/* Interactive Annotation & Region Redaction Surface (Features 49 & 53) */}
            {(isAnnotating || isRedacting) && (
              <div
                ref={stageOverlayRef}
                onPointerDown={handleOverlayPointerDown}
                onPointerMove={handleOverlayPointerMove}
                onPointerUp={handleOverlayPointerUp}
                className="absolute inset-0 z-10 cursor-crosshair"
              >
                <svg className="w-full h-full pointer-events-none" viewBox="0 0 1000 1000" preserveAspectRatio="none">
                  {isAnnotating &&
                    annotations.map((s) => {
                      const x1 = s.x1 * 1000;
                      const y1 = s.y1 * 1000;
                      const x2 = s.x2 * 1000;
                      const y2 = s.y2 * 1000;
                      if (s.kind === 'rect') {
                        return (
                          <rect
                            key={s.id}
                            x={Math.min(x1, x2)}
                            y={Math.min(y1, y2)}
                            width={Math.abs(x2 - x1)}
                            height={Math.abs(y2 - y1)}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={6}
                          />
                        );
                      }
                      if (s.kind === 'circle') {
                        return (
                          <ellipse
                            key={s.id}
                            cx={(x1 + x2) / 2}
                            cy={(y1 + y2) / 2}
                            rx={Math.abs(x2 - x1) / 2}
                            ry={Math.abs(y2 - y1) / 2}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={6}
                          />
                        );
                      }
                      if (s.kind === 'arrow') {
                        return (
                          <line
                            key={s.id}
                            x1={x1}
                            y1={y1}
                            x2={x2}
                            y2={y2}
                            stroke={s.color}
                            strokeWidth={7}
                            strokeLinecap="round"
                          />
                        );
                      }
                      if (s.kind === 'highlight' && s.points) {
                        const pts = s.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ');
                        return (
                          <polyline
                            key={s.id}
                            points={pts}
                            fill="none"
                            stroke={s.color}
                            strokeOpacity={0.45}
                            strokeWidth={22}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        );
                      }
                      if (s.kind === 'step') {
                        return (
                          <g key={s.id}>
                            <circle cx={x1} cy={y1} r={24} fill={s.color} />
                            <text
                              x={x1}
                              y={y1 + 9}
                              textAnchor="middle"
                              fill="#FFFFFF"
                              fontSize="26"
                              fontWeight="700"
                            >
                              {s.stepNumber}
                            </text>
                          </g>
                        );
                      }
                      return null;
                    })}

                  {isRedacting &&
                    redactionBoxes.map((b) => (
                      <rect
                        key={b.id}
                        x={b.x * 1000}
                        y={b.y * 1000}
                        width={b.w * 1000}
                        height={b.h * 1000}
                        fill={b.mode === 'blackout' ? 'rgba(9,9,11,0.88)' : 'rgba(220,38,38,0.26)'}
                        stroke="#EF4444"
                        strokeDasharray="10 6"
                        strokeWidth={4}
                      />
                    ))}
                </svg>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Filmstrip Asset Tray */}
      <div className="h-[74px] shrink-0 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 flex items-center gap-2 overflow-x-auto">
        {assets.map((asset) => {
          const selected = activeAsset?.id === asset.id;
          return (
            <div
              key={asset.id}
              className={`group relative flex items-center gap-2 pr-2 pl-1 py-1 rounded-lg border shrink-0 transition-colors ${
                selected
                  ? 'border-blue-600 bg-blue-50/70 dark:bg-blue-950/40'
                  : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <button
                type="button"
                onClick={() => onSelectAsset(asset.id)}
                className="flex items-center gap-2 text-left focus-visible:outline-none"
              >
                <img
                  src={asset.previewUrl}
                  alt={asset.name}
                  referrerPolicy="no-referrer"
                  className="w-11 h-11 rounded object-cover bg-slate-200 dark:bg-slate-800 shrink-0"
                />
                <div className="max-w-[132px]">
                  <p className="text-[11px] font-medium text-slate-900 dark:text-slate-100 truncate">
                    {asset.name}
                  </p>
                  <p className="text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    {asset.width}×{asset.height} · {formatBytes(asset.currentBytes)}
                  </p>
                </div>
              </button>
              <button
                type="button"
                onClick={() => onRemoveAsset(asset.id)}
                aria-label={`Remove ${asset.name}`}
                className="p-1 text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onOpenFiles}
          className="h-12 px-3 border border-dashed border-slate-300 dark:border-slate-700 hover:border-blue-500 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
        >
          <ImagePlus className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Add</span>
        </button>

        {assets.length === 0 && (
          <button
            type="button"
            onClick={onLoadSamples}
            className="h-12 px-3 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap shrink-0 transition-colors"
          >
            Load 3 Sample Photos
          </button>
        )}
      </div>
    </section>
  );
}
