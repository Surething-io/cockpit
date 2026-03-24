'use client';

import { useRef, useEffect, useState, ReactNode, createContext, useContext, useMemo } from 'react';

export type ViewType = 'agent' | 'explorer' | 'console';

const VIEWS: ViewType[] = ['agent', 'explorer', 'console'];
const VIEW_LABELS: Record<ViewType, string> = {
  agent: 'AGENT',
  explorer: 'EXPLORER',
  console: 'CONSOLE',
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
 * Check whether an element can scroll horizontally
 */
function canScrollHorizontally(element: Element | null): boolean {
  while (element) {
    const style = window.getComputedStyle(element);
    const overflowX = style.overflowX;

    // Check if horizontal scrolling is enabled
    if (overflowX === 'auto' || overflowX === 'scroll') {
      // Check if there is actual horizontal scroll space
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

  // Live offset in pixels, used to trigger re-renders
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  // Whether a drag is in progress
  const [isDragging, setIsDragging] = useState(false);

  const currentIndex = VIEWS.indexOf(activeView);
  const pageCount = VIEWS.length;
  const maxPage = VIEWS.length - 1;

  // Parameters
  const SCALE_FACTOR = 6;          // Swipe sensitivity (higher = more sensitive)
  const RELEASE_TIMEOUT = 60;      // Release detection timeout (60ms)
  const SWITCH_THRESHOLD = 0.12;   // Switch threshold (lower = easier to switch)
  const TRANSITION_DURATION = 80;  // Animation duration (80ms)

  // Reset dragOffset when activeView changes
  useEffect(() => {
    dragOffsetRef.current = 0;
    setDragOffsetPx(0);
  }, [activeView]);

  // Listen to wheel events at the document level
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // Handle horizontal scroll only
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        // Do not intercept scroll events inside iframes
        const target = e.target as Element;
        if (target.tagName === 'IFRAME') return;
        // Smart check: if the target is inside a horizontally-scrollable element, let it handle the scroll
        if (canScrollHorizontally(target)) {
          // Let the element handle horizontal scrolling itself
          return;
        }

        e.preventDefault();
        e.stopPropagation();

        // If a transition is in progress, a new swipe interrupts it
        if (isTransitioningRef.current) {
          isTransitioningRef.current = false;
        }

        // Calculate container width (single page width)
        const pageWidth = window.innerWidth;

        // Calculate new offset
        let newOffset = dragOffsetRef.current - e.deltaX * SCALE_FACTOR;

        // Boundary check
        const canGoLeft = currentIndex > 0;
        const canGoRight = currentIndex < maxPage;

        if (!canGoLeft && newOffset > 0) {
          newOffset = 0;
        }
        if (!canGoRight && newOffset < 0) {
          newOffset = 0;
        }

        // Clamp offset to one page width maximum
        newOffset = Math.max(-pageWidth, Math.min(pageWidth, newOffset));

        // Update ref and state
        dragOffsetRef.current = newOffset;
        setDragOffsetPx(newOffset);
        setIsDragging(true);

        // Clear the previous timeout
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }

        // Set timeout to detect release
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

    // Listen at document level, capture phase
    document.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => document.removeEventListener('wheel', handleWheel, { capture: true });
  }, [currentIndex, maxPage, onViewChange]);

  // Compute underline offset (-1 to 1 range, used by ViewSwitcherBar)
  // Use state to ensure SSR and client consistency
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
// SwipeableContent - Swipeable content area (three views)
// ============================================================================

interface SwipeableContentProps {
  children: ReactNode; // Three view contents
}

export function SwipeableContent({ children }: SwipeableContentProps) {
  const { activeView, dragOffset, isDragging } = useSwipeContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const currentIndex = VIEWS.indexOf(activeView);
  const pageCount = VIEWS.length;

  // Prevent browser from auto-scrolling
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

  // Calculate the transform for the content area
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
          width: `${VIEWS.length * 100}%`,
          transform: getTransform(),
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// ViewSwitcherBar - View switch buttons in the title bar (uses context for swipe state)
// ============================================================================

export function ViewSwitcherBar() {
  const { activeView, onViewChange, dragOffset, isDragging } = useSwipeContext();
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [underlineStyle, setUnderlineStyle] = useState({ left: 0, width: 0 });

  const currentIndex = VIEWS.indexOf(activeView);

  // Calculate underline position and width
  const calculateUnderlineStyle = () => {
    if (!containerRef.current || buttonRefs.current.length === 0) {
      return { left: 0, width: 0 };
    }

    const containerRect = containerRef.current.getBoundingClientRect();
    const buttons = buttonRefs.current.filter(Boolean) as HTMLButtonElement[];

    if (buttons.length !== VIEWS.length) {
      return { left: 0, width: 0 };
    }

    // dragOffset is -1 to 1, negative means swiping right (to previous view)
    // We need to invert it for the underline position
    const safeOffset = Number.isFinite(dragOffset) ? dragOffset : 0;
    const effectiveIndex = Math.max(0, Math.min(VIEWS.length - 1, currentIndex - safeOffset));

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

  // Update underline position
  useEffect(() => {
    setUnderlineStyle(calculateUnderlineStyle());
  }, [currentIndex, dragOffset]);

  // Listen to window resize
  useEffect(() => {
    const handleResize = () => {
      setUnderlineStyle(calculateUnderlineStyle());
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [currentIndex, dragOffset]);

  // Compute current effective index (accounting for swipe offset)
  // When dragOffset is 0 or NaN, fall back to currentIndex
  const safeOffset = Number.isFinite(dragOffset) ? dragOffset : 0;
  const effectiveIndex = Math.max(0, Math.min(VIEWS.length - 1, currentIndex - safeOffset));
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

      {/* Underline indicator */}
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
