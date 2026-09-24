export type AssetCategory =
  | "audio"
  | "texture"
  | "shader"
  | "script"
  | "model"
  | "other";
export type AssetPreviewKind = "audio" | "image" | "model" | "text" | "none";
export type AssetFileRole =
  | "source"
  | "model"
  | "texture"
  | "animation"
  | "audio"
  | "preview"
  | "document"
  | "other";

export interface AssetFileRecord {
  id: string;
  assetId: string;
  role: AssetFileRole;
  variant: string;
  originalName: string;
  storedName: string;
  fileType: string;
  hash?: string;
  mimeType: string;
  size: number;
  category: AssetCategory;
  previewKind: AssetPreviewKind;
  width?: number;
  height?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AssetFileView extends AssetFileRecord {
  fileUrl: string;
  downloadUrl: string;
  textPreviewUrl: string;
}

export interface AssetRelation {
  parentAssetId: string;
  childAssetId: string;
  relationType: "contains" | "variant" | "derived-from";
}

export interface AssetRecord {
  id: string;
  title: string;
  description: string;
  tags: string[];
  licenses: string[];
  sourceUrl: string;
  metadataEdited: boolean;
  uploadDate: string;
  originalName: string;
  storedName: string;
  fileType: string;
  hash?: string;
  mimeType: string;
  size: number;
  category: AssetCategory;
  previewKind: AssetPreviewKind;
  width?: number;
  height?: number;
  files: AssetFileRecord[];
}

export interface AssetView extends AssetRecord {
  fileUrl: string;
  downloadUrl: string;
  textPreviewUrl: string;
  files: AssetFileView[];
}
