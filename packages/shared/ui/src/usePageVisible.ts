import { useState, useEffect } from 'react';

/**
 * Detect whether the current page/iframe is visible.
 * Used to pause resource-intensive operations (e.g. WebSocket) when the iframe is hidden.
 *
 * Detection methods:
 * 1. document.visibilitychange (browser tab switching)
 * 2. VISIBILITY message from parent window (iframe hidden via CSS)
 */
export function usePageVisible(): boolean {
  const [documentVisible, setDocumentVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  const [frameVisible, setFrameVisible] = useState(() => typeof window === 'undefined' || window.parent === window);

  useEffect(() => {
    // Browser tab visibility change
    const handleVisibility = () => {
      setDocumentVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Parent window notifies iframe of visibility change
    const handleMessage = (event: MessageEvent) => {
      if ((event.data?.type === 'IFRAME_VISIBILITY' || event.data?.type === 'PROJECT_NUMBER')
        && typeof event.data.visible === 'boolean') {
        setFrameVisible(event.data.visible);
      }
    };
    window.addEventListener('message', handleMessage);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return documentVisible && frameVisible;
}
