"use client";

// The app frame, rendered once by the root layout around every page: the cream
// left rail, the documents/folders panel that slides in from the left, and the
// page beside them. It shows on the writing pages ("/", "/d/[id]", "/library",
// "/catalog"), the workflow canvas ("/workflows") and usage ("/usage"), and steps aside elsewhere
// (sign-in), where the page renders as before. Because it lives in the layout, it survives moving
// between documents: the panel stays open and keeps its scroll.
//
// The open document comes from activeDocumentAtom (./active-document), which
// the editing screen writes; the panel's open state is docsPanelOpenAtom
// (./shell-state), remembered across reloads.

import { useAtom } from "jotai";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AppRail } from "./app-rail";
import { DocsPanel } from "./docs-panel";
import { inAppFrame, trapNextIndex } from "./docs-panel-model";
import { docsPanelOpenAtom, PUSH_QUERY, readDocsPanelPref, useIsWide, writeDocsPanelPref } from "./shell-state";

const TABBABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]';

/** The controls Tab visits inside `root`, in document order (visible, not inert, not tabindex=-1). */
function tabbablesIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.closest("[inert]") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  );
}

/** The pages inside the frame (docs-panel-model.ts inAppFrame). */
export const inFrame = inAppFrame;

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (!inFrame(pathname)) return <>{children}</>;
  return <Frame pathname={pathname ?? "/"}>{children}</Frame>;
}

function Frame({ pathname, children }: { pathname: string; children: ReactNode }) {
  const [open, setOpen] = useAtom(docsPanelOpenAtom);
  const wide = useIsWide();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const panelFocus = useRef<"heading" | "toggle" | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [animate, setAnimate] = useState(false);

  // The remembered choice, read once after mount (storage isn't there on the
  // server). Slides are switched on a frame later, so a panel remembered open
  // is simply there on load instead of sliding in.
  useEffect(() => {
    const pref = readDocsPanelPref();
    if (pref !== null) setOpen(pref);
    setHydrated(true);
    const raf = window.requestAnimationFrame(() => setAnimate(true));
    return () => window.cancelAnimationFrame(raf);
  }, [setOpen]);

  useEffect(() => {
    if (hydrated) writeDocsPanelPref(open);
  }, [open, hydrated]);

  // Opening moves focus into the panel; closing hands it back to the rail
  // button, unless something else (a followed link, the editor's title) is
  // taking it.
  useEffect(() => {
    const target = panelFocus.current;
    panelFocus.current = null;
    if (!target) return;
    const raf = window.requestAnimationFrame(() => {
      if (target === "heading") headingRef.current?.focus();
      else toggleRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const toggle = useCallback(() => {
    panelFocus.current = open ? "toggle" : "heading";
    setOpen(!open);
  }, [open, setOpen]);

  const close = useCallback(
    (opts?: { restoreFocus?: boolean }) => {
      panelFocus.current = opts?.restoreFocus === false ? null : "toggle";
      setOpen(false);
    },
    [setOpen],
  );

  const overlay = !wide && open;

  // The overlay panel is a modal dialog: keep Tab inside it. The loop is the
  // rail's Documents button (which closes it) plus the panel's controls. Only
  // Tab pressed in the panel, on that button or with focus lost to the page is
  // taken; portalled menus and dialogs (and the account menu) keep their own.
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const panel = document.getElementById("docs-panel");
      const toggleButton = toggleRef.current;
      if (!panel) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const owned = !target || target === document.body || target === toggleButton || panel.contains(target) || !!target.closest("[inert]");
      if (!owned) return;
      const loop = [...(toggleButton ? [toggleButton] : []), ...tabbablesIn(panel)];
      const next = trapNextIndex(loop.length, target ? loop.indexOf(target) : -1, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      loop[next].focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overlay]);

  // The panel becoming an overlay while already open (a resize or rotation
  // below 1024px, or a panel remembered open on a narrow screen) puts focus
  // into it, as opening it does; otherwise focus could sit in the now-inert page.
  useEffect(() => {
    if (!overlay) return;
    const raf = window.requestAnimationFrame(() => {
      if (window.matchMedia(PUSH_QUERY).matches) return;
      const panel = document.getElementById("docs-panel");
      const active = document.activeElement;
      if (panel && active && (panel.contains(active) || active === toggleRef.current)) return;
      headingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [overlay]);

  return (
    <div className="flex min-h-dvh">
      <AppRail pathname={pathname} panelOpen={open} onTogglePanel={toggle} toggleRef={toggleRef} />
      <DocsPanel open={open} wide={wide} animate={animate} headingRef={headingRef} onClose={close} />
      <div className="min-w-0 flex-1" inert={overlay || undefined}>
        {children}
      </div>
    </div>
  );
}
