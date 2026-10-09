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

// With the dev auth bypass on there are no Clerk keys, so Clerk runs keyless
// and floats a "Configure your application" prompt over the bottom-right
// corner, on top of the floating Outline/Tools/Sources buttons. Nothing in the
// bypass uses Clerk, so hide it. Clerk's classes are hashed; the toggle's
// aria-label is the stable handle. Never rendered in production (the bypass is off).
const HIDE_KEYLESS_PROMPT = '#clerk-components > div:has(> button[aria-label="Keyless prompt"]) { display: none !important; }';

export function Providers({ children, devAuthBypass = false }: { children: React.ReactNode; devAuthBypass?: boolean }) {
  return (
    <DevAuthBypassProvider value={devAuthBypass}>
      {devAuthBypass && <style>{HIDE_KEYLESS_PROMPT}</style>}
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