"use client";

// The narrow cream rail down the left of the writing pages: the Documents
// toggle (opens the documents/folders panel), links to the source library and
// the document-type catalog, the account menu, and Sasha herself at the bottom.
// It sits above the panel (z-50) so the mascot can overlap the panel's and the
// editor's edge, as in the mockup.

import { UserButton } from "@clerk/nextjs";
import Link from "next/link";
import type { ComponentType, ReactNode, RefObject } from "react";
import { DocsIcon, LibraryIcon, TypesIcon } from "@/components/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const RAIL_BUTTON =
  "grid h-11 w-11 place-items-center rounded-xl text-[var(--panel-head)] hover:bg-[var(--panel-hover)] aria-[current=page]:bg-[var(--panel-hover)] aria-expanded:bg-[var(--panel-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--panel-head)]";

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function RailLink({ href, label, icon: Icon, pathname }: { href: string; label: string; icon: ComponentType<{ className?: string }>; pathname: string }) {
  const current = pathname === href || pathname.startsWith(`${href}/`);
  return (
    <RailTip label={label}>
      <Link href={href} aria-label={label} aria-current={current ? "page" : undefined} className={RAIL_BUTTON}>
        <Icon className="h-6 w-6" />
      </Link>
    </RailTip>
  );
}

export function AppRail({ pathname, panelOpen, onTogglePanel, toggleRef }: { pathname: string; panelOpen: boolean; onTogglePanel: () => void; toggleRef: RefObject<HTMLButtonElement | null> }) {
  return (
    <nav aria-label="App" className="sticky top-0 z-50 flex h-dvh w-14 shrink-0 flex-col items-center gap-2 bg-[var(--rail-bg)] pt-5 sm:w-[72px]">
      <RailTip label={panelOpen ? "Hide documents" : "Documents"}>
        <button ref={toggleRef} type="button" aria-label="Documents" aria-expanded={panelOpen} aria-controls="docs-panel" onClick={onTogglePanel} className={RAIL_BUTTON}>
          <DocsIcon className="h-[26px] w-[26px]" />
        </button>
      </RailTip>
      <RailLink href="/library" label="Library" icon={LibraryIcon} pathname={pathname} />
      <RailLink href="/catalog" label="Document types" icon={TypesIcon} pathname={pathname} />

      <div className="mt-auto mb-24 grid h-11 w-11 place-items-center [@media(max-height:520px)]:mb-4">
        <UserButton>
          <UserButton.MenuItems>
            <UserButton.Link label="Document types" labelIcon={<TypesIcon className="h-4 w-4" />} href="/catalog" />
          </UserButton.MenuItems>
        </UserButton>
      </div>

      {/* Decorative: Sasha the dog, allowed to spill past the rail's edge. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG; next/image adds nothing here */}
      <img src="/sasha.svg" alt="" width={64} height={80} draggable={false} className="pointer-events-none absolute bottom-0 left-1 w-14 sm:left-4 sm:w-16 select-none [@media(max-height:520px)]:hidden" />
    </nav>
  );
}
