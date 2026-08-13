'use client';

import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ToastProvider } from '@cockpit/shared-ui';
import { TooltipProvider } from '@cockpit/shared-ui';
import { useSuppressNativeContextMenu } from './useSuppressNativeContextMenu';
import { ServerRestartedBanner } from './ServerRestartedBanner';

interface ProvidersProps {
  children: React.ReactNode;
}

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
              container's translateX. Renders nothing until the server is
              detected on a different build. */}
          <ServerRestartedBanner />
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
