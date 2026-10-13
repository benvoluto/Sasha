// A page-wide signal that a document save has landed. The editor's last save
// can still be in flight after the person has gone back to the overview (it is
// sent as the editor unmounts), so the overview listens and refetches its cards
// when the save completes instead of showing what it read a moment earlier.

type Listener = (id: string) => void;

const listeners = new Set<Listener>();

/** Calls `listener` with the document's id after each successful save. Returns the unsubscribe. */
export function onDocumentSaved(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells every listener that `id` was saved. A listener that throws doesn't stop the rest. */
export function notifyDocumentSaved(id: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(id);
    } catch {
      // A listener's failure is its own; the save itself succeeded.
    }
  }
}
