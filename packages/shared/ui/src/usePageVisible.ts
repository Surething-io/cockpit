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
  const [visible, setVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  useEffect(() => {
    // Browser tab visibility change
    const handleVisibility = () => {
      setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Parent window notifies iframe of visibility change
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'IFRAME_VISIBILITY') {
        setVisible(!!event.data.visible);
      }
    };
    window.addEventListener('message', handleMessage);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('message', handleMessage);
    };
  }, []);

  return visible;
}
