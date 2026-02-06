'use client';

import { useRef, useEffect, useState, ReactNode, createContext, useContext, useMemo } from 'react';

export type ViewType = 'agent' | 'explorer' | 'browser';

const VIEWS: ViewType[] = ['agent', 'explorer', 'browser'];
const VIEW_LABELS: Record<ViewType, string> = {
  agent: 'AGENT',
  explorer: 'EXPLORER',
  browser: 'BROWSER',
};

// Context for sharing swipe state between SwipeableViewContainer and ViewSwitcherBar
interface SwipeContextValue {
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  dragOffset: number; // -1 to 1 range
  isDragging: boolean;
}

const SwipeContext = createContext<SwipeContextValue | null>(null);

export function useSwipeContext() {
  const context = useContext(SwipeContext);
  if (!context) {
    throw new Error('useSwipeContext must be used within SwipeableViewContainer');
  }
  return context;
}

interface SwipeableViewContainerProps {
  activeView: ViewType;
  onViewChange: (view: ViewType) => void;
  children: ReactNode; // ViewSwitcherBar + content area
}

/**
 * 检查元素是否可横向滚动
 */
function canScrollHorizontally(element: Element | null): boolean {
  while (element) {
    const style = window.getComputedStyle(element);
    const overflowX = style.overflowX;

    // 检查是否设置了横向滚动
    if (overflowX === 'auto' || overflowX === 'scroll') {
      // 检查是否有实际的横向滚动空间
      if (element.scrollWidth > element.clientWidth) {
        return true;
      }
    }

    element = element.parentElement;
  }
  return false;
}

export function SwipeableViewContainer({ activeView, onViewChange, children }: SwipeableViewContainerProps) {
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransitioningRef = useRef(false);
  const dragOffsetRef = useRef(0);

  // 实时偏移量（像素），用于触发重渲染
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  // 是否正在拖动
  const [isDragging, setIsDragging] = useState(false);

  const currentIndex = VIEWS.indexOf(activeView);
  const pageCount = 3;
  const maxPage = pageCount - 1;

  // 参数
  const SCALE_FACTOR = 6;          // 滑动灵敏度（调大更灵敏）
  const RELEASE_TIMEOUT = 60;      // 松手判定超时（60ms）
  const SWITCH_THRESHOLD = 0.12;   // 切换阈值（调小更容易切换）
  const TRANSITION_DURATION = 80;  // 动画时长（80ms）

  // 当 activeView 变化时，重置 dragOffset
  useEffect(() => {
    dragOffsetRef.current = 0;
    setDragOffsetPx(0);
  }, [activeView]);

  // 全屏监听 wheel 事件
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // 只处理横向滚动
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        // 智能判断：检查事件目标是否在可横向滚动的元素内
        const target = e.target as Element;
        if (canScrollHorizontally(target)) {
          // 让元素自己处理横向滚动
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        // 如果正在过渡动画中，新的滑动打断过渡
        if (isTransitioningRef.current) {
          isTransitioningRef.current = false;
        }

        // 计算容器宽度（单页宽度）
        const pageWidth = window.innerWidth;

        // 计算新的偏移量
        let newOffset = dragOffsetRef.current - e.deltaX * SCALE_FACTOR;

        // 边界检测
        const canGoLeft = currentIndex > 0;
        const canGoRight = currentIndex < maxPage;

        if (!canGoLeft && newOffset > 0) {
          newOffset = 0;
        }
        if (!canGoRight && newOffset < 0) {
          newOffset = 0;
        }

        // 限制最大偏移量为一个页面宽度
        newOffset = Math.max(-pageWidth, Math.min(pageWidth, newOffset));

        // 更新 ref 和 state
        dragOffsetRef.current = newOffset;
        setDragOffsetPx(newOffset);
        setIsDragging(true);

        // 清除之前的超时
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }

        // 设置超时来检测松手
        wheelTimeoutRef.current = setTimeout(() => {
          const finalOffset = dragOffsetRef.current;
          const threshold = pageWidth * SWITCH_THRESHOLD;

          setIsDragging(false);
          isTransitioningRef.current = true;

          let newPage = currentIndex;

          if (finalOffset < -threshold && currentIndex < maxPage) {
            newPage = currentIndex + 1;
          } else if (finalOffset > threshold && currentIndex > 0) {
            newPage = currentIndex - 1;
          }

          dragOffsetRef.current = 0;
          setDragOffsetPx(0);

          if (newPage !== currentIndex) {
            onViewChange(VIEWS[newPage]);
          }

          setTimeout(() => {
            isTransitioningRef.current = false;
          }, TRANSITION_DURATION);
        }, RELEASE_TIMEOUT);
      }
    };

    // 在 document 级别监听，capture 阶段
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handleWheel, { capture: true });
  }, [currentIndex, maxPage, onViewChange]);

  // 计算下划线偏移量（-1 到 1 范围，用于 ViewSwitcherBar）
  // 使用 state 来确保 SSR 和客户端一致
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const getUnderlineOffset = () => {
    if (!mounted) return 0;
    const pageWidth = window.innerWidth;
    if (!pageWidth) return 0;
    return dragOffsetPx / pageWidth;
  };

  // Context value
  const contextValue: SwipeContextValue = {
    activeView,
    onViewChange,
    dragOffset: getUnderlineOffset(),
    isDragging: mounted && isDragging,
  };

  return (
    <SwipeContext.Provider value={contextValue}>
      {children}
    </SwipeContext.Provider>
  );
}

