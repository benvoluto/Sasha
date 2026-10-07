// Maps the signed-in Clerk user to the app's Auth model, so every
// human-initiated read/compute/write is attributed to the real caller and gated
// by their role's permissions.
//
// Roles come from Clerk Organizations: `org:admin` maps to "admin", any other
// org role (normally `org:member`) maps to "member". A user with no active
// organization gets DEFAULT_ROLE ("member" unless SASHA_DEFAULT_ROLE says
// otherwise).
//
// Automated, server-initiated runs (e.g. the post-extraction workflow) are not
// humans and do not use this; they carry their own system-agent identity.

import { auth, currentUser } from "@clerk/nextjs/server";
import type { Auth } from "./governance";

/** Canonical permission strings. Check these with `can(auth, PERMISSIONS.x)`. */
export const PERMISSIONS = {
  documentRead: "document:read",
  documentWrite: "document:write",
  sourceRead: "source:read",
  sourceWrite: "source:write",
  workflowRead: "workflow:read",
  workflowRun: "workflow:run",
  /** Edit workflow graphs (the /api/workflows and /api/workflow-runs routes check this string). */
  workflowEdit: "workflow:write",
  reportWrite: "report:write",
  auditRead: "audit:read",
  /** Team-wide settings (app_setting); admin only. */
  settingsWrite: "settings:write",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const MEMBER: Permission[] = [
  PERMISSIONS.documentRead,
  PERMISSIONS.documentWrite,
  PERMISSIONS.sourceRead,
  PERMISSIONS.sourceWrite,
  PERMISSIONS.workflowRead,
  PERMISSIONS.workflowRun,
  PERMISSIONS.workflowEdit,
  PERMISSIONS.reportWrite,
  PERMISSIONS.auditRead,
];

export type Role = "admin" | "member";

export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: [...MEMBER, PERMISSIONS.settingsWrite],
  member: [...MEMBER],
};

const DEFAULT_ROLE: Role = process.env.SASHA_DEFAULT_ROLE === "admin" ? "admin" : "member";

/** Clerk organization role → app role. */
export function roleFromOrgRole(orgRole: string | null | undefined): Role {
  if (!orgRole) return DEFAULT_ROLE;
  return orgRole === "org:admin" ? "admin" : "member";
}

export function permissionsForRole(role: Role): string[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * Resolve the signed-in Clerk user into an Auth. Returns null when there is no
 * signed-in user (routes are already gated by clerkMiddleware, so this is a
 * defensive 401, not the primary gate).
 */
export async function authFromClerk(): Promise<Auth | null> {
  const { userId, orgRole } = await auth();
  if (!userId) return null;

  const user = await currentUser();
  const agent = user?.primaryEmailAddress?.emailAddress ?? userId;

  return { agent, permissions: permissionsForRole(roleFromOrgRole(orgRole)) };
}
