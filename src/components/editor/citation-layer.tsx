"use client";

// Citations in the editor (PLAN §6.8, phase7-spec.md §2.4): the reference
// numbers drawn after each cited span, the passage shown on hover or when the
// caret is in a cited span (an accessible, keyboard-reachable popover),
// opening the source in the library drawer, and the lint that flags citations
// whose source was unlinked or deleted.
//
// The numbers and the stale styling are ProseMirror decorations from a plugin
// this component registers on the editor; the popover, the caret hint and the
// live region are React, positioned from the editor's coordinates. The pure
// parts (runs, numbering, wording) are in citation-layer-model.ts.

import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { citationHref, type CitationsResponse, type ResolvedReference } from "@/lib/citations/contract";
import {
  addedKeys,
  announcement,
  citationRuns,
  hintText,
  isStale,
  numberRuns,
  quoteParts,
  referenceTitle,
  refWidgets,
  missingKeys,
  runFor,
  runMark,
  runsAt,
  statusText,
  type CitationRun,
} from "./citation-layer-model";

export type CitationLayerProps = {
  editor: Editor;
  /** null until the document is first saved (nothing to resolve yet). */
  documentId: string | null;
  /** Bumps when the linked sources change (the Sources tab's report), so the lint re-runs. */
  sourcesKey: string | null;
  /** The stored document's updated_at: after each save, the lint re-runs while a citation in the editor has no reference yet. */
  savedAt?: string | null;
};

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 200;
const LINT_DEBOUNCE_MS = 2000;
const ANNOUNCE_MS = 400;

// --- The plugin -----------------------------------------------------------------

type LayerState = { runs: CitationRun[]; numbers: Map<string, number>; stale: ReadonlySet<string>; decos: DecorationSet };
type LayerHandlers = { open: (key: string, pos: number) => void; altEnter: () => boolean; escape: () => boolean };

export const citationLayerKey = new PluginKey<LayerState>("citationLayer");

function refWidget(view: EditorView, key: string, n: number, stale: boolean, handlers: LayerHandlers): HTMLElement {
  const sup = view.dom.ownerDocument.createElement("sup");
  sup.className = `citation-ref${stale ? " citation-ref--stale" : ""}`;
  sup.setAttribute("data-key", key);
  sup.setAttribute("aria-hidden", "true");
  sup.contentEditable = "false";
  sup.textContent = `[${n}]`;
  // mousedown would move the selection into the widget; keep the editor's.
  sup.addEventListener("mousedown", (e) => e.preventDefault());
  sup.addEventListener("click", (e) => {
    e.preventDefault();
    // The position now, not when the widget was built: ProseMirror keeps this
    // element (same spec.key) while edits above move the run.
    let pos = -1;
    try {
      pos = view.posAtDOM(sup, 0);
    } catch {
      // A widget without a position: open() falls back to the key's first run.
    }
    handlers.open(key, pos);
  });
  return sup;
}