// ============================================================================
// SwipeableContent - 可滑动的内容区域（三个视图）
// ============================================================================

interface SwipeableContentProps {
  children: ReactNode; // 三个视图内容
}

export function SwipeableContent({ children }: SwipeableContentProps) {
  const { activeView, dragOffset, isDragging } = useSwipeContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const currentIndex = VIEWS.indexOf(activeView);
  const pageCount = 3;

  // 防止浏览器自动滚动
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (container.scrollLeft !== 0) {
        container.scrollLeft = 0;
      }
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // 计算内容区域的 transform
  const getTransform = () => {
    const pagePercent = 100 / pageCount;
    const basePercent = -currentIndex * pagePercent;
    // dragOffset is already -1 to 1, convert to percentage of total width
    const offsetPercent = (dragOffset / pageCount) * 100;
    const totalPercent = basePercent + (Number.isFinite(offsetPercent) ? offsetPercent : 0);
    return `translateX(${totalPercent}%)`;
  };

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-hidden relative"
      style={{ overscrollBehaviorX: 'none' }}
    >
      <div
        ref={innerRef}
        className={isDragging ? 'flex' : 'flex transition-transform duration-100 ease-out'}
        style={{
          position: 'absolute',
          top: '0px',
          bottom: '0px',
          left: '0px',
          width: '300%',
          transform: getTransform(),
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// ViewSwitcherBar - 标题栏中的视图切换按钮（使用 context 获取滑动状态）
// ============================================================================

export function ViewSwitcherBar() {
  const { activeView, onViewChange, dragOffset, isDragging } = useSwipeContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  const currentIndex = VIEWS.indexOf(activeView);

  // 计算下划线位置和宽度
  const calculateUnderlineStyle = () => {
    if (!containerRef.current || buttonRefs.current.length === 0) {
      return { left: 0, width: 0 };
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const buttons = buttonRefs.current.filter(Boolean) as HTMLButtonElement[];

    if (buttons.length !== 3) {
      return { left: 0, width: 0 };
    }

    // dragOffset is -1 to 1, negative means swiping right (to previous view)
    // We need to invert it for the underline position
    const safeOffset = Number.isFinite(dragOffset) ? dragOffset : 0;
    const effectiveIndex = Math.max(0, Math.min(2, currentIndex - safeOffset));

    const leftIndex = Math.floor(effectiveIndex);
    const rightIndex = Math.ceil(effectiveIndex);
    const fraction = effectiveIndex - leftIndex;

    const leftButton = buttons[leftIndex];
    const rightButton = buttons[rightIndex];

    if (!leftButton || !rightButton) {
      return { left: 0, width: 0 };
    }

    const leftRect = leftButton.getBoundingClientRect();
    const rightRect = rightButton.getBoundingClientRect();

    const left = leftRect.left + (rightRect.left - leftRect.left) * fraction - containerRect.left;
    const width = leftRect.width + (rightRect.width - leftRect.width) * fraction;

    return { left, width };
  };

  // 更新下划线位置
  useEffect(() => {
    setUnderlineStyle(calculateUnderlineStyle());
  }, [currentIndex, dragOffset]);

  // 监听窗口大小变化
  useEffect(() => {
    const handleResize = () => {
      setUnderlineStyle(calculateUnderlineStyle());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentIndex, dragOffset]);

  // 计算当前有效索引（考虑滑动偏移）
  // 当 dragOffset 为 0 或 NaN 时，使用 currentIndex
  const safeOffset = Number.isFinite(dragOffset) ? dragOffset : 0;
  const effectiveIndex = Math.max(0, Math.min(2, currentIndex - safeOffset));
  const nearestIndex = Math.round(effectiveIndex);

  return (
    <div
      ref={containerRef}
      className="relative flex gap-4"
    >
      {VIEWS.map((view, index) => (
        <button
          key={view}
          ref={el => { buttonRefs.current[index] = el; }}
          onClick={() => onViewChange(view)}
          className={`px-4 py-1 text-sm font-medium transition-colors ${
            nearestIndex === index
              ? 'text-brand'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {VIEW_LABELS[view]}
        </button>
      ))}

      {/* 下划线指示器 */}
      <div
        className={`absolute bottom-0 h-0.5 bg-brand ${isDragging ? '' : 'transition-all duration-100 ease-out'}`}
        style={{
          left: underlineStyle.left,
          width: underlineStyle.width,
        }}
      />
    </div>
  );
}
