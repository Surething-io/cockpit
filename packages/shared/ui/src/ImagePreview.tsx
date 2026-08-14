'use client';

import { useState } from 'react';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from './Portal';
import { toast } from './Toast';
import type { ImageInfo } from '@cockpit/shared-utils';

// Migrated from src/components/shared/ImagePreview.tsx.

interface ImagePreviewProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

function imageSrcToPngBlob(src: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas is unavailable'));
        return;
      }
      ctx.drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Could not encode image'));
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

// Image preview modal - rendered into body via Portal to avoid fixed positioning issues inside transform containers
function ImageModal({ image, onClose }: { image: ImageInfo; onClose: () => void }) {
  const { t } = useTranslation();

  const handleCopyImage = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Clipboard image write is unavailable');
      }
      const blob = await imageSrcToPngBlob(image.preview);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(t('imagePreview.copiedImage'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80"
      onClick={onClose}
    >
      <div className="absolute top-4 right-4 flex items-center gap-2">
        <button
          type="button"
          onClick={handleCopyImage}
          className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
          title={t('imagePreview.copyImage')}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2M7 7h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-10 h-10 flex items-center justify-center text-white/80 hover:text-white bg-black/40 hover:bg-black/60 rounded-full transition-colors"
          title={t('common.close')}
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <img
        src={image.preview}
        alt={t('imagePreview.previewImage')}
        className="max-w-[90vw] max-h-[90vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}

export function ImagePreview({ images, onRemove, disabled: _disabled }: ImagePreviewProps) {
  const { t } = useTranslation();
  const [previewImage, setPreviewImage] = useState<ImageInfo | null>(null);

  if (images.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 p-2 border-b border-border">
        {images.map((image) => (
          <div
            key={image.id}
            className="relative group w-16 h-16 rounded-lg overflow-hidden border border-border cursor-pointer"
            onClick={() => setPreviewImage(image)}
          >
            <img
              src={image.preview}
              alt={t('imagePreview.previewImage')}
              className="w-full h-full object-cover hover:opacity-90 transition-opacity"
            />
            <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(image.id);
                }}
                className="absolute top-0 right-0 w-5 h-5 bg-black/60 hover:bg-black/80 text-white text-xs flex items-center justify-center rounded-bl-lg opacity-0 group-hover:opacity-100 transition-opacity"
                title={t('imagePreview.deleteImage')}
              >
                ✕
              </button>
          </div>
        ))}
      </div>

      {/* Image preview modal */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </>
  );
}
