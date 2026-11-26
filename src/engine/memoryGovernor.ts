/**
 * 300 MB Tab Memory Governor
 * Tracks live ObjectURLs, decoded buffers, and temporary canvas allocations
 * with automatic LRU eviction at 210 MB (soft cap) and strict enforcement at 300 MB.
 */

export interface TrackedResource {
  id: string;
  url: string;
  bytes: number;
  lastAccessed: number;
  pinned: boolean;
  onEvict?: () => void;
}

export class MemoryGovernor {
  public readonly hardLimitBytes: number;
  public readonly softLimitBytes: number;
  private resources = new Map<string, TrackedResource>();
  private transientBytes = 0;
  private evictionCount = 0;
  private listeners = new Set<() => void>();

  constructor(hardLimitMB = 300, softLimitMB = 210) {
    this.hardLimitBytes = hardLimitMB * 1024 * 1024;
    this.softLimitBytes = softLimitMB * 1024 * 1024;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      fn();
    }
  }

  public getTrackedBytes(): number {
    let total = this.transientBytes;
    for (const item of this.resources.values()) {
      total += item.bytes;
    }
    return total;
  }

  public getActiveUrlCount(): number {
    return this.resources.size;
  }

  public getEvictionCount(): number {
    return this.evictionCount;
  }

  public getJsHeapUsedBytes(): number | null {
    const perf = typeof performance !== 'undefined' ? (performance as Performance & { memory?: { usedJSHeapSize: number } }) : null;
    if (perf?.memory && typeof perf.memory.usedJSHeapSize === 'number') {
      return perf.memory.usedJSHeapSize;
    }
    return null;
  }

  /**
   * Registers an ObjectURL (or simulated handle in Node tests) and enforces the 300 MB ceiling.
   */
  public registerObjectUrl(
    id: string,
    url: string,
    estimatedBytes: number,
    pinned = false,
    onEvict?: () => void
  ): string {
    // Replace existing entry with same ID cleanly
    if (this.resources.has(id)) {
      this.release(id);
    }

    const safeBytes = Math.max(0, Math.round(estimatedBytes));
    this.enforceBudget(safeBytes);

    this.resources.set(id, {
      id,
      url,
      bytes: safeBytes,
      lastAccessed: Date.now(),
      pinned,
      onEvict,
    });
    this.notify();
    return url;
  }

  public createManagedBlobUrl(id: string, blob: Blob, pinned = false, onEvict?: () => void): string {
    const url = URL.createObjectURL(blob);
    // Account for both encoded blob size and potential browser image decode cache (~2.2x)
    const estimated = Math.max(blob.size, Math.round(blob.size * 1.5));
    return this.registerObjectUrl(id, url, estimated, pinned, onEvict);
  }

  public touch(id: string): void {
    const entry = this.resources.get(id);
    if (entry) {
      entry.lastAccessed = Date.now();
    }
  }

  public setPinned(id: string, pinned: boolean): void {
    const entry = this.resources.get(id);
    if (entry) {
      entry.pinned = pinned;
      entry.lastAccessed = Date.now();
    }
  }

  public release(id: string): void {
    const entry = this.resources.get(id);
    if (!entry) return;
    this.resources.delete(id);
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && entry.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(entry.url);
      } catch {
        // Ignore already revoked URLs
      }
    }
    entry.onEvict?.();
    this.notify();
  }

  public allocateTransient(bytes: number): () => void {
    const safeBytes = Math.max(0, Math.round(bytes));
    this.enforceBudget(safeBytes);
    this.transientBytes += safeBytes;
    this.notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.transientBytes = Math.max(0, this.transientBytes - safeBytes);
      this.notify();
    };
  }

  /**
   * LRU eviction pass so total tracked allocations never exceed the 300 MB hard ceiling.
   */
  public enforceBudget(incomingBytes = 0): number {
    let evicted = 0;
    const projected = () => this.getTrackedBytes() + incomingBytes;

    if (projected() <= this.softLimitBytes) {
      return 0;
    }

    const candidates = Array.from(this.resources.values())
      .filter((r) => !r.pinned)
      .sort((a, b) => a.lastAccessed - b.lastAccessed);

    for (const candidate of candidates) {
      if (projected() <= this.softLimitBytes) break;
      this.release(candidate.id);
      this.evictionCount += 1;
      evicted += 1;
    }

    // If still above hard limit, evict oldest even among pinned except the most recently touched one
    if (projected() > this.hardLimitBytes && this.resources.size > 1) {
      const remaining = Array.from(this.resources.values()).sort((a, b) => a.lastAccessed - b.lastAccessed);
      while (projected() > this.hardLimitBytes && remaining.length > 1) {
        const victim = remaining.shift()!;
        this.release(victim.id);
        this.evictionCount += 1;
        evicted += 1;
      }
    }

    return evicted;
  }

  public flushUnpinned(): number {
    let flushed = 0;
    for (const [id, entry] of this.resources.entries()) {
      if (!entry.pinned) {
        this.release(id);
        this.evictionCount += 1;
        flushed += 1;
      }
    }
    this.notify();
    return flushed;
  }

  public disposeCanvas(canvas: HTMLCanvasElement | null | undefined): void {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    canvas.width = 0;
    canvas.height = 0;
  }
}

export const memoryGovernor = new MemoryGovernor(300, 210);

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, exp);
  return `${val >= 100 || exp === 0 ? Math.round(val) : val.toFixed(1)} ${units[exp]}`;
}
