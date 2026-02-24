import { useState, useEffect } from 'react';

/**
 * 检测当前页面/iframe 是否可见
 * 用于在 iframe 被隐藏时暂停 WebSocket 等资源密集型操作
 *
 * 检测方式：
 * 1. document.visibilitychange（浏览器 tab 切换）
 * 2. 父窗口发来的 VISIBILITY 消息（iframe 被 CSS hidden 时）
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => {
    if (typeof document === 'undefined') return true;
    return document.visibilityState === 'visible';
  });

  useEffect(() => {
    // 浏览器 tab 可见性变化
    const handleVisibility = () => {
      setVisible(document.visibilityState === 'visible');
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // 父窗口通知 iframe 可见性变化
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
