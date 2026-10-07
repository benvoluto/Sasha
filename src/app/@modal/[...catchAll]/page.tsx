// Closes the document modal on navigation. On a client-side navigation a parallel
// slot with no page for the new URL keeps rendering what it had, so a link out
// of the modal (to the workflow canvas, say) opened that page behind it. Any
// route other than the intercepted /cases/[groupId] lands here and renders nothing.
export default function CloseModal() {
  return null;
}
