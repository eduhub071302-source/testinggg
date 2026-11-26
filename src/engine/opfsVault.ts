import { OpfsFileEntry, SavedPreset } from '../types/studio';

/**
 * Direct Origin Private File System (OPFS) Vault
 * Stores full-resolution source images, history revisions, presets, and batch exports on disk
 * so tab RAM stays safely under 300 MB. Falls back gracefully to IndexedDB or ephemeral memory
 * if OPFS is restricted by browser policy.
 */

type StorageBackend = 'opfs' | 'indexeddb' | 'memory';

const IDB_NAME = 'chromaforge_opfs_fallback';
const IDB_STORE = 'files';

class OpfsVault {
  private backend: StorageBackend = 'memory';
  private rootDir: FileSystemDirectoryHandle | null = null;
  private idbPromise: Promise<IDBDatabase> | null = null;
  private memoryMap = new Map<string, { blob: Blob; lastModified: number }>();
  private initPromise: Promise<void> | null = null;

  public async init(): Promise<StorageBackend> {
    if (!this.initPromise) {
      this.initPromise = this.detectAndInit();
    }
    await this.initPromise;
    return this.backend;
  }

  public getBackend(): StorageBackend {
    return this.backend;
  }

  private async detectAndInit(): Promise<void> {
    // 1. Try native OPFS first (direct high-throughput browser disk storage)
    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        const root = await navigator.storage.getDirectory();
        const appDir = await root.getDirectoryHandle('chromaforge', { create: true });
        await appDir.getDirectoryHandle('assets', { create: true });
        await appDir.getDirectoryHandle('history', { create: true });
        await appDir.getDirectoryHandle('presets', { create: true });
        this.rootDir = appDir;
        this.backend = 'opfs';
        return;
      }
    } catch {
      // Fall through to IndexedDB
    }

    // 2. Try IndexedDB fallback
    try {
      if (typeof indexedDB !== 'undefined') {
        await this.openIdb();
        this.backend = 'indexeddb';
        return;
      }
    } catch {
      // Fall through to memory
    }

    this.backend = 'memory';
  }

  private openIdb(): Promise<IDBDatabase> {
    if (!this.idbPromise) {
      this.idbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'path' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.idbPromise;
  }

  private normalizePath(path: string): { folder: string; name: string; full: string } {
    const clean = path.replace(/^\/+/, '');
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 1) {
      return { folder: 'assets', name: parts[0], full: `assets/${parts[0]}` };
    }
    const name = parts.pop()!;
    const folder = parts[0] || 'assets';
    return { folder, name, full: `${folder}/${name}` };
  }

  public async writeBlob(path: string, blob: Blob): Promise<string> {
    await this.init();
    const { folder, name, full } = this.normalizePath(path);

    if (this.backend === 'opfs' && this.rootDir) {
      try {
        const dir = await this.rootDir.getDirectoryHandle(folder, { create: true });
        const fileHandle = await dir.getFileHandle(name, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return full;
      } catch {
        // Fallback silently to memory map if a particular browser blocks createWritable in iframe
        this.memoryMap.set(full, { blob, lastModified: Date.now() });
        return full;
      }
    }

    if (this.backend === 'indexeddb') {
      const db = await this.openIdb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).put({ path: full, folder, name, blob, lastModified: Date.now() });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return full;
    }

    this.memoryMap.set(full, { blob, lastModified: Date.now() });
    return full;
  }

  public async readBlob(path: string): Promise<Blob | null> {
    await this.init();
    const { folder, name, full } = this.normalizePath(path);

    if (this.memoryMap.has(full)) {
      return this.memoryMap.get(full)!.blob;
    }

    if (this.backend === 'opfs' && this.rootDir) {
      try {
        const dir = await this.rootDir.getDirectoryHandle(folder);
        const fileHandle = await dir.getFileHandle(name);
        return await fileHandle.getFile();
      } catch {
        return null;
      }
    }

    if (this.backend === 'indexeddb') {
      const db = await this.openIdb();
      return await new Promise<Blob | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(full);
        req.onsuccess = () => resolve(req.result ? (req.result.blob as Blob) : null);
        req.onerror = () => reject(req.error);
      });
    }

    return null;
  }

  public async deleteFile(path: string): Promise<void> {
    await this.init();
    const { folder, name, full } = this.normalizePath(path);
    this.memoryMap.delete(full);

    if (this.backend === 'opfs' && this.rootDir) {
      try {
        const dir = await this.rootDir.getDirectoryHandle(folder);
        await dir.removeEntry(name);
      } catch {
        // Ignore missing entries
      }
      return;
    }

    if (this.backend === 'indexeddb') {
      const db = await this.openIdb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(full);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  public async listFiles(): Promise<OpfsFileEntry[]> {
    await this.init();
    const entries: OpfsFileEntry[] = [];
    const seen = new Set<string>();

    if (this.backend === 'opfs' && this.rootDir) {
      const folders = ['assets', 'history', 'presets'];
      for (const folder of folders) {
        try {
          const dir = await this.rootDir.getDirectoryHandle(folder);
          const iterable = dir as unknown as {
            values: () => AsyncIterable<FileSystemHandle>;
          };
          for await (const handle of iterable.values()) {
            if (handle.kind === 'file') {
              const file = await (handle as FileSystemFileHandle).getFile();
              const full = `${folder}/${handle.name}`;
              seen.add(full);
              entries.push({
                path: full,
                folder,
                name: handle.name,
                size: file.size,
                lastModified: file.lastModified,
              });
            }
          }
        } catch {
          // Folder may not exist yet
        }
      }
    } else if (this.backend === 'indexeddb') {
      const db = await this.openIdb();
      const rows = await new Promise<Array<{ path: string; folder: string; name: string; blob: Blob; lastModified: number }>>(
        (resolve, reject) => {
          const tx = db.transaction(IDB_STORE, 'readonly');
          const req = tx.objectStore(IDB_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        }
      );
      for (const row of rows) {
        seen.add(row.path);
        entries.push({
          path: row.path,
          folder: row.folder,
          name: row.name,
          size: row.blob.size,
          lastModified: row.lastModified,
        });
      }
    }

    for (const [full, item] of this.memoryMap.entries()) {
      if (seen.has(full)) continue;
      const [folder, ...rest] = full.split('/');
      entries.push({
        path: full,
        folder,
        name: rest.join('/'),
        size: item.blob.size,
        lastModified: item.lastModified,
      });
    }

    return entries.sort((a, b) => b.lastModified - a.lastModified);
  }

  public async getStorageEstimate(): Promise<{ used: number; quota: number }> {
    const files = await this.listFiles();
    const vaultUsed = files.reduce((acc, f) => acc + f.size, 0);

    try {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        const est = await navigator.storage.estimate();
        return {
          used: Math.max(vaultUsed, est.usage ?? 0),
          quota: est.quota ?? 1024 * 1024 * 1024,
        };
      }
    } catch {
      // Ignore
    }

    return { used: vaultUsed, quota: 1024 * 1024 * 1024 };
  }

  public async purgeFolder(folder: 'assets' | 'history' | 'presets'): Promise<number> {
    const files = await this.listFiles();
    let count = 0;
    for (const file of files) {
      if (file.folder === folder) {
        await this.deleteFile(file.path);
        count += 1;
      }
    }
    return count;
  }

  public async savePresets(presets: SavedPreset[]): Promise<void> {
    const blob = new Blob([JSON.stringify(presets, null, 2)], { type: 'application/json' });
    await this.writeBlob('presets/user-presets.json', blob);
    try {
      localStorage.setItem('chromaforge_presets_v1', JSON.stringify(presets));
    } catch {
      // Ignore storage errors
    }
  }

  public async loadPresets(): Promise<SavedPreset[]> {
    try {
      const blob = await this.readBlob('presets/user-presets.json');
      if (blob) {
        const text = await blob.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed as SavedPreset[];
      }
    } catch {
      // Try localStorage fallback
    }
    try {
      const raw = localStorage.getItem('chromaforge_presets_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as SavedPreset[];
      }
    } catch {
      // Ignore
    }
    return [];
  }
}

export const opfsVault = new OpfsVault();
