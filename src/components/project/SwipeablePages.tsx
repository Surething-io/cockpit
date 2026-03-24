'use client';

import { useRef, useEffect, useState, ReactNode } from 'react';

interface SwipeablePagesProps {
  children: ReactNode[]; // Supports 2 or 3 child elements
  currentPage: number; // 0, 1, or 2
  onPageChange: (page: number) => void;
}

export function SwipeablePages({ children, currentPage, onPageChange }: SwipeablePagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransitioningRef = useRef(false);
  // Store live offset in a ref to avoid closure issues
  const dragOffsetRef = useRef(0);

  // Number of pages
  const pageCount = children.length;
  const maxPage = pageCount - 1;

  // Live offset in pixels, used to trigger re-renders
  const [dragOffset, setDragOffset] = useState(0);
  // Whether a drag is in progress
  const [isDragging, setIsDragging] = useState(false);

  // Scale factor: amplify trackpad swipe distance
  const SCALE_FACTOR = 3;
  // Release detection timeout (ms)
  const RELEASE_TIMEOUT = 100;
  // Switch threshold: switch if offset exceeds 15% of page width
  const SWITCH_THRESHOLD = 0.15;
  // Animation duration (ms)
  const TRANSITION_DURATION = 100;

  // Reset dragOffset when currentPage changes
  useEffect(() => {
    dragOffsetRef.current = 0;
    setDragOffset(0);
  }, [currentPage]);

  // Handle trackpad two-finger horizontal swipe (wheel event)
  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle horizontal scrolling (trackpad two-finger left/right swipe)
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        e.preventDefault();
        e.stopPropagation();

        // Ignore if a transition animation is in progress
        if (isTransitioningRef.current) return;

        // Compute container width (single page width)
        const pageWidth = container.clientWidth;

        // Compute new offset (with scale factor)
        let newOffset = dragOffsetRef.current - e.deltaX * SCALE_FACTOR;

        // Hard boundary check — no overscrolling allowed
        // Left boundary: cannot go past the first page (when currentPage=0, no right swipe)
        // Right boundary: cannot go past the last page (when currentPage=maxPage, no left swipe)
        const canGoLeft = currentPage > 0;
        const canGoRight = currentPage < maxPage;

        if (!canGoLeft && newOffset > 0) {
          newOffset = 0;
        }
        if (!canGoRight && newOffset < 0) {
          newOffset = 0;
        }

        // Clamp offset to one page width
        newOffset = Math.max(-pageWidth, Math.min(pageWidth, newOffset));

        // Update ref and state
        dragOffsetRef.current = newOffset;
        setDragOffset(newOffset);
        setIsDragging(true);

        // Clear previous timeout
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }

        // Set timeout to detect release
        wheelTimeoutRef.current = setTimeout(() => {
          // Released — decide whether to switch pages or snap back
          const finalOffset = dragOffsetRef.current;
          const threshold = pageWidth * SWITCH_THRESHOLD;

          // End dragging state first to enable transition
          setIsDragging(false);
          isTransitioningRef.current = true;

          let willSwitch = false;
          let newPage = currentPage;

          if (finalOffset < -threshold && currentPage < maxPage) {
            // Swiped left past threshold — go to next page
            willSwitch = true;
            newPage = currentPage + 1;
          } else if (finalOffset > threshold && currentPage > 0) {
            // Swiped right past threshold — go to previous page
            willSwitch = true;
            newPage = currentPage - 1;
          }

          // Reset dragOffset
          dragOffsetRef.current = 0;
          setDragOffset(0);

          if (willSwitch) {
            onPageChange(newPage);
          }

          // Unlock after transition animation completes
          setTimeout(() => {
            isTransitioningRef.current = false;
          }, TRANSITION_DURATION);
        }, RELEASE_TIMEOUT);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => container.removeEventListener('wheel', handleWheel, { capture: true });
  }, [currentPage, maxPage, onPageChange]);

  // Prevent the browser from auto-scrolling
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

  // Compute the final transform
  const getTransform = () => {
    const pageWidth = containerRef.current?.clientWidth || 0;
    // Base position (percentage): each page occupies 100/pageCount %
    const pagePercent = 100 / pageCount;
    const basePercent = -currentPage * pagePercent;

    if (pageWidth > 0 && dragOffset !== 0) {
      // Convert pixel offset to percentage (relative to the pageCount * 100% wide container)
      const offsetPercent = (dragOffset / (pageWidth * pageCount)) * 100;
      return `translateX(${basePercent + offsetPercent}%)`;
    }
    return `translateX(${basePercent}%)`;
  };

  // Compute container width as a percentage
  const containerWidth = `${pageCount * 100}%`;
  // Compute per-page width class
  const pageWidthClass = pageCount === 2 ? 'w-1/2' : pageCount === 3 ? 'w-1/3' : 'w-1/2';

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
          top: 0,
          bottom: 0,
          left: 0,
          width: containerWidth,
          transform: getTransform(),
        }}
      >
        {children.map((child, index) => (
          <div key={index} className={`${pageWidthClass} h-full overflow-hidden`}>
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}
