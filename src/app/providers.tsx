'use client';

import { ThemeProvider } from '@/components/theme-provider';
import { Provider as JotaiProvider } from 'jotai';
import { IconContext } from '@/components/icons';

// Phosphor's default "regular" weight is noticeably lighter than the 2px stroke
// the interface was drawn against, which leaves icons looking washed out beside
// their labels. Setting it once here keeps every icon consistent, so no
// component has to remember a `weight` prop.
const ICON_DEFAULTS = { weight: 'bold' as const };

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <JotaiProvider>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
      >
        <IconContext.Provider value={ICON_DEFAULTS}>
          {children}
        </IconContext.Provider>
      </ThemeProvider>
    </JotaiProvider>
  );
}