import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { TOOL_CATEGORIES, TOOLS_CATALOG } from '../data/toolsCatalog';
import { ToolCategoryId, ToolDefinition, ToolId } from '../types/studio';

interface ToolSidebarProps {
  activeToolId: ToolId;
  onSelectTool: (id: ToolId) => void;
}

export function ToolSidebar({ activeToolId, onSelectTool }: ToolSidebarProps) {
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<ToolCategoryId | 'all'>('all');

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TOOLS_CATALOG.filter((tool) => {
      if (selectedCategory !== 'all' && tool.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        tool.name.toLowerCase().includes(q) ||
        tool.shortName.toLowerCase().includes(q) ||
        tool.description.toLowerCase().includes(q) ||
        String(tool.number) === q ||
        tool.keywords.some((k) => k.toLowerCase().includes(q))
      );
    });
  }, [query, selectedCategory]);

  const grouped = useMemo(() => {
    const map = new Map<ToolCategoryId, ToolDefinition[]>();
    for (const cat of TOOL_CATEGORIES) {
      map.set(cat.id, []);
    }
    for (const tool of filteredTools) {
      map.get(tool.category)?.push(tool);
    }
    return TOOL_CATEGORIES.filter((cat) => (map.get(cat.id)?.length ?? 0) > 0).map((cat) => ({
      category: cat,
      tools: map.get(cat.id)!,
    }));
  }, [filteredTools]);

  return (
    <aside
      aria-label="Image engineering tools"
      className="w-full lg:w-[272px] shrink-0 border-b lg:border-b-0 lg:border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col lg:h-full overflow-hidden"
    >
      {/* Search + Category Selector */}
      <div className="p-3 border-b border-slate-200 dark:border-slate-800 space-y-2.5 shrink-0">
        <div className="relative">
          <Search
            className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search 80 tools..."
            aria-label="Search 80 tools"
            className="w-full pl-8 pr-7 py-1.5 text-xs bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-md text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear tool search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setSelectedCategory('all')}
            className={`px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${
              selectedCategory === 'all'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            All (80)
          </button>
          {TOOL_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-2 py-0.5 text-[11px] font-medium rounded whitespace-nowrap transition-colors ${
                selectedCategory === cat.id
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {cat.shortName}
            </button>
          ))}
        </div>
      </div>

      {/* Scrollable Tool Directory */}
      <div className="flex-1 overflow-y-auto p-2 space-y-4 max-h-56 lg:max-h-none">
        {grouped.length === 0 ? (
          <div className="px-3 py-8 text-center">
            <p className="text-xs text-slate-500 dark:text-slate-400">No tools match "{query}".</p>
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setSelectedCategory('all');
              }}
              className="mt-2 text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline"
            >
              Reset filter
            </button>
          </div>
        ) : (
          grouped.map(({ category, tools }) => (
            <div key={category.id}>
              <div className="px-2.5 pb-1 flex items-center justify-between text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <span className="truncate">{category.name}</span>
                <span className="font-mono tabular-nums text-[10px] text-slate-400 dark:text-slate-500 shrink-0 ml-2">
                  {category.range}
                </span>
              </div>
              <ul className="space-y-0.5">
                {tools.map((tool) => {
                  const isActive = tool.id === activeToolId;
                  return (
                    <li key={tool.id}>
                      <button
                        type="button"
                        onClick={() => onSelectTool(tool.id)}
                        aria-current={isActive ? 'true' : undefined}
                        className={`w-full text-left px-2.5 py-1.5 rounded-md text-xs flex items-center gap-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 ${
                          isActive
                            ? 'bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 font-semibold'
                            : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/70'
                        }`}
                      >
                        <span
                          className={`font-mono tabular-nums text-[10px] w-5 shrink-0 ${
                            isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400 dark:text-slate-500'
                          }`}
                        >
                          {String(tool.number).padStart(2, '0')}
                        </span>
                        <span className="truncate">{tool.shortName}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
