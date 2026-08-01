'use client';

import { useState } from 'react';
import { Portal, MenuContainerProvider } from '@cockpit/shared-ui';
import { InteractiveMarkdownPreview } from '@cockpit/feature-explorer';

interface MdPreviewModalProps {
  filePath: string;
  content: string;
  /** Only feeds the comment layer; pass the file's own directory when there is no project. */
  cwd: string;
  onClose: () => void;
  /**
   * Stacking level of the overlay. Defaults to the chat message stream's z-50.
   * Callers that open this from inside another overlay must raise it: Portal
   * renders to <body>, so a z-50 preview would otherwise slide UNDER the
   * surface that launched it.
   */
  zClassName?: string;
}

/**
 * Full-screen markdown preview for a file on disk. Provides MenuContainerProvider
 * so the selection FloatingToolbar anchors inside the modal instead of the page.
 *
 * The container uses a callback ref (a useState setter): React invokes it
 * synchronously on mount, so the provider has its element on the first paint
 * rather than a tick later.
 *
 * Content is a prop, not fetched here — callers already differ in how they get it
 * (the chat stream branches on image/html first, the task board reads one known
 * path), and folding those together would buy nothing.
 */
export function MdPreviewModal({ filePath, content, cwd, onClose, zClassName = 'z-50' }: MdPreviewModalProps) {
  const [container, setContainer] = useState<HTMLElement | null>(null);

  return (
    <Portal>
      <div
        className={`fixed inset-0 ${zClassName} flex items-center justify-center bg-black/50 p-0 md:p-4`}
        onClick={onClose}
      >
        <div
          ref={setContainer}
          className="bg-card shadow-xl w-full h-full rounded-none md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col relative"
          onClick={(e) => e.stopPropagation()}
        >
          <MenuContainerProvider container={container}>
            <InteractiveMarkdownPreview
              content={content}
              filePath={filePath}
              cwd={cwd}
              onClose={onClose}
            />
          </MenuContainerProvider>
        </div>
      </div>
    </Portal>
  );
}
