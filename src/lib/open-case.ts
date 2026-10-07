// Hand-off for "Open case" links outside the case list: they leave the case id
// for this tab and go to the list, which opens it in the modal. Session storage
// rather than a query string, so the list's URL stays "/" and a reload or Back
// doesn't open the case again. Without storage (private mode), the link just
// goes to the list.

const KEY = "open-case";

export function requestCaseOpen(groupId: string): void {
  try {
    sessionStorage.setItem(KEY, groupId);
  } catch {
    /* storage unavailable: the list opens without the case */
  }
}

/** The case to open, once: reading it clears it. */
export function takeCaseToOpen(): string | null {
  try {
    const id = sessionStorage.getItem(KEY);
    if (id) sessionStorage.removeItem(KEY);
    return id;
  } catch {
    return null;
  }
}
