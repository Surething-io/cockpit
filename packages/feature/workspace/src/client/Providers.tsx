'use client';

import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ToastProvider } from '@cockpit/shared-ui';
import { TooltipProvider } from '@cockpit/shared-ui';
import { useSuppressInstalledContextMenu } from './useSuppressInstalledContextMenu';

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  // In an installed PWA window on macOS, the native right-click menu breaks IME
  // (CJK) input window-wide; suppress it there. No-op in normal browser tabs.
  // See useSuppressInstalledContextMenu for the full rationale.
  useSuppressInstalledContextMenu();

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
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
