'use client';

import { useRef, useEffect, useState, ReactNode } from 'react';

interface SwipeablePagesProps {
  children: ReactNode[]; // 支持 2 个或 3 个子元素
  currentPage: number; // 0, 1, 或 2
  onPageChange: (page: number) => void;
}

export function SwipeablePages({ children, currentPage, onPageChange }: SwipeablePagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransitioningRef = useRef(false);
  // 用 ref 存储实时偏移量，避免闭包问题
  const dragOffsetRef = useRef(0);

  // 页面数量
  const pageCount = children.length;
  const maxPage = pageCount - 1;

  // 实时偏移量（像素），用于触发重渲染
  const [dragOffset, setDragOffset] = useState(0);
  // 是否正在拖动
  const [isDragging, setIsDragging] = useState(false);

  // 放大系数：触摸板滑动距离放大
  const SCALE_FACTOR = 3;
  // 松手判定超时（ms）
  const RELEASE_TIMEOUT = 100;
  // 切换阈值：超过页面宽度的 15% 就切换
  const SWITCH_THRESHOLD = 0.15;
  // 动画时长（ms）
  const TRANSITION_DURATION = 100;

  // 当 currentPage 变化时，重置 dragOffset
  useEffect(() => {
    dragOffsetRef.current = 0;
    setDragOffset(0);
  }, [currentPage]);

  // 处理触摸板双指横向滑动（wheel 事件）
  useEffect(() => {
    const container = containerRef.current;
    const inner = innerRef.current;
    if (!container || !inner) return;

    const handleWheel = (e: WheelEvent) => {
      // 只处理横向滚动（触摸板双指左右滑动）
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 2) {
        e.preventDefault();
        e.stopPropagation();

        // 如果正在过渡动画中，忽略
        if (isTransitioningRef.current) return;

        // 计算容器宽度（单页宽度）
        const pageWidth = container.clientWidth;

        // 计算新的偏移量（放大系数）
        let newOffset = dragOffsetRef.current - e.deltaX * SCALE_FACTOR;

        // 边界检测（硬边界，不允许超出）
        // 左边界：不能超过第一页（当 currentPage=0 时，不能往右滑）
        // 右边界：不能超过最后一页（当 currentPage=maxPage 时，不能往左滑）
        const canGoLeft = currentPage > 0;
        const canGoRight = currentPage < maxPage;

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
        setDragOffset(newOffset);
        setIsDragging(true);

        // 清除之前的超时
        if (wheelTimeoutRef.current) {
          clearTimeout(wheelTimeoutRef.current);
        }

        // 设置超时来检测松手
        wheelTimeoutRef.current = setTimeout(() => {
          // 松手，决定是切换还是回弹
          const finalOffset = dragOffsetRef.current;
          const threshold = pageWidth * SWITCH_THRESHOLD;

          // 先结束拖动状态，启用 transition
          setIsDragging(false);
          isTransitioningRef.current = true;

          let willSwitch = false;
          let newPage = currentPage;

          if (finalOffset < -threshold && currentPage < maxPage) {
            // 向左滑超过阈值，切换到下一页
            willSwitch = true;
            newPage = currentPage + 1;
          } else if (finalOffset > threshold && currentPage > 0) {
            // 向右滑超过阈值，切换到上一页
            willSwitch = true;
            newPage = currentPage - 1;
          }

          // 重置 dragOffset
          dragOffsetRef.current = 0;
          setDragOffset(0);

          if (willSwitch) {
            onPageChange(newPage);
          }

          // 过渡动画结束后解锁
          setTimeout(() => {
            isTransitioningRef.current = false;
          }, TRANSITION_DURATION);
        }, RELEASE_TIMEOUT);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => container.removeEventListener('wheel', handleWheel, { capture: true });
  }, [currentPage, maxPage, onPageChange]);

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

  // 计算最终的 transform
  const getTransform = () => {
    const pageWidth = containerRef.current?.clientWidth || 0;
    // 基础位置（百分比）：每页占 100/pageCount %
    const pagePercent = 100 / pageCount;
    const basePercent = -currentPage * pagePercent;

    if (pageWidth > 0 && dragOffset !== 0) {
      // 将像素偏移转换为百分比（相对于 pageCount * 100% 宽度的容器）
      const offsetPercent = (dragOffset / (pageWidth * pageCount)) * 100;
      return `translateX(${basePercent + offsetPercent}%)`;
    }
    return `translateX(${basePercent}%)`;
  };

  // 计算容器宽度百分比
  const containerWidth = `${pageCount * 100}%`;
  // 计算每页宽度
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
