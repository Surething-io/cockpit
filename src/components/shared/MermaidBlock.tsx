'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTheme } from './ThemeProvider';
import { useTranslation } from 'react-i18next';

// Mermaid lazy-load + singleton
let mermaidInstance: typeof import('mermaid').default | null = null;
let mermaidLoading: Promise<typeof import('mermaid').default> | null = null;

async function getMermaid() {
  if (mermaidInstance) return mermaidInstance;
  if (!mermaidLoading) {
    mermaidLoading = import('mermaid').then(m => {
      mermaidInstance = m.default;
      return mermaidInstance;
    });
  }
  return mermaidLoading;
}

// ============================================
// MermaidBlock - mermaid rendering component inside a bubble
// ============================================

interface MermaidBlockProps {
  code: string;
  isDark: boolean;
}

export function MermaidBlock({ code, isDark }: MermaidBlockProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'diagram' | 'code'>('diagram');
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const renderCountRef = useRef(0);

  // Render mermaid
  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${Math.random().toString(36).slice(2, 9)}-${++renderCountRef.current}`;

    async function render() {
      try {
        const mermaid = await getMermaid();
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'loose',
        });
        const { svg } = await mermaid.render(renderId, code);
        if (!cancelled) {
          setSvgHtml(svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvgHtml(null);
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [code, isDark]);

  return (
    <>
      <div className="my-3 rounded-lg border border-border overflow-hidden">
        {/* Tab bar */}
        <div className="flex items-center justify-end gap-1 px-3 py-1.5 border-b border-border">
          <TabButton active={tab === 'diagram'} onClick={() => setTab('diagram')}>
            <span className="text-xs">📊</span> {t('mermaid.chart')}
          </TabButton>
          <TabButton active={tab === 'code'} onClick={() => setTab('code')}>
            <span className="text-xs opacity-70">&lt;/&gt;</span> {t('mermaid.code')}
          </TabButton>
        </div>

        {/* Content area */}
        {tab === 'diagram' ? (
          <div className="p-4">
            {error ? (
              <div className="flex items-start gap-2 p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                <span className="flex-shrink-0 mt-0.5">⚠️</span>
                <div>
                  <div className="font-medium mb-1">{t('mermaid.renderFailed')}</div>
                  <pre className="text-xs opacity-80 whitespace-pre-wrap break-all">{error}</pre>
                </div>
              </div>
            ) : svgHtml ? (
              <div
                className="mermaid-preview cursor-pointer hover:opacity-90 transition-opacity [&>svg]:max-w-full [&>svg]:max-h-[300px] [&>svg]:mx-auto"
                onClick={() => setModalOpen(true)}
                title={t('mermaid.clickToEnlarge')}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            ) : (
              <div className="flex items-center justify-center py-6 text-muted-foreground text-sm">
                {t('mermaid.rendering')}
              </div>
            )}
          </div>
        ) : (
          <SyntaxHighlighter
            style={isDark ? oneDark : oneLight}
            language="mermaid"
            PreTag="div"
            customStyle={{ margin: 0, borderRadius: 0, fontSize: '0.875rem' }}
          >
            {code}
          </SyntaxHighlighter>
        )}
      </div>

      {/* Modal - portalled to body to bypass parent overflow/stacking context */}
      {modalOpen && svgHtml && createPortal(
        <MermaidModal
          svgHtml={svgHtml}
          onClose={() => setModalOpen(false)}
        />,
        document.body
      )}
    </>
  );
}

// ============================================
// TabButton
// ============================================

function TabButton({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded transition-colors ${
        active
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  );
}

// ============================================
// MermaidModal - fullscreen zoom/pan view
// ============================================

function MermaidModal({ svgHtml, onClose }: {
  svgHtml: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // ESC to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Background overlay */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl w-[96vw] h-[94vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
          <h3 className="text-sm font-medium text-foreground">{t('mermaid.mermaidChart')}</h3>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title={t('mermaid.closeEsc')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Diagram area - SVG fits the container */}
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <div
            className="w-full h-full flex items-center justify-center [&>svg]:max-w-full [&>svg]:max-h-full"
            dangerouslySetInnerHTML={{ __html: svgHtml }}
          />
        </div>
      </div>
    </div>
  );
}
