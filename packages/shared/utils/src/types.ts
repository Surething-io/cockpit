// Cross-feature type definitions.
//
// These live here (not in shared-ui or feature-agent) because they describe
// data shapes used across multiple packages — currently both
// @cockpit/feature-agent (chat messages with attachments) and
// @cockpit/shared-ui (the generic ImagePreview component).

// ============================================
// Image types
// ============================================

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

// Image info (frontend state management)
export interface ImageInfo {
  id: string;           // Unique identifier
  data: string;         // base64 data (without prefix)
  preview: string;      // Full data URL (for preview)
  media_type: ImageMediaType;
}

// Images embedded in messages (for history and API)
export interface MessageImage {
  type: 'base64';
  media_type: ImageMediaType;
  data: string;
}
