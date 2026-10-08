// Closes the document modal on navigation. On a client-side navigation a parallel
// slot with no page for the new URL keeps rendering what it had, so a link out
// of the modal (to the workflow canvas, say) opened that page behind it. Every
// route lands here and renders nothing (the slot has no intercepted routes).
export default function CloseModal() {
  return null;
}
