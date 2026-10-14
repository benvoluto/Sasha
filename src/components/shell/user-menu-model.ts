// Small pure pieces of the account menu (user-menu.tsx), tested directly.

/** The Team radio value for the user's own workspace (no organization). */
export const PERSONAL_TEAM = "personal";

/** Up to two initials for the avatar when there is no picture: "Ann Lee" → "AL", "bo@x.org" → "B". */
export function initialsFor(name: string, email = ""): string {
  const words = name.includes("@") ? [] : name.trim().split(/\s+/).filter(Boolean);
  if (words.length) return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  const first = (email || name).trim()[0];
  return first ? first.toUpperCase() : "?";
}
