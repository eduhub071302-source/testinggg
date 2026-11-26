import { FolderOpen, HardDrive, RefreshCw, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { MountedDirectoryState, supportsFileSystemAccess } from '../engine/fileExplorer';
import { formatBytes } from '../engine/memoryGovernor';
import { MemoryStats, OpfsFileEntry } from '../types/studio';

interface StorageExplorerViewProps {
  memoryStats: MemoryStats;
  opfsFiles: OpfsFileEntry[];
  mountedDir: MountedDirectoryState | null;
  onRefreshOpfs: () => void;
  onFlushMemory: () => void;
  onPurgeHistory: () => void;
  onDeleteOpfsFile: (path: string) => void;
  onMountFolder: () => void;
  onImportFromMounted: (handle: FileSystemFileHandle) => void;
}

export function StorageExplorerView({
  memoryStats,
  opfsFiles,
  mountedDir,
  onRefreshOpfs,
  onFlushMemory,
  onPurgeHistory,
  onDeleteOpfsFile,
  onMountFolder,
  onImportFromMounted,
}: StorageExplorerViewProps) {
  const ramPercent = Math.min(100, Math.round((memoryStats.trackedBytes / memoryStats.limitBytes) * 1000) / 10);
  const isHttps = typeof window !== 'undefined' && (window.location.protocol === 'https:' || window.location.hostname === 'localhost');
  const fsSupported = supportsFileSystemAccess();

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-950 p-6">
      <div className="max-w-6xl mx-auto space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
              OPFS Vault, 300 MB Memory Governor & File Explorer
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Direct Origin Private File System persistence keeps full-resolution binaries on local disk while strictly capping active tab RAM below 300 MB.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onFlushMemory}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg"
            >
              <Zap className="w-3.5 h-3.5" />
              <span>Reclaim Unpinned RAM</span>
            </button>
            <button
              type="button"
              onClick={onMountFolder}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>{mountedDir ? `Remount (${mountedDir.name})` : 'Connect OS Folder'}</span>
            </button>
          </div>
        </div>

        {/* 4-Column Metric Strip */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">Active Tab Memory</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {formatBytes(memoryStats.trackedBytes)}
            </p>
            <div className="mt-2.5 h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${ramPercent > 75 ? 'bg-amber-500' : 'bg-blue-600'}`}
                style={{ width: `${Math.max(2, ramPercent)}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] font-mono tabular-nums text-slate-500">
              {ramPercent}% of 300 MB cap · {memoryStats.evictionCount} LRU evictions
            </p>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">OPFS Local Disk Vault</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {formatBytes(memoryStats.opfsUsedBytes)}
            </p>
            <p className="mt-2 text-[11px] font-mono tabular-nums text-slate-500">
              Backend: {memoryStats.storageBackend.toUpperCase()} · {opfsFiles.length} files stored
            </p>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">Live ObjectURLs & Heap</p>
            <p className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100 mt-1">
              {memoryStats.activeObjectUrls} handles
            </p>
            <p className="mt-2 text-[11px] font-mono tabular-nums text-slate-500">
              {memoryStats.jsHeapUsedBytes
                ? `JS Heap: ${formatBytes(memoryStats.jsHeapUsedBytes)}`
                : 'Auto-disposed after every frame'}
            </p>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <p className="text-xs text-slate-500 dark:text-slate-400">Security & Transport</p>
            <div className="mt-1.5 flex items-center gap-1.5 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>{isHttps ? 'Secure Context Active' : 'Local Context'}</span>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              100% client-side · Zero uploads · File Explorer API {fsSupported ? 'ready' : 'fallback mode'}
            </p>
          </div>
        </div>

        {/* Direct File Explorer Mounted Folder Panel */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderOpen className="w-4 h-4 text-slate-500" />
              <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Direct OS File Explorer Bridge {mountedDir ? `— /${mountedDir.name}` : ''}
              </h2>
            </div>
            <button
              type="button"
              onClick={onMountFolder}
              className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              {mountedDir ? 'Switch Folder' : 'Mount Local Folder'}
            </button>
          </div>

          {!mountedDir ? (
            <div className="p-6 text-xs text-slate-500 dark:text-slate-400 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p>
                Connect any local folder on your computer to browse images directly from your OS File Explorer and write batch exports without zipping.
              </p>
              <button
                type="button"
                onClick={onMountFolder}
                className="px-3.5 py-2 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 rounded-lg whitespace-nowrap shrink-0"
              >
                Open Directory Picker
              </button>
            </div>
          ) : (
            <div className="max-h-60 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800">
              {mountedDir.entries.length === 0 ? (
                <p className="p-6 text-xs text-slate-500">No supported image files found in /{mountedDir.name}.</p>
              ) : (
                mountedDir.entries.map((entry) => (
                  <div key={entry.name} className="px-4 py-2 flex items-center justify-between text-xs hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{entry.name}</span>
                    <div className="flex items-center gap-4 shrink-0">
                      <span className="font-mono tabular-nums text-slate-500">{formatBytes(entry.size)}</span>
                      <button
                        type="button"
                        onClick={() => onImportFromMounted(entry.handle)}
                        className="px-2.5 py-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/50 rounded"
                      >
                        Load into OPFS
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* OPFS Disk Table */}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-slate-500" />
              <h2 className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Origin Private File System (OPFS) Entries
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPurgeHistory}
                className="px-2.5 py-1 text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
              >
                Purge Undo Cache
              </button>
              <button
                type="button"
                onClick={onRefreshOpfs}
                aria-label="Refresh OPFS file list"
                className="p-1.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="overflow-x-auto max-h-72 overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 sticky top-0">
                <tr>
                  <th className="py-2 px-4 font-medium">Folder</th>
                  <th className="py-2 px-4 font-medium">Path</th>
                  <th className="py-2 px-4 font-medium text-right">Size</th>
                  <th className="py-2 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {opfsFiles.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-slate-500">
                      OPFS vault is currently empty.
                    </td>
                  </tr>
                ) : (
                  opfsFiles.map((file) => (
                    <tr key={file.path} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="py-2 px-4 font-mono text-[11px] text-slate-500">{file.folder}</td>
                      <td className="py-2 px-4 font-mono text-[11px] text-slate-800 dark:text-slate-200">{file.name}</td>
                      <td className="py-2 px-4 font-mono tabular-nums text-right text-slate-700 dark:text-slate-300">
                        {formatBytes(file.size)}
                      </td>
                      <td className="py-2 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => onDeleteOpfsFile(file.path)}
                          aria-label={`Delete OPFS file ${file.name}`}
                          className="p-1 text-slate-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
