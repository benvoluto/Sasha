import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

// Cabin is the interface face (--font-app); Hanken Grotesk is the document
// body face (--font-doc, used by .doc-prose). Both are set in globals.css.
import "@fontsource-variable/cabin/wght.css";
import "@fontsource-variable/cabin/wght-italic.css";
import "@fontsource-variable/hanken-grotesk/wght.css";
import "@fontsource-variable/hanken-grotesk/wght-italic.css";
import "./globals.css";
import { Providers } from "./providers";
import { ProcessingTracker } from "@/components/processing-tracker";
import { AppShell } from "@/components/shell/app-shell";
import { devAuthBypass } from "@/lib/dev-auth";

export const metadata: Metadata = {
  title: "Sasha",
  description: "Write any kind of document with your sources, data and notes.",
};

export default function RootLayout({
  children,
  modal,
}: Readonly<{
  children: React.ReactNode;
  modal: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
      <html lang="en" suppressHydrationWarning>
        <body
          className={`antialiased`}
          suppressHydrationWarning
        >
          {/* The first stop for Tab on every page: jumps past the rail and the
              documents panel to the page's <main id="main-content" tabIndex={-1}>. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-[var(--editor-bg)] focus:px-4 focus:py-3 focus:text-[15px] focus:font-semibold focus:text-[var(--action)] focus:shadow-lg focus:outline-2 focus:outline-offset-2 focus:outline-[var(--action)]"
          >
            Skip to main content
          </a>
          {/* Always false in production builds (devAuthBypass checks NODE_ENV). */}
          <Providers devAuthBypass={devAuthBypass()}>
            {/* The rail and documents panel on the writing pages (a no-op elsewhere). */}
            <AppShell>{children}</AppShell>
            {modal}
            {/* Survives navigation and reloads — background case processing stays
                visible wherever the user goes, and clears itself when it lands. */}
            <ProcessingTracker />
          </Providers>
        </body>
      </html>
    </ClerkProvider>
  );
}
