'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ImageInfo } from '@/types/chat';

interface ImagePreviewProps {
  images: ImageInfo[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}

// 图片预览模态框 - 使用 Portal 渲染到 body，避免 transform 容器影响 fixed 定位
function ImageModal({ image, onClose }: { image: ImageInfo; onClose: () => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div className="relative max-w-[90vw] max-h-[90vh]">
        <img
          src={image.preview}
          alt="预览图片"
          className="max-w-full max-h-[90vh] object-contain rounded-lg"
          onClick={(e) => e.stopPropagation()}
        />
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 w-8 h-8 bg-card text-foreground hover:text-foreground rounded-full shadow-lg flex items-center justify-center transition-colors"
          title="关闭"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );

  // 客户端渲染时使用 Portal 到 body
  if (mounted) {
    return createPortal(modalContent, document.body);
  }

  return null;
}

export function ImagePreview({ images, onRemove, disabled }: ImagePreviewProps) {
  const [previewImage, setPreviewImage] = useState<ImageInfo | null>(null);

  if (images.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 p-2 bg-secondary border-b border-border">
        {images.map((image) => (
          <div
            key={image.id}
            className="relative group w-16 h-16 rounded-lg overflow-hidden border border-border cursor-pointer"
            onClick={() => setPreviewImage(image)}
          >
            <img
              src={image.preview}
              alt="预览图片"
              className="w-full h-full object-cover hover:opacity-90 transition-opacity"
            />
            {!disabled && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(image.id);
                }}
                className="absolute top-0 right-0 w-5 h-5 bg-black/60 hover:bg-black/80 text-white text-xs flex items-center justify-center rounded-bl-lg opacity-0 group-hover:opacity-100 transition-opacity"
                title="删除图片"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {/* 图片预览模态框 */}
      {previewImage && (
        <ImageModal image={previewImage} onClose={() => setPreviewImage(null)} />
      )}
    </>
  );
}
