'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import Editor, { OnMount, OnChange } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { useTheme } from './ThemeProvider';
import { toast } from './Toast';

interface FileEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  initialContent: string;
  cwd: string;
  onSaved?: () => void;
}

// Map file extensions to Monaco language identifiers
function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const languageMap: Record<string, string> = {
    // JavaScript/TypeScript
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'mjs': 'javascript',
    'cjs': 'javascript',
    // Web
    'html': 'html',
    'htm': 'html',
    'css': 'css',
    'scss': 'scss',
    'sass': 'scss',
    'less': 'less',
    // Data formats
    'json': 'json',
    'jsonc': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'ini',
    // Markdown
    'md': 'markdown',
    'mdx': 'markdown',
    // Shell
    'sh': 'shell',
    'bash': 'shell',
    'zsh': 'shell',
    'fish': 'shell',
    // Python
    'py': 'python',
    'pyw': 'python',
    // Ruby
    'rb': 'ruby',
    'erb': 'html',
    // Go
    'go': 'go',
    // Rust
    'rs': 'rust',
    // C/C++
    'c': 'c',
    'h': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'hpp': 'cpp',
    'hxx': 'cpp',
    // Java
    'java': 'java',
    // Kotlin
    'kt': 'kotlin',
    'kts': 'kotlin',
    // Swift
    'swift': 'swift',
    // PHP
    'php': 'php',
    // SQL
    'sql': 'sql',
    // GraphQL
    'graphql': 'graphql',
    'gql': 'graphql',
    // Docker
    'dockerfile': 'dockerfile',
    // Config files
    'env': 'ini',
    'ini': 'ini',
    'conf': 'ini',
    'cfg': 'ini',
    // Misc
    'txt': 'plaintext',
    'log': 'plaintext',
    'gitignore': 'ini',
    'gitattributes': 'ini',
  };

  // Handle special filenames
  const filename = filePath.split('/').pop()?.toLowerCase() || '';
  if (filename === 'dockerfile') return 'dockerfile';
  if (filename === 'makefile') return 'makefile';
  if (filename === '.gitignore' || filename === '.gitattributes') return 'ini';
  if (filename === '.env' || filename.startsWith('.env.')) return 'ini';

  return languageMap[ext] || 'plaintext';
}

export function FileEditorModal({
  isOpen,
  onClose,
  filePath,
  initialContent,
  cwd,
  onSaved,
}: FileEditorModalProps) {
  const { resolvedTheme } = useTheme();
  const [content, setContent] = useState(initialContent);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // Reset state when modal opens with new content
  useEffect(() => {
    if (isOpen) {
      setContent(initialContent);
      setIsDirty(false);
    }
  }, [isOpen, initialContent]);

  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    // Focus editor when mounted
    editor.focus();
  }, []);

  const handleEditorChange: OnChange = useCallback((value) => {
    const newContent = value || '';
    setContent(newContent);
    setIsDirty(newContent !== initialContent);
  }, [initialContent]);

  const handleSave = useCallback(async () => {
    if (!isDirty || isSaving) return;

    setIsSaving(true);
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, path: filePath, content }),
      });

      if (!response.ok) {
        throw new Error('Failed to save file');
      }

      setIsDirty(false);
      toast('已保存', 'success');
      onSaved?.();
    } catch (error) {
      console.error('Error saving file:', error);
      toast('保存失败', 'error');
    } finally {
      setIsSaving(false);
    }
  }, [cwd, filePath, content, isDirty, isSaving, onSaved]);

  // Keyboard shortcut: Cmd/Ctrl + S to save
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleSave]);

  if (!isOpen) return null;

  const language = getLanguageFromPath(filePath);
  const fileName = filePath.split('/').pop() || filePath;

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-[90%] h-[90%] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground truncate">
              {fileName}
              {isDirty && <span className="text-amber-11 ml-1">*</span>}
            </span>
            <span className="text-xs text-muted-foreground truncate">
              {filePath}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!isDirty || isSaving}
              className={`px-3 py-1.5 text-sm rounded transition-colors ${
                isDirty && !isSaving
                  ? 'bg-brand text-white hover:bg-brand/90'
                  : 'bg-secondary text-muted-foreground cursor-not-allowed'
              }`}
            >
              {isSaving ? (
                <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
              ) : (
                '保存'
              )}
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title="关闭 (ESC)"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 overflow-hidden">
          <Editor
            height="100%"
            language={language}
            value={content}
            theme={resolvedTheme === 'dark' ? 'vs-dark' : 'light'}
            onMount={handleEditorMount}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: true },
              fontSize: 13,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              wordWrap: 'on',
              renderWhitespace: 'selection',
              bracketPairColorization: { enabled: true },
              padding: { top: 8, bottom: 8 },
            }}
          />
        </div>
      </div>
    </div>
  );
}
