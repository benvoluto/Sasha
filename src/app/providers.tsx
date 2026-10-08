'use client';

import { ThemeProvider } from '@/components/theme-provider';
import { Provider as JotaiProvider } from 'jotai';
import { IconContext } from '@/components/icons';
import { DevAuthBypassProvider } from '@/components/dev-auth-context';

// Phosphor's default "regular" weight is noticeably lighter than the 2px stroke
// the interface was drawn against, which leaves icons looking washed out beside
// their labels. Setting it once here keeps every icon consistent, so no
// component has to remember a `weight` prop.
const ICON_DEFAULTS = { weight: 'bold' as const };

export function Providers({ children, devAuthBypass = false }: { children: React.ReactNode; devAuthBypass?: boolean }) {
  return (
    <DevAuthBypassProvider value={devAuthBypass}>
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
    </DevAuthBypassProvider>
  );
}