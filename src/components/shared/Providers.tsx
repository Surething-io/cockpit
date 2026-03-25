'use client';

import { I18nProvider } from './I18nProvider';
import { ThemeProvider } from './ThemeProvider';
import { ToastProvider } from './Toast';

interface ProvidersProps {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <I18nProvider>
      <ThemeProvider>
        <ToastProvider>
          {children}
        </ToastProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
