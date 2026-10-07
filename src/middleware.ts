import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Everything except Clerk's own auth routes and Next internals requires a
// signed-in user. Unauthenticated requests to a page are redirected to sign-in;
// unauthenticated requests to an API route get a 404 from Clerk's protect().
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)"]);

// Server-to-server callers (scripts, schema setup) carry no Clerk session. When
// INTERNAL_API_TOKEN is configured, a request bearing it in x-internal-token is
// allowed through on these routes. The seam is inert until that env var is set.
const isInternalRoute = createRouteMatcher(["/api/ontology(.*)"]);

function hasValidInternalToken(req: Request): boolean {
  const expected = process.env.INTERNAL_API_TOKEN;
  return !!expected && req.headers.get("x-internal-token") === expected;
}

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  if (isInternalRoute(req) && hasValidInternalToken(req)) return;
  await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
