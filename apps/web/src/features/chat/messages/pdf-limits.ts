/** Bounds for one on-demand PDF reader; the original download is always available. */
export const PDF_LIMITS = {
  bytes: 10 * 1024 * 1024,
  imagePixels: 16_000_000,
  canvasPixels: 8_000_000,
  canvasSide: 8192,
  pageSide: 32768,
  zoomMax: 4,
  pages: 1000,
  textChars: 64_000,
  textItems: 5000,
  deadlineMs: 15_000,
} as const;

export class PdfPreviewError extends Error {
  readonly kind: 'limits' | 'timeout' | 'unreadable' | 'cancelled';
  constructor(kind: 'limits' | 'timeout' | 'unreadable' | 'cancelled') {
    super(`PDF preview ${kind}`);
    this.kind = kind;
    this.name = 'PdfPreviewError';
  }
}

export interface PageGeometry {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly ratio: number;
  readonly pixelsWide: number;
  readonly pixelsHigh: number;
}

/** The CSS page and backing canvas have the same aspect ratio; device pixels are clamped first. */
export const pageGeometry = (
  pageWidth: number,
  pageHeight: number,
  available: number,
  zoom: number,
  deviceRatio: number,
): PageGeometry => {
  if (
    ![pageWidth, pageHeight, available, zoom, deviceRatio].every(Number.isFinite) ||
    pageWidth <= 0 ||
    pageHeight <= 0 ||
    available <= 0 ||
    zoom < 1 ||
    zoom > PDF_LIMITS.zoomMax ||
    deviceRatio <= 0
  ) {
    throw new PdfPreviewError('limits');
  }
  const scale = (available / pageWidth) * zoom;
  const width = pageWidth * scale;
  const height = pageHeight * scale;
  if (width > PDF_LIMITS.pageSide || height > PDF_LIMITS.pageSide)
    throw new PdfPreviewError('limits');
  const ratio = Math.min(
    deviceRatio,
    2,
    Math.sqrt(PDF_LIMITS.canvasPixels / (width * height)),
    PDF_LIMITS.canvasSide / width,
    PDF_LIMITS.canvasSide / height,
  );
  return {
    width,
    height,
    scale,
    ratio,
    pixelsWide: Math.max(1, Math.floor(width * ratio)),
    pixelsHigh: Math.max(1, Math.floor(height * ratio)),
  };
};
