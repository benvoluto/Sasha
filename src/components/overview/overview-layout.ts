// The overview's grid and side gutter (redesign3-spec.md §2), shared by the
// Documents tab (overview.tsx) and the Notes tab (src/components/notes) so
// both line up: 2 columns on a phone, about 7 at 2000px.

/** The card grid; the folder tiles and note cards use the same columns. */
export const OVERVIEW_GRID = "grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(200px,1fr))] sm:gap-[34px]";
/** The page's side gutter: 16px on a phone. */
export const OVERVIEW_GUTTER = "px-4 sm:px-8 lg:px-[6.8%]";
