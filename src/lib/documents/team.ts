// The caller's team. Documents, sources and workflows are shared team-wide:
// the team is the active Clerk organization, or a personal team for a user who
// has no organization yet.

import { auth, currentUser } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { DEV_USER, devAuthBypass } from "@/lib/dev-auth";
import { can, type Auth } from "@/lib/ontology/governance";
import { permissionsForRole, roleFromOrgRole, type Permission } from "@/lib/ontology/permissions";

export type TeamCaller = Auth & { userId: string; teamId: string; orgId: string | null };

export function teamIdFor(userId: string, orgId: string | null | undefined): string {
  return orgId ? `org:${orgId}` : `user:${userId}`;
}

export async function callerTeam(): Promise<TeamCaller | null> {
  if (devAuthBypass()) {
    return { userId: DEV_USER.userId, orgId: null, teamId: teamIdFor(DEV_USER.userId, null), agent: DEV_USER.email, permissions: permissionsForRole("admin") };
  }
  const { userId, orgId, orgRole } = await auth();
  if (!userId) return null;
  const user = await currentUser();
  return {
    userId,
    orgId: orgId ?? null,
    teamId: teamIdFor(userId, orgId),
    agent: user?.primaryEmailAddress?.emailAddress ?? userId,
    permissions: permissionsForRole(roleFromOrgRole(orgRole)),
  };
}

/** Resolve the caller and check a permission; returns a ready error response when either fails. */
export async function requireTeam(permission: Permission): Promise<TeamCaller | NextResponse> {
  const caller = await callerTeam();
  if (!caller) return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  if (!can(caller, permission)) return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
  return caller;
}
