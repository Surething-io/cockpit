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
  const onCardRef = useRef(false); // 鼠标是否在卡片上

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
    leaveTimerRef.current = setTimeout(() => {
      if (!onCardRef.current) {
        setHoverInfo(null);
      }
    }, 150);
  }, []);

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
    activeRequestRef.current++;
    setHoverInfo(null);
  }, []);

  return { hoverInfo, onTokenMouseEnter, onTokenMouseLeave, onCardMouseEnter, onCardMouseLeave, clearHover };
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
