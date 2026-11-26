import { useCallback, useEffect, useState } from 'react';
import { BatchWorkspace } from './components/BatchWorkspace';
import { CanvasStage } from './components/CanvasStage';
import { PipelineWorkspace } from './components/PipelineWorkspace';
import { StorageExplorerView } from './components/StorageExplorerView';
import { ToolInspector } from './components/ToolInspector';
import { ToolSidebar } from './components/ToolSidebar';
import { TopBar } from './components/TopBar';
import { SAMPLE_ASSETS } from './data/toolsCatalog';
import { applyRenamePattern } from './engine/dspAlgorithms';
import {
  copyBlobToClipboard,
  mountLocalDirectory,
  MountedDirectoryState,
  pickFilesFromExplorer,
  saveBlobToDisk,
  writeBatchToDirectory,
} from './engine/fileExplorer';
import {
  buildZipBlob,
  composeMultiImages,
  compressToTargetSize,
  decodeAnyFileToBitmap,
  executeToolOnBlob,
  extForMime,
  runPipelineOnBlob,
} from './engine/imageProcessor';
import { formatBytes, memoryGovernor } from './engine/memoryGovernor';
import { opfsVault } from './engine/opfsVault';
import {
  AnnotationShape,
  BatchExportFile,
  MemoryStats,
  OpfsFileEntry,
  PerspectiveQuad,
  PipelineStep,
  RedactionBox,
  SavedPreset,
  StudioAsset,
  ToolId,
  WorkspaceTab,
} from './types/studio';

const DEFAULT_QUAD: PerspectiveQuad = {
  tl: { x: 0.08, y: 0.08 },
  tr: { x: 0.92, y: 0.08 },
  br: { x: 0.92, y: 0.92 },
  bl: { x: 0.08, y: 0.92 },
};

