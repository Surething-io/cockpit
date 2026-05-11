'use client';

import {
  Children,
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react';

interface TooltipProps {
  content: string;
  children: ReactNode;
  /**
   * @deprecated Tooltip delay is now globally fixed at 300ms.
   * The prop is kept for backward compat with existing call sites
   * and is silently ignored.
   */
  delay?: number;
  /**
   * Optional className. When provided, Tooltip renders a wrapping `<div>` to
   * host the className — preserves layout for legacy call sites that relied
   * on the wrapper being a flex/grid item (e.g. `<Tooltip className="flex-1">
   * `). When omitted, the child is cloned in place with no extra DOM.
   */
  className?: string;
}

/**
 * Tooltip — thin wrapper that forwards `data-tooltip` to its child.
 *
 * The actual popover is rendered by a single `<TooltipProvider />` mounted
 * at the app root. This component just attaches the data attribute that the
 * provider listens for.
 *
 * Three render paths:
 *
 *   - `className` provided → wrap in a `<div>` carrying className +
 *     data-tooltip. Adds one DOM node, preserves layout semantics.
 *   - `className` omitted, single element child → `cloneElement` adds
 *     data-tooltip directly to the child. Zero extra DOM.
 *   - `className` omitted, multi/text child → fallback `<div>` wrapper
 *     using `display: contents` so it stays layout-transparent while
 *     still hosting the data attribute.
 *
 * All paths converge on the same global popover.
 */
export function Tooltip({ content, children, className }: TooltipProps) {
  // className path: keep a wrapping element so layout classes still apply.
  if (className) {
    return (
      <div data-tooltip={content} className={className}>
        {children}
      </div>
    );
  }

  // No className: try to clone onto a single element child to skip the
  // extra wrapper. cloneElement merges props automatically, so we only
  // pass the new attribute.
  const arr = Children.toArray(children);
  if (arr.length === 1 && isValidElement(arr[0])) {
    const child = arr[0] as ReactElement<{ 'data-tooltip'?: string }>;
    return cloneElement(child, { 'data-tooltip': content });
  }

  // Multi/text children: layout-transparent wrapper.
  return (
    <div data-tooltip={content} style={{ display: 'contents' }}>
      {children}
    </div>
  );
}
