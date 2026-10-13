// The save status's relative time (redesign3-spec.md §11), kept pure so it can
// be tested without a clock: "Saved just now" for the first minute, then
// minutes, then hours, then the date once a day has passed.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Saved just now", "Saved 3 min ago", "Saved 2 h ago" or "Saved Oct 3".
 * `savedAt` is an ISO time (the document's updated_at); a future or unreadable
 * time reads as just now. The date is in the viewer's local time.
 */
export function savedAgo(savedAt: string, now: number): string {
  const at = Date.parse(savedAt);
  const age = Number.isNaN(at) ? 0 : now - at;
  if (age < MINUTE) return "Saved just now";
  if (age < HOUR) return `Saved ${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `Saved ${Math.floor(age / HOUR)} h ago`;
  const d = new Date(at);
  return `Saved ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
