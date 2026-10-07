import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";

import "./globals.css";
import { Providers } from "./providers";
import { ProcessingTracker } from "@/components/processing-tracker";

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
            {children}
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
