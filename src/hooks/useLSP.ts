'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { Location, HoverInfo } from '@/lib/lsp/types';
import { getLanguageForFile } from '@/lib/lsp/types';

// ============================================
// LSP Definition Hook
// ============================================

export function useLSPDefinition(cwd: string) {
  const [loading, setLoading] = useState(false);

  const goToDefinition = useCallback(async (
    filePath: string,
    line: number,
    column: number,
  ): Promise<Location[]> => {
    setLoading(true);
    try {
      const res = await fetch('/api/lsp/definition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, filePath, line, column }),
      });
      const data = await res.json();
      return data.definitions || [];
    } catch (err) {
      console.error('[useLSP] definition error:', err);
      return [];
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  return { goToDefinition, loading };
}

// ============================================
// LSP Hover Hook
// ============================================

const HOVER_DELAY = 300; // ms

interface HoverData extends HoverInfo {
  x: number;
  y: number;
  filePath: string;
  line: number;
  column: number;
}

export function useLSPHover(cwd: string) {
  const [hoverInfo, setHoverInfo] = useState<HoverData | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRequestRef = useRef<number>(0);
  const onCardRef = useRef(false); // 鼠标是否在卡片（已激活 pointer-events-auto）上

  // tooltip DOM ref + 全局鼠标位置（仅写 ref，零 re-render）
  const tooltipElRef = useRef<HTMLDivElement | null>(null);
  const mousePosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const h = (e: MouseEvent) => { mousePosRef.current.x = e.clientX; mousePosRef.current.y = e.clientY; };
    document.addEventListener('mousemove', h);
    return () => document.removeEventListener('mousemove', h);
  }, []);

  // 命令式激活 tooltip 交互（pointer-events: auto + 绑定 mouseleave）
  const activatedRef = useRef(false);
  const nativeLeaveRef = useRef<(() => void) | null>(null);

  const deactivateTooltip = useCallback(() => {
    const el = tooltipElRef.current;
    if (el && activatedRef.current) {
      el.style.pointerEvents = 'none';
    }
    activatedRef.current = false;
    if (nativeLeaveRef.current) {
      tooltipElRef.current?.removeEventListener('mouseleave', nativeLeaveRef.current);
      nativeLeaveRef.current = null;
    }
  }, []);

  const activateTooltip = useCallback(() => {
    const el = tooltipElRef.current;
    if (!el || activatedRef.current) return;
    activatedRef.current = true;
    onCardRef.current = true;
    el.style.pointerEvents = 'auto';

    // 绑定原生 mouseleave（不走 React，不触发 re-render 直到真正需要隐藏）
    const handleLeave = () => {
      onCardRef.current = false;
      deactivateTooltip();
      activeRequestRef.current++;
      setHoverInfo(null);
    };
    nativeLeaveRef.current = handleLeave;
    el.addEventListener('mouseleave', handleLeave);
  }, [deactivateTooltip]);

  const onTokenMouseEnter = useCallback((
    filePath: string,
    line: number,
    column: number,
    rect: { x: number; y: number },
  ) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);

    const requestId = ++activeRequestRef.current;

    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/lsp/hover', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd, filePath, line, column }),
        });
        const data = await res.json();

        if (requestId !== activeRequestRef.current) return;

        if (data.hover && data.hover.displayString) {
          setHoverInfo({
            ...data.hover,
            x: rect.x,
            y: rect.y,
            filePath,
            line,
            column,
          });
        }
      } catch {
        // ignore
      }
    }, HOVER_DELAY);
  }, [cwd]);

  const onTokenMouseLeave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    // 立即废弃在途请求，防止 fetch 回来后触发 setHoverInfo
    activeRequestRef.current++;
    // 延迟清除卡片，给用户时间把鼠标移到卡片上
    leaveTimerRef.current = setTimeout(function checkAndHide() {
      if (onCardRef.current) return; // 已在激活的卡片上
      // 几何检测：鼠标是否在 tooltip rect 内（即使 pointer-events-none）
      const el = tooltipElRef.current;
      if (el) {
        const r = el.getBoundingClientRect();
        const { x, y } = mousePosRef.current;
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          // 鼠标在 tooltip 上 → 激活交互，不隐藏
          activateTooltip();
          return;
        }
      }
      setHoverInfo(null);
    }, 150);
  }, [activateTooltip]);

  // onCardMouseEnter / onCardMouseLeave 保留给按钮区域的 pointer-events-auto 使用
  const onCardMouseEnter = useCallback(() => {
    onCardRef.current = true;
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
  }, []);

  const onCardMouseLeave = useCallback(() => {
    onCardRef.current = false;
    activeRequestRef.current++;
    setHoverInfo(null);
  }, []);

  const clearHover = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    onCardRef.current = false;
    deactivateTooltip();
    activeRequestRef.current++;
    setHoverInfo(null);
  }, [deactivateTooltip]);

  // hoverInfo 清空时，重置激活状态
  useEffect(() => {
    if (!hoverInfo) {
      deactivateTooltip();
    }
  }, [hoverInfo, deactivateTooltip]);

  return { hoverInfo, onTokenMouseEnter, onTokenMouseLeave, onCardMouseEnter, onCardMouseLeave, clearHover, tooltipElRef };
}

// ============================================
// LSP References Hook
// ============================================

export function useLSPReferences(cwd: string) {
  const [references, setReferences] = useState<Location[]>([]);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);

  const findReferences = useCallback(async (
    filePath: string,
    line: number,
    column: number,
  ) => {
    setLoading(true);
    setVisible(true);
    try {
      const res = await fetch('/api/lsp/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, filePath, line, column }),
      });
      const data = await res.json();
      setReferences(data.references || []);
    } catch (err) {
      console.error('[useLSP] references error:', err);
      setReferences([]);
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  const closeReferences = useCallback(() => {
    setVisible(false);
    setReferences([]);
  }, []);

  return { references, loading, visible, findReferences, closeReferences };
}

// ============================================
// LSP Warmup Hook - 选中文件时预启动 Language Server
// ============================================

export function useLSPWarmup(cwd: string, selectedPath: string | null) {
  const warmedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedPath || selectedPath === warmedRef.current) return;
    if (!getLanguageForFile(selectedPath)) return;

    warmedRef.current = selectedPath;

    // fire-and-forget，不阻塞 UI
    fetch('/api/lsp/warmup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, filePath: selectedPath }),
    }).catch(() => {});
  }, [cwd, selectedPath]);
}
