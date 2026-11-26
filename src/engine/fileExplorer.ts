/**
 * Direct OS File Explorer Bridge (File System Access API + Universal Fallback)
 * Enables opening local files, mounting entire local folders, and writing
 * processed outputs directly back to disk over HTTPS.
 */

export interface MountedDirectoryEntry {
  name: string;
  size: number;
  type: string;
  handle: FileSystemFileHandle;
}

export interface MountedDirectoryState {
  name: string;
  handle: FileSystemDirectoryHandle;
  entries: MountedDirectoryEntry[];
}

const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'svg', 'bmp', 'tif', 'tiff',
  'tga', 'ico', 'heic', 'heif', 'dng', 'cr2', 'nef', 'arw', 'pdf',
]);

export function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showOpenFilePicker' in window &&
    'showSaveFilePicker' in window &&
    'showDirectoryPicker' in window
  );
}

export async function pickFilesFromExplorer(): Promise<File[]> {
  if (typeof window !== 'undefined' && 'showOpenFilePicker' in window) {
    try {
      const picker = (window as unknown as {
        showOpenFilePicker: (opts: unknown) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker;
      const handles = await picker({
        multiple: true,
        types: [
          {
            description: 'Images, Vectors, RAW & PDFs',
            accept: {
              'image/*': ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.bmp', '.tiff', '.tif', '.tga', '.ico', '.heic', '.heif'],
              'application/pdf': ['.pdf'],
            },
          },
        ],
      });
      const files: File[] = [];
      for (const h of handles) {
        files.push(await h.getFile());
      }
      return files;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return [];
      }
      // Fall through to native file input (e.g. inside cross-origin iframe)
    }
  }

  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'image/*,.heic,.heif,.tga,.tif,.tiff,.dng,.cr2,.nef,.arw,.pdf,.svg';
    input.onchange = () => {
      resolve(input.files ? Array.from(input.files) : []);
    };
    input.click();
  });
}

export async function mountLocalDirectory(): Promise<MountedDirectoryState | null> {
  if (typeof window === 'undefined' || !('showDirectoryPicker' in window)) {
    return null;
  }

  try {
    const picker = (window as unknown as {
      showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    const dirHandle = await picker({ mode: 'readwrite' });
    const entries: MountedDirectoryEntry[] = [];

    const iterable = dirHandle as unknown as {
      values: () => AsyncIterable<FileSystemHandle>;
    };

    for await (const handle of iterable.values()) {
      if (handle.kind === 'file') {
        const ext = handle.name.split('.').pop()?.toLowerCase() ?? '';
        if (IMAGE_EXTENSIONS.has(ext)) {
          const fileHandle = handle as FileSystemFileHandle;
          const file = await fileHandle.getFile();
          entries.push({
            name: handle.name,
            size: file.size,
            type: file.type || `image/${ext}`,
            handle: fileHandle,
          });
        }
      }
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return {
      name: dirHandle.name,
      handle: dirHandle,
      entries,
    };
  } catch {
    return null;
  }
}

export async function saveBlobToDisk(blob: Blob, suggestedName: string): Promise<'explorer' | 'download' | 'cancelled'> {
  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const picker = (window as unknown as {
        showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker;
      const ext = suggestedName.includes('.') ? `.${suggestedName.split('.').pop()}` : '.png';
      const handle = await picker({
        suggestedName,
        types: [
          {
            description: 'Exported Asset',
            accept: { [blob.type || 'application/octet-stream']: [ext] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return 'explorer';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return 'cancelled';
      }
      // Fall back to standard download in restricted iframes
    }
  }

  triggerBrowserDownload(blob, suggestedName);
  return 'download';
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function writeBatchToDirectory(
  dirHandle: FileSystemDirectoryHandle,
  files: Array<{ name: string; blob: Blob }>
): Promise<number> {
  const outDir = await dirHandle.getDirectoryHandle('chromaforge-exports', { create: true });
  let written = 0;
  for (const item of files) {
    const fileHandle = await outDir.getFileHandle(item.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(item.blob);
    await writable.close();
    written += 1;
  }
  return written;
}

export async function copyBlobToClipboard(blob: Blob): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard || typeof ClipboardItem === 'undefined') {
    return false;
  }
  try {
    // Clipboard API universally requires image/png
    let pngBlob = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(bmp, 0, 0);
      bmp.close();
      pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png');
      });
      canvas.width = 0;
      canvas.height = 0;
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    return true;
  } catch {
    return false;
  }
}
