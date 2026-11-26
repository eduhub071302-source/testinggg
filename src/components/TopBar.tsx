import { Download } from 'lucide-react';
import { WorkspaceTab } from '../types/studio';

interface TopBarProps {
  activeTab: WorkspaceTab;
  onSelectTab: (tab: WorkspaceTab) => void;
  onExportActive: () => void;
  canExport: boolean;
  assetCount: number;
}

const NAV_TABS: Array<{ id: WorkspaceTab; label: string }> = [
  { id: 'editor', label: 'Editor' },
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'batch', label: 'Batch' },
  { id: 'storage', label: 'Storage' },
];

export function TopBar({ activeTab, onSelectTab, onExportActive, canExport, assetCount }: TopBarProps) {
  return (
    <header className="h-14 shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6 flex items-center justify-between gap-8">
      {/* Zone 1: Single-line Brand Wordmark */}
      <button
        type="button"
        onClick={() => onSelectTab('editor')}
        className="text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
      >
        ChromaForge
      </button>

      {/* Zone 2: 4 Clean Single-Line Navigation Links */}
      <nav aria-label="Workspace views" className="flex items-center gap-5 sm:gap-7 overflow-x-auto">
        {NAV_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`relative py-4 text-sm font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded ${
                isActive
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              {tab.label}
              {tab.id === 'batch' && assetCount > 0 ? ` (${assetCount})` : ''}
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 bottom-0 h-0.5 bg-blue-600 dark:bg-blue-400"
                />
              )}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: Single Primary Action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onExportActive}
          disabled={!canExport}
          className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 dark:disabled:bg-slate-800 disabled:text-slate-500 rounded-lg transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-slate-900"
        >
          <Download className="w-3.5 h-3.5" aria-hidden="true" />
          <span>Export</span>
        </button>
      </div>
    </header>
  );
}
