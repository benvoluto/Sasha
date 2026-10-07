import { auth, currentUser } from "@clerk/nextjs/server";

/**
 * Clerk-backed server-side auth helpers.
 *
 * `clerkMiddleware` (src/middleware.ts) already rejects unauthenticated requests
 * before they reach a route handler, so these are for resolving the caller's
 * identity inside a handler — not for gating (the middleware does that).
 */

/** The signed-in user's Clerk id, or null. */
export async function getUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId ?? null;
}

/**
 * A stable identifier for the caller, preferring their primary email (used as
 * the ownership key on uploads and settings) and falling back to the Clerk id.
 * Returns null only when there is no signed-in user.
 */
export async function getUserIdentifier(): Promise<string | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress ?? userId;
}