function layerState(state: EditorState, stale: ReadonlySet<string>, handlers: LayerHandlers): LayerState {
  const runs = citationRuns(state.doc);
  const numbers = numberRuns(runs);
  const decos: Decoration[] = [];
  for (const r of runs) if (stale.has(r.key)) decos.push(Decoration.inline(r.from, r.to, { class: "citation--stale" }));
  for (const { pos, keys } of refWidgets(runs, numbers)) {
    keys.forEach((key, i) => {
      const n = numbers.get(key) ?? 0;
      const isStaleKey = stale.has(key);
      decos.push(
        Decoration.widget(pos, (view) => refWidget(view, key, n, isStaleKey, handlers), {
          side: 1 + i,
          key: `cite-${key}-${n}-${isStaleKey ? "s" : "ok"}`,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      );
    });
  }
  return { runs, numbers, stale, decos: DecorationSet.create(state.doc, decos) };
}

function citationLayerPlugin(handlers: LayerHandlers): Plugin<LayerState> {
  return new Plugin<LayerState>({
    key: citationLayerKey,
    state: {
      init: (_config, state) => layerState(state, new Set(), handlers),
      apply: (tr, value, _old, state) => {
        const stale = tr.getMeta(citationLayerKey) as ReadonlySet<string> | undefined;
        if (!tr.docChanged && !stale) return value;
        return layerState(state, stale ?? value.stale, handlers);
      },
    },
    props: {
      decorations: (state) => citationLayerKey.getState(state)?.decos,
      handleKeyDown: (_view, event) => {
        if (event.altKey && event.key === "Enter") return handlers.altEnter();
        // A popover the editor kept focus for (nothing in it could take focus) still closes on Esc.
        if (event.key === "Escape") return handlers.escape();
        return false;
      },
    },
  });
}

/** Mark which reference keys are stale (from the lint). Not an edit: kept out of the history. */
function setStale(view: EditorView, keys: Iterable<string>) {
  view.dispatch(view.state.tr.setMeta(citationLayerKey, new Set(keys)).setMeta("addToHistory", false));
}

// --- The component ----------------------------------------------------------------

type Popover = { key: string; pos: number; focus: boolean };
type Anchor = { left: number; top: number; bottom: number };

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** A touch screen as the main pointer: no hover and no Alt key, so taps open the details. */
const isCoarse = () => typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;

export function CitationLayer({ editor, documentId, sourcesKey, savedAt = null }: CitationLayerProps) {
  const [refs, setRefs] = useState<Map<string, ResolvedReference>>(() => new Map());
  const [popover, setPopover] = useState<Popover | null>(null);
  const [caret, setCaret] = useState<{ key: string; pos: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  const [, setTick] = useState(0);
  const popRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef<{ open?: number; close?: number; lint?: number; announce?: number }>({});
  /** The last press on the editor: its pointer type, and the run the caret was in before it. */
  const press = useRef<{ touch: boolean; caretKey: string | null }>({ touch: false, caretKey: null });
  const state = useRef({ popover, caret, refs });
  state.current = { popover, caret, refs };

  // --- Lint -------------------------------------------------------------------
  const lintAbort = useRef<AbortController | null>(null);
  const runLint = useCallback(async () => {
    if (!documentId) return;
    lintAbort.current?.abort();
    const ctrl = new AbortController();
    lintAbort.current = ctrl;
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/citations`, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as CitationsResponse;
      if (ctrl.signal.aborted) return;
      setRefs(new Map(body.references.map((r) => [r.key, r])));
      if (!editor.isDestroyed) setStale(editor.view, body.references.filter(isStale).map((r) => r.key));
    } catch {
      // Offline or aborted: the lint is advisory; keep what we had.
    }
  }, [documentId, editor]);

  useEffect(() => {
    void runLint();
    return () => lintAbort.current?.abort();
  }, [runLint, sourcesKey]);

  // --- Opening ---------------------------------------------------------------------
  const runOf = useCallback(
    (key: string, pos: number) => {
      const layer = citationLayerKey.getState(editor.state);
      return layer ? (runFor(layer.runs, key, pos) ?? layer.runs.find((r) => r.key === key) ?? null) : null;
    },
    [editor],
  );
  const openSource = useCallback(
    (key: string, pos: number) => {
      const run = runOf(key, pos);
      const href = run ? citationHref(run.attrs) : null;
      if (href) window.open(href, "_blank", "noopener");
    },
    [runOf],
  );

  const handlers = useRef<LayerHandlers>({ open: () => {}, altEnter: () => false, escape: () => false });
  // A click on a reference number opens the source; a tap opens the details
  // first (the only way to them on a phone), whose Open source then navigates.
  handlers.current.open = (key, pos) => {
    if (!press.current.touch) return openSource(key, pos);
    const run = runOf(key, pos);
    if (run) setPopover({ key, pos: run.to, focus: false });
  };
  handlers.current.escape = () => {
    if (!state.current.popover) return false;
    setPopover(null);
    return true;
  };
  handlers.current.altEnter = () => {
    const c = state.current.caret;
    if (!c) return false;
    window.clearTimeout(timers.current.close);
    setPopover({ key: c.key, pos: c.pos, focus: true });
    return true;
  };

  // Register the plugin for the editor's lifetime (the handlers are read through the ref).
  useEffect(() => {
    if (editor.isDestroyed) return;
    const plugin = citationLayerPlugin({ open: (k, p) => handlers.current.open(k, p), altEnter: () => handlers.current.altEnter(), escape: () => handlers.current.escape() });
    editor.registerPlugin(plugin);
    return () => {
      if (!editor.isDestroyed) editor.unregisterPlugin(citationLayerKey);
    };
  }, [editor]);

  // --- Caret, live region, lint after a citation is added ------------------------------
  const keysRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const onTransaction = () => {
      const layer = citationLayerKey.getState(editor.state);
      if (!layer) return;
      const keys = new Set(layer.runs.map((r) => r.key));
      if (keysRef.current && addedKeys(keysRef.current, keys).length) {
        window.clearTimeout(timers.current.lint);
        timers.current.lint = window.setTimeout(() => void runLint(), LINT_DEBOUNCE_MS);
      }
      keysRef.current = keys;

      const { selection } = editor.state;
      const here = selection.empty && editor.isFocused ? runsAt(layer.runs, selection.head) : [];
      const first = here.sort((a, b) => (layer.numbers.get(a.key) ?? 0) - (layer.numbers.get(b.key) ?? 0))[0];
      const next = first ? { key: first.key, pos: first.to } : null;
      const prev = state.current.caret;
      if (next?.key !== prev?.key || next?.pos !== prev?.pos) {
        setCaret(next);
        window.clearTimeout(timers.current.announce);
        if (next && next.key !== prev?.key) {
          timers.current.announce = window.setTimeout(() => {
            const ref = state.current.refs.get(next.key);
            const run = runFor(citationLayerKey.getState(editor.state)?.runs ?? [], next.key, next.pos);
            setAnnounce(announcement(referenceTitle(ref, run?.attrs ?? { kind: "passage" })));
          }, ANNOUNCE_MS);
        }
      }
      // Coordinates move with every edit.
      setTick((t) => t + 1);
    };
    onTransaction();
    editor.on("transaction", onTransaction);
    editor.on("focus", onTransaction);
    editor.on("blur", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      editor.off("focus", onTransaction);
      editor.off("blur", onTransaction);
    };
  }, [editor, runLint]);

  // --- Hover, and taps on touch screens ------------------------------------------------
  useEffect(() => {
    if (editor.isDestroyed) return;
    const dom = editor.view.dom as HTMLElement;
    const t = timers.current;
    const hit = (e: MouseEvent): { key: string; pos: number } | null => {
      const target = e.target as HTMLElement | null;
      const layer = citationLayerKey.getState(editor.state);
      if (!target || !layer) return null;
      const sup = target.closest<HTMLElement>("sup.citation-ref");
      if (sup?.dataset.key) {
        const key = sup.dataset.key;
        let pos = -1;
        try {
          pos = editor.view.posAtDOM(sup, 0);
        } catch {
          // A widget without a position: fall back to the key's first run.
        }
        const run = runFor(layer.runs, key, pos) ?? layer.runs.find((r) => r.key === key);
        return run ? { key, pos: run.to } : null;
      }
      if (!target.closest("span.citation")) return null;
      const at = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (!at) return null;
      const runs = runsAt(layer.runs, at.pos).concat(layer.runs.filter((r) => r.from === at.pos));
      const first = runs.sort((a, b) => (layer.numbers.get(a.key) ?? 0) - (layer.numbers.get(b.key) ?? 0))[0];
      return first ? { key: first.key, pos: first.to } : null;
    };
    const over = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const h = hit(e);
      if (!h) return;
      window.clearTimeout(t.close);
      window.clearTimeout(t.open);
      t.open = window.setTimeout(() => {
        const cur = state.current.popover;
        if (cur?.focus) return;
        setPopover({ key: h.key, pos: h.pos, focus: false });
      }, HOVER_OPEN_MS);
    };
    const out = (e: PointerEvent) => {
      window.clearTimeout(t.open);
      if (e.pointerType === "touch") return;
      if (state.current.popover && !state.current.popover.focus) t.close = window.setTimeout(() => setPopover((p) => (p?.focus ? p : null)), HOVER_CLOSE_MS);
    };
    const down = (e: PointerEvent) => {
      press.current = { touch: e.pointerType === "touch", caretKey: state.current.caret?.key ?? null };
    };
    // A tap on a cited span the caret was already in opens its details (the
    // first tap only places the caret, as anywhere else in the text).
    const tap = (e: MouseEvent) => {
      if (!press.current.touch || (e.target as HTMLElement | null)?.closest("sup.citation-ref")) return;
      const h = hit(e);
      if (h && h.key === press.current.caretKey) setPopover({ key: h.key, pos: h.pos, focus: false });
    };
    dom.addEventListener("pointerdown", down, true);
    dom.addEventListener("pointerover", over);
    dom.addEventListener("pointerout", out);
    dom.addEventListener("click", tap);
    return () => {
      dom.removeEventListener("pointerdown", down, true);
      dom.removeEventListener("pointerover", over);
      dom.removeEventListener("pointerout", out);
      dom.removeEventListener("click", tap);
      window.clearTimeout(t.open);
      window.clearTimeout(t.close);
    };
  }, [editor]);

  // A lint for a reference it hasn't seen yet (a citation made since the last save).
  const askedFor = useRef(new Set<string>());
  useEffect(() => {
    if (popover && !refs.has(popover.key) && !askedFor.current.has(popover.key)) {
      askedFor.current.add(popover.key);
      void runLint();
    }
  }, [popover, refs, runLint]);

  // The lint reads the STORED document, so a citation made since the last save
  // is missing from it until the save lands (typing keeps putting the save
  // off). Once a save lands, ask again for any citation still without a reference.
  const lastSaved = useRef(savedAt);
  useEffect(() => {
    if (savedAt === lastSaved.current) return;
    lastSaved.current = savedAt;
    const runs = citationLayerKey.getState(editor.state)?.runs ?? [];
    const missing = missingKeys(runs, state.current.refs);
    if (!missing.length) return;
    for (const key of missing) askedFor.current.delete(key);
    void runLint();
  }, [savedAt, editor, runLint]);

  // Keep the popover anchored while the page scrolls; close it when its run is gone.
  useEffect(() => {
    if (!popover) return;
    const move = () => setTick((n) => n + 1);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, [popover]);

  useEffect(() => {
    // Open source is disabled for a deleted source or a table without one; Remove citation never is.
    if (popover?.focus) popRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [popover]);

  // Non-modal: a press anywhere else closes it.
  useEffect(() => {
    if (!popover) return;
    const down = (e: PointerEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPopover(null);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [popover]);

  useEffect(() => () => Object.values(timers.current).forEach((id) => window.clearTimeout(id)), []);

  const closePopover = (refocus: boolean) => {
    setPopover(null);
    if (refocus && !editor.isDestroyed) editor.view.focus();
  };

  const removeCitation = (p: Popover) => {
    const layer = citationLayerKey.getState(editor.state);
    const run = layer ? runFor(layer.runs, p.key, p.pos) : null;
    const mark = run ? runMark(editor.state.doc, run) : null;
    if (run && mark) editor.view.dispatch(editor.state.tr.removeMark(run.from, run.to, mark));
    closePopover(true);
  };

  // --- Rendering -------------------------------------------------------------------------
  const layer = editor.isDestroyed ? null : citationLayerKey.getState(editor.state);
  const anchorOf = (pos: number): Anchor | null => {
    if (editor.isDestroyed || pos < 0 || pos > editor.state.doc.content.size) return null;
    try {
      const c = editor.view.coordsAtPos(pos);
      return { left: c.left, top: c.top, bottom: c.bottom };
    } catch {
      return null;
    }
  };

  const popRun = popover && layer ? runFor(layer.runs, popover.key, popover.pos) : null;
  const popAnchor = popRun ? anchorOf(popRun.to) : null;
  const showHint = !!caret && !popover && editor.isFocused;
  const hintAnchor = showHint && caret ? anchorOf(caret.pos) : null;
  const portal = typeof document !== "undefined" ? document.body : null;

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {announce}
      </span>
      {portal && hintAnchor && caret && layer
        ? createPortal(
            <div aria-hidden="true" className="citation-hint" style={{ left: clampX(hintAnchor.left, 260), top: hintAnchor.bottom + 6 }}>
              {hintText(layer.numbers.get(caret.key) ?? 0, isCoarse() ? "touch" : isMac() ? "mac" : "keyboard")}
            </div>,
            portal,
          )
        : null}
      {portal && popover && popRun && popAnchor && layer
        ? createPortal(
            <CitationPopover
              ref={popRef}
              n={layer.numbers.get(popover.key) ?? 0}
              run={popRun}
              reference={refs.get(popover.key) ?? null}
              anchor={popAnchor}
              onEnter={() => window.clearTimeout(timers.current.close)}
              onLeave={(e) => {
                // A finger lifting off the popover is not leaving it.
                if (!popover.focus && e.pointerType !== "touch") timers.current.close = window.setTimeout(() => setPopover(null), HOVER_CLOSE_MS);
              }}
              onEscape={() => closePopover(true)}
              onOpen={() => {
                openSource(popover.key, popRun.to);
                closePopover(popover.focus);
              }}
              onRemove={() => removeCitation(popover)}
            />,
            portal,
          )
        : null}
    </>
  );
}

const POPOVER_W = 340;

function clampX(left: number, width: number): number {
  if (typeof window === "undefined") return left;
  return Math.max(16, Math.min(left - 12, window.innerWidth - width - 16));
}

type PopoverProps = {
  n: number;
  run: CitationRun;
  reference: ResolvedReference | null;
  anchor: Anchor;
  onEnter: () => void;
  onLeave: (e: React.PointerEvent) => void;
  onEscape: () => void;
  onOpen: () => void;
  onRemove: () => void;
  ref: React.Ref<HTMLDivElement>;
};

function CitationPopover({ n, run, reference, anchor, onEnter, onLeave, onEscape, onOpen, onRemove, ref }: PopoverProps) {
  const { attrs } = run;
  const stale = isStale(reference);
  const page = reference?.page ?? null;
  const excerpt = reference?.excerpt ?? null;
  const parts = excerpt ? quoteParts(excerpt, attrs.quote) : null;
  const below = typeof window === "undefined" || anchor.bottom + 260 < window.innerHeight;
  const style: React.CSSProperties = { left: clampX(anchor.left, POPOVER_W), width: `min(${POPOVER_W}px, calc(100vw - 32px))` };
  if (below) style.top = anchor.bottom + 6;
  else style.bottom = (typeof window === "undefined" ? 0 : window.innerHeight) - anchor.top + 6;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={`Source ${n}`}
      className={`citation-popover${stale ? " citation-popover--stale" : ""}`}
      style={style}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onEscape();
          return;
        }
        // Tab past either end closes it and goes back to the citation, rather
        // than off the end of the page (the popover is portalled to <body>).
        if (e.key === "Tab") {
          const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled)"));
          const edge = e.shiftKey ? buttons[0] : buttons[buttons.length - 1];
          if (!buttons.length || document.activeElement === edge) {
            e.preventDefault();
            onEscape();
          }
        }
      }}
    >
      <p className="citation-popover-title">
        <span className="citation-popover-num">[{n}]</span> {referenceTitle(reference, attrs)}
        {page != null ? <span className="citation-popover-page">, p. {page}</span> : null}
      </p>
      {parts ? (
        <blockquote className="citation-popover-excerpt">
          {parts.length === 3 ? (
            <>
              {parts[0]}
              <mark>{parts[1]}</mark>
              {parts[2]}
            </>
          ) : (
            parts[0]
          )}
        </blockquote>
      ) : null}
      <p className={`citation-popover-status${stale ? " is-stale" : ""}`}>{statusText(reference, attrs)}</p>
      <div className="citation-popover-actions">
        <button type="button" onClick={onOpen} disabled={!citationHref(attrs) || reference?.status === "deleted"}>
          Open source
        </button>
        <button type="button" onClick={onRemove}>
          Remove citation
        </button>
      </div>
    </div>
  );
}
