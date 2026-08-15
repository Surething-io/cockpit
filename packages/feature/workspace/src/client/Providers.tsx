'use client';

import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ToastProvider } from '@cockpit/shared-ui';
import { TooltipProvider } from '@cockpit/shared-ui';
import { useSuppressNativeContextMenu } from './useSuppressNativeContextMenu';
import { UpdateProgressCard } from './UpdateProgressCard';

interface ProvidersProps {
  children: React.ReactNode;
}

/**
 * NOTE for anything added below with viewport-relative `position: fixed`:
 * this tree is mounted MORE THAN ONCE per window. Every project pane is an
 * <iframe> loading Cockpit itself (Workspace.tsx), so the parent plus every
 * open project each mount their own Providers, each in its own JS context with
 * its own module-level state. An iframe pane's right edge is the window's right
 * edge and its top edge is near the window's, so a "top-right" overlay in a
 * frame lands almost exactly on the parent's copy.
 *
 * A singleton overlay must therefore gate on `window.self === window.top` —
 * see UpdateProgressCard. Per-frame surfaces (toasts, which belong to whatever
 * acted) are fine as they are.
 */
export function Providers({ children }: ProvidersProps) {
  // Suppress the native right-click menu across Cockpit; app-owned React context
  // menus keep working because they preventDefault before this bubble listener.
  // See useSuppressNativeContextMenu for the full rationale.
  useSuppressNativeContextMenu();

  return (
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          {children}
          {/* Single global popover for every `data-tooltip` attribute,
              including those forwarded by the <Tooltip> wrapper. Lives
              outside any panel so its `position: fixed` stays viewport-
              relative under panel `translateX` transforms. */}
          <TooltipProvider />
          {/* Outside the panels for the same reason as TooltipProvider: its
              `position: fixed` must stay viewport-relative under the panel
              container's translateX. Plus one of its own — a self-update
              outlives the sidebar popover that triggers it, and the server it
              is waiting on is gone for most of that time, so the card has to
              survive panel switches, sidebar collapse and reloads.

              This is also the ONLY surface that offers a reload. The bottom
              ServerRestartedBanner used to be a second one, which meant two
              cards with two "Reload" buttons whenever an update finished; its
              build-id case is folded into this card instead. */}
          <UpdateProgressCard />
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
