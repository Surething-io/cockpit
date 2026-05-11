'use client';

import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from '@cockpit/shared-ui';
import { ToastProvider } from '@cockpit/shared-ui';
import { TooltipProvider } from '@cockpit/shared-ui';

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
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
