// The editor's white rounded card on the cream page (redesign3-spec.md §10),
// holding the page's one <main> (the skip link's target), which takes focus but
// draws no outline. The <main> sits inside a plain <div> on purpose: the App
// Router calls focus() on a segment's first DOM node when it applies a router
// update (a refresh, say), and a focusable <main> there took focus out of the
// editor about a second after a new document opened. A <div> ignores it.
//
// On phones there is no frame: the card fills the screen. From sm the cream
// page shows 24px around it, 40px from lg. Nothing here clips overflow, so the
// toolbar's sticky row keeps working.
//
// CONTRACT (redesign 3 foundation): props fixed; the editor-chrome track owns
// the implementation and replaces document-screen's Shell with it.

export function EditorFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="doc-screen doc-editor min-h-dvh bg-[var(--page-bg)] sm:p-6 lg:p-10">
      <main
        id="main-content"
        tabIndex={-1}
        className="min-h-dvh min-w-0 bg-[var(--editor-bg)] outline-none sm:min-h-[calc(100dvh-3rem)] sm:rounded-[24px] sm:border sm:border-[var(--frame-line)] lg:min-h-[calc(100dvh-5rem)] lg:rounded-[40px]"
      >
        {children}
      </main>
    </div>
  );
}
