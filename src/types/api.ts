// TypeScript types mirroring the OpenAPI spec at /openapi.json.
// All types are intentionally explicit (no `any`) so consumers get full IntelliSense.

export interface BoundingBox {
  /** 4 corner points in document pixel space: [[x1,y1], [x2,y2], [x3,y3], [x4,y4]] */
  points: [number, number][];
  /** Detection confidence, 0..1 */
  confidence: number;
}

export interface TextLine {
  bbox: BoundingBox;
  text: string;
  confidence: number;
  khmer_text?: string | null;
  english_text?: string | null;
}

export interface LayoutRegion {
  bbox: BoundingBox;
  region_type: string;
  lines: TextLine[];
  text: string;
  confidence: number;
  khmer_text?: string | null;
  english_text?: string | null;
  /** Base64 PNG crop for non-text visual regions */
  crop_base64?: string | null;
}

export interface PageResult {
  page_number: number;
  width: number;
  height: number;
  regions: LayoutRegion[];
}

export interface VisualRegionCrop {
  page_number: number;
  region_type: string;
  bbox: BoundingBox;
  confidence: number;
  crop_base64: string;
}

export interface DocumentResult {
  filename: string;
  num_pages: number;
  pages: PageResult[];
  full_text?: string | null;
  translated_text?: string | null;
  table_crops?: VisualRegionCrop[];
  figure_crops?: VisualRegionCrop[];
  image_crops?: VisualRegionCrop[];
}

export interface TableCell {
  row: number;
  col: number;
  text: string;
  bbox: BoundingBox;
  confidence: number;
}

export interface TableResult {
  filename: string;
  num_rows: number;
  num_cols: number;
  cells: TableCell[];
  structured_text: string;
  width: number;
  height: number;
  debug_image?: string | null;
}

export interface HealthCheckResponse {
  status: string;
  models_loaded: boolean;
  message?: string | null;
}

export interface OcrImageResponse {
  text: string;
  confidence: number;
  filename?: string;
  decoder?: string;
  [key: string]: unknown;
}

/** Normalize ocr-image response — API may return plain string OR full object. */
export function normalizeOcrResponse(raw: unknown): OcrImageResponse {
  if (typeof raw === 'string') {
    return { text: raw, confidence: 0 };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      text: typeof obj.text === 'string' ? obj.text : '',
      confidence: typeof obj.confidence === 'number' ? obj.confidence : 0,
      filename: typeof obj.filename === 'string' ? obj.filename : undefined,
      decoder: typeof obj.decoder === 'string' ? obj.decoder : undefined,
    };
  }
  return { text: '', confidence: 0 };
}
