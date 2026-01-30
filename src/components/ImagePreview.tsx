'use client';

import { ImageInfo } from '@/types/chat';

interface ImagePreviewProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export function ImagePreview({ images, onRemove, disabled }: ImagePreviewProps) {
  if (images.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 p-2 bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
      {images.map((image) => (
        <div
          key={image.id}
          className="relative group w-16 h-16 rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600"
        >
          <img
            src={image.preview}
            alt="预览图片"
            className="w-full h-full object-cover"
          />
          {!disabled && (
            <button
              onClick={() => onRemove(image.id)}
              className="absolute top-0 right-0 w-5 h-5 bg-black/60 hover:bg-black/80 text-white text-xs flex items-center justify-center rounded-bl-lg opacity-0 group-hover:opacity-100 transition-opacity"
              title="删除图片"
            >
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