const INITIAL_PIPELINE: PipelineStep[] = [
  { id: 'init-1', toolId: 'auto-trim', label: 'Auto-Trim Whitespace', enabled: true, params: { tolerance: 18, padding: 10 } },
  { id: 'init-2', toolId: 'canvas-squaring', label: '1:1 Square Auto-Pad', enabled: true, params: { bgColor: '#FFFFFF' } },
  { id: 'init-3', toolId: 'target-size', label: 'Target Size ≤150 KB', enabled: true, params: { targetKb: 150, format: 'image/webp' } },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('editor');
  const [activeToolId, setActiveToolId] = useState<ToolId>('target-size');
  const [darkMode, setDarkMode] = useState(false);

  const [assets, setAssets] = useState<StudioAsset[]>([]);
  const [activeAssetId, setActiveAssetId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastSummary, setLastSummary] = useState('');
  const [batchProgress, setBatchProgress] = useState('');

  // Interactive Stage States
  const [splitMode, setSplitMode] = useState(false);
  const [annotations, setAnnotations] = useState<AnnotationShape[]>([]);
  const [activeAnnotateKind, setActiveAnnotateKind] = useState<AnnotationShape['kind']>('arrow');
  const [annotateColor, setAnnotateColor] = useState('#EF4444');
  const [redactionBoxes, setRedactionBoxes] = useState<RedactionBox[]>([]);
  const [activeRedactMode, setActiveRedactMode] = useState<RedactionBox['mode']>('blur');
  const [perspectiveQuad, setPerspectiveQuad] = useState<PerspectiveQuad>(DEFAULT_QUAD);
  const [passportStandard, setPassportStandard] = useState('us-2x2');
  const [visualDiffOverlayUrl, setVisualDiffOverlayUrl] = useState<string | null>(null);
  const [visualDiffViewMode, setVisualDiffViewMode] = useState<'slider' | 'onion' | 'heatmap'>('heatmap');
  const [visualDiffOnionOpacity, setVisualDiffOnionOpacity] = useState(50);

  // Pipeline & Presets
  const [pipelineSteps, setPipelineSteps] = useState<PipelineStep[]>(INITIAL_PIPELINE);
  const [savedPresets, setSavedPresets] = useState<SavedPreset[]>([]);

  // OPFS, Memory Governor & OS File Explorer
  const [opfsFiles, setOpfsFiles] = useState<OpfsFileEntry[]>([]);
  const [mountedDir, setMountedDir] = useState<MountedDirectoryState | null>(null);
  const [memoryStats, setMemoryStats] = useState<MemoryStats>({
    trackedBytes: 0,
    limitBytes: memoryGovernor.hardLimitBytes,
    softLimitBytes: memoryGovernor.softLimitBytes,
    activeObjectUrls: 0,
    evictionCount: 0,
    jsHeapUsedBytes: null,
    opfsUsedBytes: 0,
    opfsQuotaBytes: 1024 * 1024 * 1024,
    storageBackend: 'opfs',
  });

  const activeAsset = assets.find((a) => a.id === activeAssetId) || assets[0] || null;

  // Toggle Tailwind v4 `.dark` class cleanly on <html>
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  const refreshMemoryAndOpfs = useCallback(async () => {
    const [files, est] = await Promise.all([opfsVault.listFiles(), opfsVault.getStorageEstimate()]);
    setOpfsFiles(files);
    setMemoryStats({
      trackedBytes: memoryGovernor.getTrackedBytes(),
      limitBytes: memoryGovernor.hardLimitBytes,
      softLimitBytes: memoryGovernor.softLimitBytes,
      activeObjectUrls: memoryGovernor.getActiveUrlCount(),
      evictionCount: memoryGovernor.getEvictionCount(),
      jsHeapUsedBytes: memoryGovernor.getJsHeapUsedBytes(),
      opfsUsedBytes: est.used,
      opfsQuotaBytes: est.quota,
      storageBackend: opfsVault.getBackend(),
    });
  }, []);

  useEffect(() => {
    const unsub = memoryGovernor.subscribe(() => {
      setMemoryStats((prev) => ({
        ...prev,
        trackedBytes: memoryGovernor.getTrackedBytes(),
        activeObjectUrls: memoryGovernor.getActiveUrlCount(),
        evictionCount: memoryGovernor.getEvictionCount(),
        jsHeapUsedBytes: memoryGovernor.getJsHeapUsedBytes(),
      }));
    });
    return unsub;
  }, []);

  // Ingest any Blob/File directly into OPFS vault with 300MB RAM managed preview URL
  const ingestBlobIntoStudio = useCallback(
    async (
      blob: Blob,
      name: string,
      source: StudioAsset['source'] = 'upload',
      selectImmediately = true
    ): Promise<StudioAsset | null> => {
      try {
        const bmp = await decodeAnyFileToBitmap(blob, name);
        const width = bmp.width;
        const height = bmp.height;
        bmp.close();

        const id = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const ext = extForMime(blob.type || 'image/jpeg');
        const origPath = await opfsVault.writeBlob(`assets/${id}-orig.${ext}`, blob);
        const rev0Path = await opfsVault.writeBlob(`history/${id}-rev0.${ext}`, blob);

        const origUrl = memoryGovernor.createManagedBlobUrl(`${id}-orig`, blob, true);
        const curUrl = memoryGovernor.createManagedBlobUrl(`${id}-cur`, blob, true);

        const asset: StudioAsset = {
          id,
          name,
          mimeType: blob.type || 'image/jpeg',
          width,
          height,
          originalBytes: blob.size,
          currentBytes: blob.size,
          opfsOriginalPath: origPath,
          opfsCurrentPath: rev0Path,
          previewUrl: curUrl,
          originalPreviewUrl: origUrl,
          createdAt: Date.now(),
          source,
          historyIds: [rev0Path],
          historyIndex: 0,
        };

        setAssets((prev) => [...prev, asset]);
        if (selectImmediately) setActiveAssetId(id);
        await refreshMemoryAndOpfs();
        return asset;
      } catch (err) {
        setLastSummary(err instanceof Error ? err.message : `Could not decode ${name}`);
        return null;
      }
    },
    [refreshMemoryAndOpfs]
  );

  // Load 3 curated studio sample assets into OPFS on first boot
  const loadSampleStudioSet = useCallback(async () => {
    setIsProcessing(true);
    try {
      let firstId: string | null = null;
      for (const sample of SAMPLE_ASSETS) {
        const resp = await fetch(sample.url);
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const created = await ingestBlobIntoStudio(blob, sample.name, 'sample', firstId === null);
        if (created && !firstId) firstId = created.id;
      }
      if (firstId) setActiveAssetId(firstId);
      setLastSummary('Loaded 3 local studio sample images into OPFS vault');
    } finally {
      setIsProcessing(false);
    }
  }, [ingestBlobIntoStudio]);

  // Initialize OPFS, load presets, and auto-populate studio sample assets
  useEffect(() => {
    let mounted = true;
    (async () => {
      await opfsVault.init();
      const presets = await opfsVault.loadPresets();
      if (mounted) setSavedPresets(presets);
      if (mounted) await loadSampleStudioSet();
    })();
    return () => {
      mounted = false;
    };
  }, [loadSampleStudioSet]);

  // Update active asset with a new OPFS history revision (Non-Destructive Undo/Redo - Feature 79)
  const commitRevisionToAsset = useCallback(
    async (asset: StudioAsset, newBlob: Blob, width: number, height: number, extension: string, summary: string) => {
      const nextIndex = asset.historyIndex + 1;
      const revPath = await opfsVault.writeBlob(`history/${asset.id}-rev${nextIndex}-${Date.now()}.${extension}`, newBlob);
      const nextPreviewUrl = memoryGovernor.createManagedBlobUrl(`${asset.id}-cur`, newBlob, true);

      const trimmedHistory = asset.historyIds.slice(0, asset.historyIndex + 1);
      trimmedHistory.push(revPath);

      const newName = `${asset.name.replace(/\.[^.]+$/, '')}.${extension}`;

      setAssets((prev) =>
        prev.map((item) =>
          item.id === asset.id
            ? {
                ...item,
                name: newName,
                mimeType: newBlob.type || item.mimeType,
                width,
                height,
                currentBytes: newBlob.size,
                opfsCurrentPath: revPath,
                previewUrl: nextPreviewUrl,
                historyIds: trimmedHistory,
                historyIndex: trimmedHistory.length - 1,
              }
            : item
        )
      );
      setLastSummary(summary);
      await refreshMemoryAndOpfs();
    },
    [refreshMemoryAndOpfs]
  );

  // Undo / Redo / Reset backed by OPFS disk revisions
  const jumpHistory = useCallback(
    async (asset: StudioAsset, targetIndex: number) => {
      if (targetIndex < 0 || targetIndex >= asset.historyIds.length) return;
      const targetPath = asset.historyIds[targetIndex];
      const blob = await opfsVault.readBlob(targetPath);
      if (!blob) return;
      const bmp = await decodeAnyFileToBitmap(blob, asset.name);
      const w = bmp.width;
      const h = bmp.height;
      bmp.close();

      const previewUrl = memoryGovernor.createManagedBlobUrl(`${asset.id}-cur`, blob, true);
      setAssets((prev) =>
        prev.map((a) =>
          a.id === asset.id
            ? {
                ...a,
                width: w,
                height: h,
                currentBytes: blob.size,
                mimeType: blob.type || a.mimeType,
                opfsCurrentPath: targetPath,
                previewUrl,
                historyIndex: targetIndex,
              }
            : a
        )
      );
      setLastSummary(`Restored OPFS revision ${targetIndex + 1} of ${asset.historyIds.length}`);
      await refreshMemoryAndOpfs();
    },
    [refreshMemoryAndOpfs]
  );

  // Global Keyboard Shortcuts: Ctrl+V instant clipboard paste (Feature 78) + Ctrl+Z / Ctrl+Shift+Z (Feature 79)
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            await ingestBlobIntoStudio(file, `clipboard-${Date.now()}.png`, 'clipboard', true);
            setLastSummary('Pasted image from clipboard into OPFS vault');
          }
        }
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || !activeAsset) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (activeAsset.historyIndex > 0) {
          e.preventDefault();
          jumpHistory(activeAsset, activeAsset.historyIndex - 1);
        }
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        if (activeAsset.historyIndex < activeAsset.historyIds.length - 1) {
          e.preventDefault();
          jumpHistory(activeAsset, activeAsset.historyIndex + 1);
        }
      }
    };

    window.addEventListener('paste', onPaste);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('paste', onPaste);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [activeAsset, ingestBlobIntoStudio, jumpHistory]);

  const handleOpenFiles = async () => {
    const files = await pickFilesFromExplorer();
    if (files.length === 0) return;
    setIsProcessing(true);
    try {
      for (let i = 0; i < files.length; i++) {
        await ingestBlobIntoStudio(files[i], files[i].name, 'upload', i === 0);
      }
      setLastSummary(`Imported ${files.length} local file(s) into OPFS`);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleMountFolder = async () => {
    const mounted = await mountLocalDirectory();
    if (!mounted) {
      setLastSummary('Directory picker unavailable in this iframe — use Open Files or drag & drop');
      return;
    }
    setMountedDir(mounted);
    setActiveTab('storage');
    setLastSummary(`Mounted local folder /${mounted.name} (${mounted.entries.length} images found)`);
  };

  const handleApplyTool = async (
    toolId: ToolId,
    params: Record<string, unknown>
  ): Promise<BatchExportFile[] | undefined> => {
    if (!activeAsset) return undefined;
    setIsProcessing(true);
    try {
      const currentBlob = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
      if (!currentBlob) throw new Error('Source blob missing in OPFS vault');

      const extras: Array<{ name: string; blob: Blob }> = [];
      if (toolId === 'overlay-blend' || toolId === 'animated-compress' || toolId === 'gif-to-animated') {
        for (const a of assets) {
          if (toolId === 'overlay-blend' && a.id === activeAsset.id) continue;
          const b = await opfsVault.readBlob(a.opfsCurrentPath);
          if (b) extras.push({ name: a.name, blob: b });
        }
      }

      const result = await executeToolOnBlob(currentBlob, activeAsset.name, toolId, params, extras);
      await commitRevisionToAsset(
        activeAsset,
        result.blob,
        result.width,
        result.height,
        result.extension,
        result.summary
      );
      if (toolId === 'target-size' || toolId === 'quality-slider' || toolId === 'png-quantize') {
        setSplitMode(true);
      }
      return result.extraFiles;
    } catch (err) {
      setLastSummary(err instanceof Error ? err.message : 'Processing error');
      return undefined;
    } finally {
      setIsProcessing(false);
    }
  };

  const handleComposeMulti = async (
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
  ) => {
    if (assets.length === 0) return;
    setIsProcessing(true);
    setBatchProgress(`Composing ${assets.length} assets (${mode})...`);
    try {
      const items: Array<{ name: string; blob: Blob }> = [];
      for (const a of assets) {
        const b = await opfsVault.readBlob(a.opfsCurrentPath);
        if (b) items.push({ name: a.name, blob: b });
      }
      const res = await composeMultiImages(mode, items, options);
      if (mode === 'pdf' && res.extraFiles?.[0]) {
        await saveBlobToDisk(res.extraFiles[0].blob, res.extraFiles[0].name);
      } else if (mode === 'sprite-pack' && res.extraFiles) {
        const zip = await buildZipBlob(res.extraFiles);
        await saveBlobToDisk(zip, 'sprite-atlas-bundle.zip');
        await ingestBlobIntoStudio(res.blob, 'sprite-sheet.png', 'generated', true);
      } else {
        await ingestBlobIntoStudio(res.blob, `composed-${mode}.${res.extension}`, 'generated', true);
        setActiveTab('editor');
      }
      setLastSummary(res.summary);
      setBatchProgress(res.summary);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBulkCompressZip = async (opts: {
    format: 'image/webp' | 'image/jpeg' | 'image/png';
    quality: number;
    maxKb: number;
    renameTemplate: string;
    writeToFolder: boolean;
  }) => {
    if (assets.length === 0) return;
    setIsProcessing(true);
    try {
      const outputs: BatchExportFile[] = [];
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        setBatchProgress(`Processing ${i + 1} / ${assets.length}: ${asset.name}...`);
        const srcBlob = await opfsVault.readBlob(asset.opfsCurrentPath);
        if (!srcBlob) continue;

        const res =
          opts.maxKb > 0 && opts.format !== 'image/png'
            ? await compressToTargetSize(srcBlob, opts.maxKb * 1024, opts.format, true)
            : await executeToolOnBlob(srcBlob, asset.name, 'quality-slider', {
                format: opts.format,
                quality: opts.quality,
              });

        const outName = applyRenamePattern(opts.renameTemplate, {
          originalName: asset.name,
          index: i,
          ext: res.extension,
          width: res.width,
          height: res.height,
        });
        outputs.push({ name: outName, blob: res.blob });
        memoryGovernor.enforceBudget();
      }

      if (opts.writeToFolder && mountedDir) {
        const count = await writeBatchToDirectory(mountedDir.handle, outputs);
        setBatchProgress(`Wrote ${count} compressed files directly to /${mountedDir.name}/chromaforge-exports`);
      } else {
        const zip = await buildZipBlob(outputs);
        await saveBlobToDisk(zip, `chromaforge-batch-${outputs.length}-files.zip`);
        setBatchProgress(`Exported ${outputs.length} files into ZIP (${formatBytes(zip.size)})`);
      }
      await refreshMemoryAndOpfs();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRunPipelineActive = async () => {
    if (!activeAsset) return;
    setIsProcessing(true);
    try {
      const srcBlob = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
      if (!srcBlob) return;
      const res = await runPipelineOnBlob(srcBlob, activeAsset.name, pipelineSteps);
      await commitRevisionToAsset(activeAsset, res.blob, res.width, res.height, res.extension, res.summary);
      setActiveTab('editor');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRunPipelineBatch = async (writeToFolder: boolean) => {
    if (assets.length === 0) return;
    setIsProcessing(true);
    try {
      const outputs: BatchExportFile[] = [];
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const srcBlob = await opfsVault.readBlob(asset.opfsCurrentPath);
        if (!srcBlob) continue;
        const res = await runPipelineOnBlob(srcBlob, asset.name, pipelineSteps);
        outputs.push({ name: `${asset.name.replace(/\.[^.]+$/, '')}.${res.extension}`, blob: res.blob });
        memoryGovernor.enforceBudget();
      }
      if (writeToFolder && mountedDir) {
        const count = await writeBatchToDirectory(mountedDir.handle, outputs);
        setLastSummary(`Pipeline wrote ${count} outputs to /${mountedDir.name}/chromaforge-exports`);
      } else {
        const zip = await buildZipBlob(outputs);
        await saveBlobToDisk(zip, `chromaforge-pipeline-${outputs.length}.zip`);
        setLastSummary(`Pipeline exported ${outputs.length} files (${formatBytes(zip.size)})`);
      }
      await refreshMemoryAndOpfs();
    } finally {
      setIsProcessing(false);
    }
  };

  const handleExportActive = async () => {
    if (!activeAsset) return;
    const blob = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
    if (!blob) return;
    const method = await saveBlobToDisk(blob, activeAsset.name);
    if (method !== 'cancelled') {
      setLastSummary(`Saved ${activeAsset.name} cleanly (${formatBytes(blob.size)})`);
    }
  };

  const handleRemoveAsset = async (id: string) => {
    const target = assets.find((a) => a.id === id);
    if (!target) return;
    memoryGovernor.release(`${id}-orig`);
    memoryGovernor.release(`${id}-cur`);
    await opfsVault.deleteFile(target.opfsOriginalPath);
    for (const h of target.historyIds) {
      await opfsVault.deleteFile(h);
    }
    setAssets((prev) => {
      const remaining = prev.filter((a) => a.id !== id);
      if (activeAssetId === id) setActiveAssetId(remaining[0]?.id ?? null);
      return remaining;
    });
    await refreshMemoryAndOpfs();
  };

  return (
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onExportActive={handleExportActive}
        canExport={Boolean(activeAsset)}
        assetCount={assets.length}
      />

      <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {activeTab === 'editor' && (
          <>
            <ToolSidebar
              activeToolId={activeToolId}
              onSelectTool={(id) => {
                setActiveToolId(id);
                if (id === 'quality-slider' || id === 'target-size') {
                  setSplitMode(true);
                }
              }}
            />

            <CanvasStage
              assets={assets}
              activeAsset={activeAsset}
              activeToolId={activeToolId}
              memoryStats={memoryStats}
              darkMode={darkMode}
              onToggleDarkMode={() => setDarkMode((d) => !d)}
              onSelectAsset={setActiveAssetId}
              onRemoveAsset={handleRemoveAsset}
              onOpenFiles={handleOpenFiles}
              onMountFolder={handleMountFolder}
              onLoadSamples={loadSampleStudioSet}
              onDropFiles={async (files) => {
                for (let i = 0; i < files.length; i++) {
                  await ingestBlobIntoStudio(files[i], files[i].name, 'upload', i === 0);
                }
              }}
              onUndo={() => activeAsset && jumpHistory(activeAsset, activeAsset.historyIndex - 1)}
              onRedo={() => activeAsset && jumpHistory(activeAsset, activeAsset.historyIndex + 1)}
              onResetOriginal={() => activeAsset && jumpHistory(activeAsset, 0)}
              onCopyClipboard={async () => {
                if (!activeAsset) return;
                const b = await opfsVault.readBlob(activeAsset.opfsCurrentPath);
                if (b) {
                  const ok = await copyBlobToClipboard(b);
                  setLastSummary(ok ? 'Copied image to system clipboard' : 'Clipboard write blocked in preview frame');
                }
              }}
              canUndo={Boolean(activeAsset && activeAsset.historyIndex > 0)}
              canRedo={Boolean(activeAsset && activeAsset.historyIndex < activeAsset.historyIds.length - 1)}
              splitMode={splitMode}
              onToggleSplitMode={() => setSplitMode((s) => !s)}
              annotations={annotations}
              onChangeAnnotations={setAnnotations}
              activeAnnotateKind={activeAnnotateKind}
              annotateColor={annotateColor}
              redactionBoxes={redactionBoxes}
              onChangeRedactionBoxes={setRedactionBoxes}
              activeRedactMode={activeRedactMode}
              perspectiveQuad={perspectiveQuad}
              onChangePerspectiveQuad={setPerspectiveQuad}
              visualDiffOverlayUrl={visualDiffOverlayUrl}
              visualDiffViewMode={visualDiffViewMode}
              visualDiffOnionOpacity={visualDiffOnionOpacity}
              passportStandard={passportStandard}
            />

            <ToolInspector
              activeToolId={activeToolId}
              activeAsset={activeAsset}
              assets={assets}
              isProcessing={isProcessing}
              lastSummary={lastSummary}
              onApplyTool={handleApplyTool}
              onComposeMulti={handleComposeMulti}
              onImportDecodedBlob={async (blob, name) => {
                await ingestBlobIntoStudio(blob, name, 'generated', true);
              }}
              onNavigateTab={setActiveTab}
              annotations={annotations}
              onChangeAnnotations={setAnnotations}
              activeAnnotateKind={activeAnnotateKind}
              onChangeAnnotateKind={setActiveAnnotateKind}
              annotateColor={annotateColor}
              onChangeAnnotateColor={setAnnotateColor}
              redactionBoxes={redactionBoxes}
              onChangeRedactionBoxes={setRedactionBoxes}
              activeRedactMode={activeRedactMode}
              onChangeRedactMode={setActiveRedactMode}
              perspectiveQuad={perspectiveQuad}
              onResetPerspectiveQuad={() => setPerspectiveQuad(DEFAULT_QUAD)}
              passportStandard={passportStandard}
              onChangePassportStandard={setPassportStandard}
              onUpdateVisualDiff={(url, mode, op) => {
                if (url !== null) setVisualDiffOverlayUrl(url);
                setVisualDiffViewMode(mode);
                setVisualDiffOnionOpacity(op);
              }}
            />
          </>
        )}

        {activeTab === 'pipeline' && (
          <PipelineWorkspace
            assets={assets}
            activeAsset={activeAsset}
            steps={pipelineSteps}
            presets={savedPresets}
            isRunning={isProcessing}
            mountedDirName={mountedDir?.name ?? null}
            onChangeSteps={setPipelineSteps}
            onSavePreset={async (name) => {
              const next: SavedPreset[] = [
                { id: `preset-${Date.now()}`, name, createdAt: Date.now(), steps: pipelineSteps },
                ...savedPresets,
              ];
              setSavedPresets(next);
              await opfsVault.savePresets(next);
              await refreshMemoryAndOpfs();
            }}
            onDeletePreset={async (id) => {
              const next = savedPresets.filter((p) => p.id !== id);
              setSavedPresets(next);
              await opfsVault.savePresets(next);
            }}
            onLoadPreset={(preset) => setPipelineSteps(preset.steps)}
            onRunOnActive={handleRunPipelineActive}
            onRunOnBatchZip={() => handleRunPipelineBatch(false)}
            onRunOnBatchExplorer={() => handleRunPipelineBatch(true)}
          />
        )}

        {activeTab === 'batch' && (
          <BatchWorkspace
            assets={assets}
            isRunning={isProcessing}
            progressText={batchProgress}
            mountedDirName={mountedDir?.name ?? null}
            onOpenFiles={handleOpenFiles}
            onBulkCompressZip={handleBulkCompressZip}
            onComposeMulti={handleComposeMulti}
          />
        )}

        {activeTab === 'storage' && (
          <StorageExplorerView
            memoryStats={memoryStats}
            opfsFiles={opfsFiles}
            mountedDir={mountedDir}
            onRefreshOpfs={refreshMemoryAndOpfs}
            onFlushMemory={() => {
              const count = memoryGovernor.flushUnpinned();
              setLastSummary(`Reclaimed ${count} unpinned RAM handles`);
              refreshMemoryAndOpfs();
            }}
            onPurgeHistory={async () => {
              await opfsVault.purgeFolder('history');
              await refreshMemoryAndOpfs();
            }}
            onDeleteOpfsFile={async (path) => {
              await opfsVault.deleteFile(path);
              await refreshMemoryAndOpfs();
            }}
            onMountFolder={handleMountFolder}
            onImportFromMounted={async (handle) => {
              const file = await handle.getFile();
              await ingestBlobIntoStudio(file, file.name, 'explorer', true);
              setActiveTab('editor');
            }}
          />
        )}
      </main>
    </div>
  );
}
