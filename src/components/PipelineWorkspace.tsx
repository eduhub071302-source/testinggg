import {
  ArrowDown,
  ArrowUp,
  BookmarkPlus,
  Download,
  FolderOutput,
  Layers,
  Play,
  Plus,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { TOOL_BY_ID, TOOLS_CATALOG } from '../data/toolsCatalog';
import { formatBytes } from '../engine/memoryGovernor';
import { PipelineStep, SavedPreset, StudioAsset, ToolId } from '../types/studio';

interface PipelineWorkspaceProps {
  assets: StudioAsset[];
  activeAsset: StudioAsset | null;
  steps: PipelineStep[];
  presets: SavedPreset[];
  isRunning: boolean;
  mountedDirName: string | null;
  onChangeSteps: (steps: PipelineStep[]) => void;
  onSavePreset: (name: string) => void;
  onDeletePreset: (id: string) => void;
  onLoadPreset: (preset: SavedPreset) => void;
  onRunOnActive: () => Promise<void>;
  onRunOnBatchZip: () => Promise<void>;
  onRunOnBatchExplorer: () => Promise<void>;
}

const CHAINABLE_TOOLS = TOOLS_CATALOG.filter((t) => t.supportsBatch && t.category !== 'workflow');

const STARTER_PRESETS: Array<{ name: string; description: string; steps: Omit<PipelineStep, 'id'>[] }> = [
  {
    name: 'E-Commerce Master (Trim → 1:1 Pad → WebP <150KB)',
    description: 'Auto-trims whitespace, squares to white 1:1, adds subtle proof watermark, and solves under 150 KB.',
    steps: [
      { toolId: 'auto-trim', label: 'Auto-Trim Whitespace', enabled: true, params: { tolerance: 18, padding: 12 } },
      { toolId: 'canvas-squaring', label: '1:1 Square Auto-Pad', enabled: true, params: { bgColor: '#FFFFFF' } },
      { toolId: 'target-size', label: 'Target Size ≤150 KB (WebP)', enabled: true, params: { targetKb: 150, format: 'image/webp' } },
    ],
  },
  {
    name: 'Amazon Compliance (2000px 15% Margin + Scrub EXIF)',
    description: 'Centers product with 15% pure white border at 2000×2000 px and strips camera metadata.',
    steps: [
      { toolId: 'auto-trim', label: 'Auto-Trim Whitespace', enabled: true, params: { tolerance: 16, padding: 8 } },
      { toolId: 'marketplace-presets', label: 'Amazon 2000px (15% margin)', enabled: true, params: { marketplace: 'amazon' } },
      { toolId: 'exif-scrubber', label: 'Scrub EXIF Metadata', enabled: true, params: {} },
    ],
  },
  {
    name: 'Protected Client Proof (1200px + Tiled Copyright + WebP)',
    description: 'Resizes for web proofing, stamps diagonal copyright, and encodes to WebP.',
    steps: [
      { toolId: 'percent-mp-scale', label: 'Scale to 1.5 MP Max', enabled: true, params: { mode: 'megapixels', megapixels: 1.5 } },
      { toolId: 'tiled-watermark', label: 'Tiled Copyright Mark', enabled: true, params: { text: '© CLIENT PROOF', opacity: 22 } },
      { toolId: 'standard-to-webp', label: 'Encode WebP 84%', enabled: true, params: { quality: 84, format: 'image/webp' } },
    ],
  },
];

function defaultParamsForTool(toolId: ToolId): Record<string, unknown> {
  switch (toolId) {
    case 'target-size':
      return { targetKb: 150, format: 'image/webp', allowDownscale: true };
    case 'quality-slider':
    case 'standard-to-webp':
      return { quality: 82, format: 'image/webp' };
    case 'png-quantize':
      return { colors: 64, dither: true };
    case 'exact-resize':
      return { width: 1200, height: 800 };
    case 'percent-mp-scale':
      return { mode: 'percent', percent: 50, megapixels: 2 };
    case 'canvas-fit-pad':
      return { width: 1080, height: 1080, padMode: 'solid', bgColor: '#FFFFFF', marginPercent: 8 };
    case 'auto-trim':
      return { tolerance: 18, padding: 8 };
    case 'tiled-watermark':
      return { text: '© CHROMAFORGE', opacity: 22, angle: -30 };
    case 'logo-watermark':
      return { anchor: 'bottom-right', scale: 18, opacity: 75, fallbackBrand: 'STUDIO' };
    case 'marketplace-presets':
      return { marketplace: 'amazon' };
    case 'promo-badge':
      return { text: 'NEW', corner: 'top-right', bgColor: '#DC2626', badgeStyle: 'ribbon' };
    case 'dpi-changer':
      return { dpi: 300 };
    case 'bw-grayscale':
      return { preset: 'film' };
    default:
      return {};
  }
}

export function PipelineWorkspace({
  assets,
  activeAsset,
  steps,
  presets,
  isRunning,
  mountedDirName,
  onChangeSteps,
  onSavePreset,
  onDeletePreset,
  onLoadPreset,
  onRunOnActive,
  onRunOnBatchZip,
  onRunOnBatchExplorer,
}: PipelineWorkspaceProps) {
  const [selectedAddTool, setSelectedAddTool] = useState<ToolId>('auto-trim');
  const [presetName, setPresetName] = useState('');

  const addStep = () => {
    const def = TOOL_BY_ID[selectedAddTool];
    if (!def) return;
    onChangeSteps([
      ...steps,
      {
        id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        toolId: def.id,
        label: def.shortName,
        enabled: true,
        params: defaultParamsForTool(def.id),
      },
    ]);
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return;
    const copy = [...steps];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    onChangeSteps(copy);
  };

  const updateStepParam = (stepId: string, key: string, value: unknown) => {
    onChangeSteps(
      steps.map((s) => (s.id === stepId ? { ...s, params: { ...s.params, [key]: value } } : s))
    );
  };

  const handleSavePreset = () => {
    const trimmed = presetName.trim();
    if (!trimmed || steps.length === 0) return;
    onSavePreset(trimmed);
    setPresetName('');
  };

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Pipeline Builder */}
        <div className="lg:col-span-8 space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                Multi-Step Pipeline Chaining
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Execute ordered transformations in a single local pass while disposing intermediate canvases under 300 MB RAM.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onRunOnActive}
                disabled={isRunning || !activeAsset || steps.filter((s) => s.enabled).length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>{isRunning ? 'Running...' : 'Run on Active Image'}</span>
              </button>
              <button
                type="button"
                onClick={onRunOnBatchZip}
                disabled={isRunning || assets.length === 0 || steps.filter((s) => s.enabled).length === 0}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Run Batch ({assets.length}) → ZIP</span>
              </button>
              {mountedDirName && (
                <button
                  type="button"
                  onClick={onRunOnBatchExplorer}
                  disabled={isRunning || assets.length === 0 || steps.filter((s) => s.enabled).length === 0}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200 dark:border-emerald-800 hover:bg-emerald-100 rounded-lg transition-colors whitespace-nowrap"
                >
                  <FolderOutput className="w-3.5 h-3.5" />
                  <span>Write to /{mountedDirName}</span>
                </button>
              )}
            </div>
          </div>

          {/* Add Step Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center gap-2.5">
            <label htmlFor="pipeline-add-select" className="text-xs font-medium text-slate-600 dark:text-slate-300">
              Add operation
            </label>
            <select
              id="pipeline-add-select"
              value={selectedAddTool}
              onChange={(e) => setSelectedAddTool(e.target.value as ToolId)}
              className="flex-1 min-w-[220px] px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
            >
              {CHAINABLE_TOOLS.map((t) => (
                <option key={t.id} value={t.id}>
                  {String(t.number).padStart(2, '0')}. {t.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addStep}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 dark:bg-slate-100 dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200 rounded-md transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Append Step</span>
            </button>
          </div>

          {/* Ordered Step List */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-200 dark:divide-slate-800">
            {steps.length === 0 ? (
              <div className="p-10 text-center">
                <Layers className="w-7 h-7 mx-auto text-slate-400 mb-2" />
                <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No steps in pipeline yet</p>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Append an operation above or load one of the starter templates on the right.
                </p>
              </div>
            ) : (
              steps.map((step, idx) => (
                <div key={step.id} className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={step.enabled}
                      onChange={(e) =>
                        onChangeSteps(
                          steps.map((s) => (s.id === step.id ? { ...s, enabled: e.target.checked } : s))
                        )
                      }
                      aria-label={`Enable step ${idx + 1}: ${step.label}`}
                      className="mt-1 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                    />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums text-[11px] text-slate-400">
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <span className={`text-sm font-semibold ${step.enabled ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 line-through'}`}>
                          {step.label}
                        </span>
                      </div>

                      {/* Quick Inline Parameters for key steps */}
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        {step.toolId === 'target-size' && (
                          <>
                            <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                              <span>Max KB</span>
                              <input
                                type="number"
                                min={15}
                                max={10240}
                                value={Number(step.params.targetKb ?? 150)}
                                onChange={(e) => updateStepParam(step.id, 'targetKb', Number(e.target.value))}
                                className="w-20 px-2 py-1 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                              />
                            </label>
                            <select
                              value={String(step.params.format || 'image/webp')}
                              onChange={(e) => updateStepParam(step.id, 'format', e.target.value)}
                              className="px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                            >
                              <option value="image/webp">WebP</option>
                              <option value="image/jpeg">JPEG</option>
                              <option value="image/avif">AVIF</option>
                            </select>
                          </>
                        )}
                        {step.toolId === 'auto-trim' && (
                          <label className="flex items-center gap-1.5 text-slate-600 dark:text-slate-400">
                            <span>Tolerance</span>
                            <input
                              type="number"
                              min={0}
                              max={80}
                              value={Number(step.params.tolerance ?? 18)}
                              onChange={(e) => updateStepParam(step.id, 'tolerance', Number(e.target.value))}
                              className="w-16 px-2 py-1 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                            />
                          </label>
                        )}
                        {step.toolId === 'tiled-watermark' && (
                          <input
                            type="text"
                            value={String(step.params.text || '© PROOF')}
                            onChange={(e) => updateStepParam(step.id, 'text', e.target.value)}
                            aria-label="Watermark text"
                            className="w-44 px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded text-slate-900 dark:text-slate-100"
                          />
                        )}
                        {step.toolId === 'exact-resize' && (
                          <div className="flex items-center gap-1.5">
                            <input
                              type="number"
                              value={Number(step.params.width ?? 1200)}
                              onChange={(e) => updateStepParam(step.id, 'width', Number(e.target.value))}
                              aria-label="Target width"
                              className="w-20 px-2 py-1 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                            />
                            <span className="text-slate-400">×</span>
                            <input
                              type="number"
                              value={Number(step.params.height ?? 800)}
                              onChange={(e) => updateStepParam(step.id, 'height', Number(e.target.value))}
                              aria-label="Target height"
                              className="w-20 px-2 py-1 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                            />
                          </div>
                        )}
                        {step.toolId === 'dpi-changer' && (
                          <select
                            value={Number(step.params.dpi ?? 300)}
                            onChange={(e) => updateStepParam(step.id, 'dpi', Number(e.target.value))}
                            className="px-2 py-1 font-mono bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                          >
                            <option value={72}>72 DPI</option>
                            <option value={150}>150 DPI</option>
                            <option value={300}>300 DPI</option>
                            <option value={600}>600 DPI</option>
                          </select>
                        )}
                        {step.toolId === 'marketplace-presets' && (
                          <select
                            value={String(step.params.marketplace || 'amazon')}
                            onChange={(e) => updateStepParam(step.id, 'marketplace', e.target.value)}
                            className="px-2 py-1 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded"
                          >
                            <option value="amazon">Amazon (2000px · 15% white margin)</option>
                            <option value="ebay">eBay (1600px · 10% white margin)</option>
                            <option value="shopify">Shopify (2048px · 12% white margin)</option>
                          </select>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 self-end sm:self-center">
                    <button
                      type="button"
                      onClick={() => moveStep(idx, -1)}
                      disabled={idx === 0}
                      aria-label={`Move step ${idx + 1} up`}
                      className="p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 rounded"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveStep(idx, 1)}
                      disabled={idx === steps.length - 1}
                      aria-label={`Move step ${idx + 1} down`}
                      className="p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 rounded"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChangeSteps(steps.filter((s) => s.id !== step.id))}
                      aria-label={`Remove step ${idx + 1}`}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 rounded"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {activeAsset && (
            <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
              Active target: {activeAsset.name} · {activeAsset.width}×{activeAsset.height} · {formatBytes(activeAsset.currentBytes)}
            </p>
          )}
        </div>

        {/* Right: Saved Custom Presets (Feature 76) & Starter Templates */}
        <div className="lg:col-span-4 space-y-5">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Save Custom Preset</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Stored locally inside OPFS for instant recall across sessions.
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="e.g. Shopify Hero 200KB"
                aria-label="Custom preset name"
                className="flex-1 px-2.5 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={handleSavePreset}
                disabled={!presetName.trim() || steps.length === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 rounded-md whitespace-nowrap"
              >
                <BookmarkPlus className="w-3.5 h-3.5" />
                <span>Save</span>
              </button>
            </div>

            {presets.length > 0 && (
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <p className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">Your Saved Presets</p>
                {presets.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between gap-2 p-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/70 dark:border-slate-800"
                  >
                    <button
                      type="button"
                      onClick={() => onLoadPreset(p)}
                      className="text-left flex-1 min-w-0"
                    >
                      <p className="text-xs font-semibold text-slate-900 dark:text-slate-100 truncate">{p.name}</p>
                      <p className="text-[11px] text-slate-500 font-mono tabular-nums">{p.steps.length} steps</p>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeletePreset(p.id)}
                      aria-label={`Delete preset ${p.name}`}
                      className="p-1 text-slate-400 hover:text-red-600"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Ready-Made Pipelines</h2>
            <div className="space-y-2.5">
              {STARTER_PRESETS.map((tpl) => (
                <button
                  key={tpl.name}
                  type="button"
                  onClick={() =>
                    onChangeSteps(
                      tpl.steps.map((s, i) => ({
                        ...s,
                        id: `tpl-${Date.now()}-${i}`,
                      }))
                    )
                  }
                  className="w-full text-left p-3 rounded-lg border border-slate-200 dark:border-slate-800 hover:border-blue-500 dark:hover:border-blue-500 transition-colors"
                >
                  <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{tpl.name}</p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
                    {tpl.description}
                  </p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
