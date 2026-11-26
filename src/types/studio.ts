export type WorkspaceTab = 'editor' | 'pipeline' | 'batch' | 'storage';

export type ToolCategoryId =
  | 'compression'
  | 'conversion'
  | 'geometry'
  | 'layout'
  | 'color'
  | 'annotation'
  | 'ecommerce'
  | 'developer'
  | 'workflow';

export type ToolId =
  // 1-8 Compression & Optimization
  | 'target-size'
  | 'quality-slider'
  | 'png-quantize'
  | 'progressive-jpeg'
  | 'chroma-subsampling'
  | 'animated-compress'
  | 'metadata-strip'
  | 'bulk-zip'
  // 9-20 Format Conversion
  | 'heic-convert'
  | 'webp-to-standard'
  | 'standard-to-webp'
  | 'avif-convert'
  | 'png-to-jpg-fill'
  | 'svg-to-png'
  | 'ico-convert'
  | 'gif-to-animated'
  | 'images-to-pdf'
  | 'pdf-to-images'
  | 'legacy-to-web'
  | 'raw-exporter'
  // 21-31 Cropping, Resizing & Geometry
  | 'exact-resize'
  | 'percent-mp-scale'
  | 'canvas-fit-pad'
  | 'social-presets'
  | 'passport-id'
  | 'id-sheet-tiler'
  | 'shape-cropper'
  | 'rotate-straighten'
  | 'flip-mirror'
  | 'perspective-deskew'
  | 'auto-trim'
  // 32-39 Merging, Splitting & Layout
  | 'image-merger'
  | 'grid-collage'
  | 'long-stitcher'
  | 'grid-splitter'
  | 'overlay-blend'
  | 'mockup-wrapper'
  | 'before-after-gen'
  | 'contact-sheet'
  // 40-48 Color, Tone & Basic Editing
  | 'core-exposure'
  | 'color-vibrance'
  | 'bw-grayscale'
  | 'sharpen-unsharp'
  | 'blur-motion'
  | 'color-invert'
  | 'chroma-key'
  | 'srgb-standardize'
  | 'dither-retro'
  // 49-56 Annotation, Watermarking & Privacy
  | 'screenshot-annotate'
  | 'text-overlay'
  | 'logo-watermark'
  | 'tiled-watermark'
  | 'region-redact'
  | 'exif-viewer'
  | 'exif-scrubber'
  | 'exif-editor'
  // 57-62 E-Commerce & Catalog Utilities
  | 'canvas-squaring'
  | 'marketplace-presets'
  | 'promo-badge'
  | 'multi-size-export'
  | 'bulk-renamer'
  | 'variant-grid'
  // 63-74 Developer & Web Asset Tools
  | 'responsive-srcset'
  | 'favicon-pwa'
  | 'svg-minifier'
  | 'svg-to-jsx'
  | 'base64-codec'
  | 'sprite-packer'
  | 'sprite-slicer'
  | 'lqip-blurhash'
  | 'visual-diff'
  | 'palette-extractor'
  | 'dpi-changer'
  | 'ascii-art'
  // 75-80 Batch Workflow & UX Essentials
  | 'pipeline-chain'
  | 'saved-presets'
  | 'local-privacy'
  | 'clipboard-io'
  | 'history-manager'
  | 'clean-export';

export interface ToolDefinition {
  id: ToolId;
  number: number;
  name: string;
  shortName: string;
  category: ToolCategoryId;
  description: string;
  keywords: string[];
  supportsBatch: boolean;
  interactiveMode?: 'split' | 'annotate' | 'redact' | 'perspective' | 'passport' | 'diff' | 'none';
}

export interface StudioAsset {
  id: string;
  name: string;
  mimeType: string;
  width: number;
  height: number;
  originalBytes: number;
  currentBytes: number;
  opfsOriginalPath: string;
  opfsCurrentPath: string;
  previewUrl: string;
  originalPreviewUrl: string;
  createdAt: number;
  source: 'sample' | 'upload' | 'explorer' | 'clipboard' | 'generated';
  dpi?: number;
  historyIds: string[];
  historyIndex: number;
}

export interface PipelineStep {
  id: string;
  toolId: ToolId;
  label: string;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface SavedPreset {
  id: string;
  name: string;
  createdAt: number;
  steps: PipelineStep[];
}

export interface AnnotationShape {
  id: string;
  kind: 'arrow' | 'rect' | 'circle' | 'highlight' | 'step';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  strokeWidth: number;
  stepNumber?: number;
  points?: Array<{ x: number; y: number }>;
}

export interface RedactionBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  mode: 'blur' | 'pixelate' | 'blackout';
  strength: number;
}

export interface PerspectiveQuad {
  tl: { x: number; y: number };
  tr: { x: number; y: number };
  br: { x: number; y: number };
  bl: { x: number; y: number };
}

export interface ExifMetadata {
  make?: string;
  model?: string;
  lens?: string;
  software?: string;
  dateTime?: string;
  exposureTime?: string;
  fNumber?: string;
  iso?: string;
  focalLength?: string;
  width?: number;
  height?: number;
  gpsLat?: string;
  gpsLng?: string;
  copyright?: string;
  artist?: string;
  description?: string;
  dpiX?: number;
  dpiY?: number;
  colorSpace?: string;
  rawSegments: string[];
}

export interface PaletteColor {
  hex: string;
  rgb: string;
  hsl: string;
  percent: number;
}

export interface MemoryStats {
  trackedBytes: number;
  limitBytes: number;
  softLimitBytes: number;
  activeObjectUrls: number;
  evictionCount: number;
  jsHeapUsedBytes: number | null;
  opfsUsedBytes: number;
  opfsQuotaBytes: number;
  storageBackend: 'opfs' | 'indexeddb' | 'memory';
}

export interface OpfsFileEntry {
  path: string;
  folder: string;
  name: string;
  size: number;
  lastModified: number;
}

export interface BatchExportFile {
  name: string;
  blob: Blob;
  width?: number;
  height?: number;
}
