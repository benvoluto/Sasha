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
          <Providers>
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
