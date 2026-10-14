"use client";

// The overview's header (redesign3-spec.md §2, docs/documents.png): the search
// pill on the left; the Documents / Notes tabs and the Doc Gallery button in
// the middle; Select, New, Activity and the account menu on the right.
//
// From lg up it is one row: the search and the right-hand actions each take an
// equal share of the spare width, so the tabs and Doc Gallery sit in the middle
// as in the mockup (the search pill keeps a fixed width inside its share); a
// tablet is too narrow for that row. Below lg it is two:
// search, Activity and the avatar, then the tabs, Doc Gallery, Select and New. The middle and right
// groups are `display: contents` on narrow screens, so their items wrap into
// the second row. Activity and the avatar are rendered twice (one copy per
// layout, the other `display: none`), so the focus order always follows the
// order on screen; CSS `order` would move them without moving focus.
//
// Select and New show their labels except on phones (below sm), as in the
// mockup. Doc Gallery and Activity are icon-only until there is room (lg, 2xl:
// Activity is not in the mockup, and its label would push the tabs off centre
// on a laptop) and carry a `title` for the icon-only range.

import Link from "next/link";
import { useEffect, useState, type RefObject } from "react";
import { ActivityIcon, GalleryIcon, NewDocIcon, Search, SelectIcon } from "@/components/icons";
import { UserMenu } from "@/components/shell/user-menu";
import { NEW_DOCUMENT_PATH } from "@/lib/documents/card-text";
import { FOCUS_RING } from "./inline-edit";
import { tabForKey, type OverviewTab } from "./overview-model";

export const TAB_IDS: Record<OverviewTab, { tab: string; panel: string }> = {
  documents: { tab: "overview-tab-documents", panel: "overview-panel-documents" },
  notes: { tab: "overview-tab-notes", panel: "overview-panel-notes" },
};

const ACTION = `flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full px-1 text-[18px] font-medium text-[var(--action)] hover:bg-[var(--action-soft)] aria-pressed:bg-[var(--action-soft)] md:min-h-10 ${FOCUS_RING}`;
/** Padding for an action whose label is showing. */
const LABELLED = "sm:px-3";

export function OverviewHeader({
  tab,
  onTab,
  search,
  onSearch,
  selecting,
  onToggleSelect,
  selectRef,
  onOpenGallery,
}: {
  tab: OverviewTab;
  onTab: (tab: OverviewTab) => void;
  search: string;
  onSearch: (value: string) => void;
  selecting: boolean;
  onToggleSelect: () => void;
  selectRef: RefObject<HTMLButtonElement | null>;
  onOpenGallery: () => void;
}) {
  // A fresh `n` remounts the editor when a new document is already open. Set
  // after mount: Date.now() during render would differ between server and client.
  const [stamp, setStamp] = useState<number | null>(null);
  useEffect(() => setStamp(Date.now()), []);

  // Activity and the account menu, once per layout (see the header comment).
  const accountItems = (
    <>
      <Link href="/activity" title="Activity" className={`${ACTION} 2xl:px-3`}>
        <ActivityIcon className="h-6 w-6" aria-hidden />
        <span className="sr-only 2xl:not-sr-only">Activity</span>
      </Link>
      <UserMenu />
    </>
  );

  const tabButton = (t: OverviewTab, label: string) => {
    const active = tab === t;
    return (
      <button
        type="button"
        role="tab"
        id={TAB_IDS[t].tab}
        aria-selected={active}
        aria-controls={TAB_IDS[t].panel}
        tabIndex={active ? 0 : -1}
        onClick={() => onTab(t)}
        onKeyDown={(e) => {
          const next = tabForKey(t, e.key);
          if (!next) return;
          e.preventDefault();
          onTab(next);
          document.getElementById(TAB_IDS[next].tab)?.focus();
        }}
        className={`min-h-11 rounded-full px-2.5 text-[17px] font-semibold sm:px-6 sm:text-[18px] md:min-h-12 ${
          active ? "bg-[var(--tab-active-bg)] text-[var(--tab-active-ink)]" : "text-[var(--tab-ink)] hover:underline"
        } ${FOCUS_RING}`}
      >
        {label}
      </button>
    );
  };

  return (
    <header className="flex flex-wrap items-center gap-x-2 gap-y-3 px-4 pt-4 lg:flex-nowrap md:gap-x-4 md:px-[2.6%] md:pt-8">
      {/* Search (row 1 on a phone; left on wider screens). */}
      <div className="min-w-0 flex-1">
        <label className={`flex h-11 w-full items-center gap-2 rounded-full lg:w-[190px] border-[1.5px] border-[color-mix(in_srgb,var(--tab-ink)_40%,transparent)] bg-[var(--editor-bg)] px-3.5 focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--tab-ink)] md:h-10`}>
          <Search className="h-5 w-5 shrink-0 text-[var(--tab-ink)]" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              // Esc in a non-empty search clears it rather than leaving Select mode.
              if (e.key === "Escape" && search) {
                e.preventDefault();
                e.stopPropagation();
                onSearch("");
              }
            }}
            placeholder="Search"
            aria-label={tab === "notes" ? "Search notes" : "Search documents"}
            className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--card-title)] outline-none placeholder:text-[var(--card-untitled)]"
          />
        </label>
      </div>

      {/* Activity and the avatar beside the search on a phone. */}
      <div className="flex items-center gap-2 lg:hidden">{accountItems}</div>

      {/* A line break between the phone's two rows. */}
      <div aria-hidden className="basis-full lg:hidden" />

      {/* Middle: the tabs and Doc Gallery. */}
      <div className="contents lg:flex lg:shrink-0 lg:items-center lg:gap-8 xl:gap-12">
        <div role="tablist" aria-label="Overview" className="flex items-center gap-0.5 sm:gap-1">
          {tabButton("documents", "Documents")}
          {tabButton("notes", "Notes")}
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          title="Doc Gallery"
          onClick={onOpenGallery}
          className={`ml-auto flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full px-1 text-[18px] font-medium text-[var(--tab-ink)] hover:bg-[var(--card-bg)] md:min-h-10 lg:ml-0 lg:pr-3 ${FOCUS_RING}`}
        >
          <span aria-hidden className="grid h-9 w-9 place-items-center rounded-full border-2 border-[var(--tab-ink)]">
            <GalleryIcon className="h-5 w-5" />
          </span>
          <span className="sr-only lg:not-sr-only">Doc Gallery</span>
        </button>
      </div>

      {/* Right: Select, New, Activity and the account menu. */}
      <div className="contents lg:flex lg:flex-1 lg:items-center lg:justify-end lg:gap-3 xl:gap-6 2xl:gap-10">
        {tab === "documents" && (
          <button ref={selectRef} type="button" aria-pressed={selecting} onClick={onToggleSelect} className={`${ACTION} ${LABELLED}`}>
            <SelectIcon className="h-6 w-6" aria-hidden />
            <span className="sr-only sm:not-sr-only">Select</span>
          </button>
        )}
        <Link href={stamp ? `${NEW_DOCUMENT_PATH}?n=${stamp}` : NEW_DOCUMENT_PATH} className={`${ACTION} ${LABELLED}`}>
          <NewDocIcon className="h-6 w-6" aria-hidden />
          <span className="sr-only sm:not-sr-only">New</span>
        </Link>
        <div className="hidden lg:contents">{accountItems}</div>
      </div>
    </header>
  );
}
