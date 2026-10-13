// Which pages the app frame decorates (app-shell.tsx). Kept apart from the
// component so it can be tested directly (shell-paths.test.ts).

/** The overview, a new document, an open document and Activity show Sasha the dog. */
export function showsDog(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (pathname === "/" || pathname.startsWith("/d/")) return true;
  return ["/new", "/activity"].some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
