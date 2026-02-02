'use client';

import { useRef, useEffect, useState, ReactNode } from 'react';

interface SwipeablePagesProps {
  children: [ReactNode, ReactNode]; // 必须是两个子元素
  currentPage: number; // 0 或 1
  onPageChange: (page: number) => void;
}

export function SwipeablePages({ children, currentPage, onPageChange }: SwipeablePagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isTransitioningRef = useRef(false);
  // 用 ref 存储实时偏移量，避免闭包问题
  const dragOffsetRef = useRef(0);

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
        if (currentPage === 0) {
          // 在第一页：不能向右滑（正值），最多滑到第二页（-pageWidth）
          newOffset = Math.max(-pageWidth, Math.min(0, newOffset));
        } else {
          // 在第二页：不能向左滑（负值），最多滑到第一页（pageWidth）
          newOffset = Math.max(0, Math.min(pageWidth, newOffset));
        }

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

          if (currentPage === 0 && finalOffset < -threshold) {
            // 向左滑超过阈值，切换到第二页
            willSwitch = true;
            // 先重置 dragOffset，避免 currentPage 变化后的一帧延迟闪烁
            dragOffsetRef.current = 0;
            setDragOffset(0);
            onPageChange(1);
          } else if (currentPage === 1 && finalOffset > threshold) {
            // 向右滑超过阈值，切换到第一页
            willSwitch = true;
            // 先重置 dragOffset，避免 currentPage 变化后的一帧延迟闪烁
            dragOffsetRef.current = 0;
            setDragOffset(0);
            onPageChange(0);
          }

          // 如果不切换，需要回弹到原位
          if (!willSwitch) {
            dragOffsetRef.current = 0;
            setDragOffset(0);
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
  }, [currentPage, onPageChange]);

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
    // 基础位置（百分比）
    const basePercent = currentPage === 0 ? 0 : -50;

    if (pageWidth > 0 && dragOffset !== 0) {
      // 将像素偏移转换为百分比（相对于 200% 宽度的容器）
      const offsetPercent = (dragOffset / (pageWidth * 2)) * 100;
      return `translateX(${basePercent + offsetPercent}%)`;
    }
    return `translateX(${basePercent}%)`;
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
          top: 0,
          bottom: 0,
          left: 0,
          width: '200%',
          transform: getTransform(),
        }}
      >
        {/* 第一页 */}
        <div className="w-1/2 h-full overflow-hidden">
          {children[0]}
        </div>
        {/* 第二页 */}
        <div className="w-1/2 h-full overflow-hidden">
          {children[1]}
        </div>
      </div>
    </div>
  );
}
