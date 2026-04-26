'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../shared/Portal';
import { DiffView, DiffUnifiedView } from './DiffView';
import { CodeViewer } from './CodeViewer';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { TocSidebar } from '../shared/TocSidebar';
import { rehypeSourceLines } from '@/lib/rehypeSourceLines';
import { toast } from '../shared/Toast';
import { useJsonSearch, JsonSearchBar } from '../../hooks/useJsonSearch';
import { FileImagePreview } from './fileBrowser/FileImagePreview';
import {
  isValidJson,
  formatAsJson,
  formatAsHumanReadable,
  isEditInput,
  getFilePath,
  isImageFile,
  isMarkdownFile,
} from './toolCallUtils';

// ============================================
// FilePreview - File preview component
// ============================================

interface FilePreviewProps {
  filePath: string;
}

function FilePreview({ filePath }: FilePreviewProps) {
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fetchingRef = useRef(false);

  const isMd = isMarkdownFile(filePath);
  const isImage = isImageFile(filePath);

  useEffect(() => {
    // Image files do not need text content loading
    if (isImage) {
      setIsLoading(false);
      return;
    }
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const loadFile = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/file?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.statusText}`);
        }
        const data = await response.json();
        setFileContent(data.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setIsLoading(false);
        fetchingRef.current = false;
      }
    };
    loadFile();
  }, [filePath, isImage]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-xs text-red-11">{error}</div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">Loading...</span>
      </div>
    );
  }

  // Image file: shared component, same cache/etag semantics as the file browser.
  if (isImageFile(filePath)) {
    return (
      <FileImagePreview
        absPath={filePath}
        className="flex items-center justify-center h-full overflow-auto"
        imgClassName="max-w-full max-h-full object-contain"
        alt={filePath.split('/').pop() || 'image'}
      />
    );
  }

  if (!fileContent) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-sm text-muted-foreground">No content</span>
      </div>
    );
  }

  if (isMd) {
    return <FilePreviewMarkdown content={fileContent} />;
  }

  return (
    <CodeViewer
      content={fileContent}
      filePath={filePath}
      showLineNumbers={true}
      showSearch={true}
      className="h-full"
    />
  );
}

// ============================================
// FilePreviewMarkdown - Markdown preview (with TOC sidebar)
// ============================================

const REHYPE_PLUGINS = [rehypeSourceLines];

function FilePreviewMarkdown({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div className="h-full flex">
      <TocSidebar content={content} containerRef={containerRef} />
      <div ref={containerRef} className="flex-1 overflow-auto p-4">
        <MarkdownRenderer content={content} rehypePlugins={REHYPE_PLUGINS} />
      </div>
    </div>
  );
}

// ============================================
// PreviewModal - Preview modal window component
// ============================================

export type ViewMode = 'readable' | 'json' | 'diff-unified' | 'diff-split' | 'file';

interface PreviewModalProps {
  title: string;
  content: string;
  toolName?: string;
  onClose: () => void;
}

export function PreviewModal({ title, content, toolName, onClose }: PreviewModalProps) {
  const { t } = useTranslation();
  const isJson = isValidJson(content);
  const editInput = isEditInput(content);
  const filePath = getFilePath(content);
  const hasDiffMode = !!editInput;
  const hasFileMode = !!filePath;

  const getDefaultMode = (): ViewMode => {
    if ((toolName === 'Read' || toolName === 'Write') && hasFileMode) return 'file';
    if (hasDiffMode) return 'diff-unified';
    if (isJson) return 'readable';
    return 'json';
  };

  const [viewMode, setViewMode] = useState<ViewMode>(getDefaultMode());
  const previewPreRef = useRef<HTMLPreElement>(null);
  const jsonSearch = useJsonSearch(previewPreRef);

  // ESC / Cmd+F keyboard handling
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f' && viewMode === 'readable' && isJson) {
        e.preventDefault();
        jsonSearch.open();
        return;
      }
      if (e.key === 'Escape') {
        if (jsonSearch.isVisible) {
          jsonSearch.close();
          return;
        }
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, viewMode, isJson, jsonSearch]);

  const renderContent = () => {
    if (viewMode === 'file' && filePath) {
      return <FilePreview filePath={filePath} />;
    }
    if (viewMode === 'diff-unified' && editInput) {
      return <DiffUnifiedView oldContent={editInput.old_string} newContent={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'diff-split' && editInput) {
      return <DiffView oldContent={editInput.old_string} newContent={editInput.new_string} filePath={editInput.file_path} />;
    }
    if (viewMode === 'readable' && isJson) {
      return (
        <>
          <JsonSearchBar search={jsonSearch} />
          <pre ref={previewPreRef} className="text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
            {formatAsHumanReadable(content)}
          </pre>
        </>
      );
    }
    return (
      <pre className="text-foreground whitespace-pre-wrap break-words" style={{ fontSize: '0.8125rem' }}>
        {isJson ? formatAsJson(content) : content}
      </pre>
    );
  };

  const modalWidth = viewMode === 'diff-split' ? 'max-w-[90%]' : 'max-w-[90%]';

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className={`bg-card rounded-lg shadow-xl w-full ${modalWidth} h-[90vh] flex flex-col transition-all`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">{title}</h3>
            {filePath && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(filePath);
                  toast(t('common.copiedPath'));
                }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t('common.copyAbsPath')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            {isJson && (
              <div className="flex items-center gap-1 bg-accent rounded p-0.5">
                {hasDiffMode && (
                  <>
                    <button
                      onClick={() => setViewMode('diff-split')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-split'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title={t('diffViewer.sideBySide')}
                    >
                      Split
                    </button>
                    <button
                      onClick={() => setViewMode('diff-unified')}
                      className={`px-2 py-1 text-xs rounded transition-colors ${
                        viewMode === 'diff-unified'
                          ? 'bg-card text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      title={t('diffViewer.unified')}
                    >
                      Unified
                    </button>
                  </>
                )}
                {hasFileMode && (
                  <button
                    onClick={() => setViewMode('file')}
                    className={`px-2 py-1 text-xs rounded transition-colors ${
                      viewMode === 'file'
                        ? 'bg-card text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    title={t('diffViewer.previewFile')}
                  >
                    File
                  </button>
                )}
                <button
                  onClick={() => setViewMode('readable')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'readable'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t('common.readable')}
                </button>
                <button
                  onClick={() => setViewMode('json')}
                  className={`px-2 py-1 text-xs rounded transition-colors ${
                    viewMode === 'json'
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  JSON
                </button>
              </div>
            )}
            <button
              onClick={onClose}
              className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {renderContent()}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
