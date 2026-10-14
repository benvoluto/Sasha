"use client";

// The account menu at the top right of the overview, Activity, the library,
// the catalog, usage and the workflow canvas (redesign3-spec.md §4): who is
// signed in, the team switch (Personal workspace or one of the user's
// organizations), Clerk's team management, links to Usage and Document types,
// Appearance, and Sign out.
//
// It is a non-modal menu, so Clerk's own modals (Manage teams, Create a team)
// can take focus once it closes. Under the dev auth bypass Clerk's hooks are
// never called (they would open Clerk's "Organizations feature required"
// modal): DevUserMenu renders the same menu without the team items or Sign out.

import { useClerk, useOrganization, useOrganizationList, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useTheme } from "next-themes";
import { useState, type ReactNode } from "react";
import { useDevAuthBypass } from "@/components/dev-auth-context";
import { LogOut, TeamIcon, TypesIcon, UsageIcon } from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEV_USER } from "@/lib/dev-auth";
import { initialsFor, PERSONAL_TEAM } from "./user-menu-model";

const TRIGGER =
  "grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full bg-[var(--action-soft)] text-[15px] font-semibold text-[var(--action)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] sm:h-10 sm:w-10";

export function UserMenu() {
  return useDevAuthBypass() ? <DevUserMenu /> : <ClerkUserMenu />;
}

function DevUserMenu() {
  return <MenuFrame name="Dev user" email={DEV_USER.email} imageUrl={null} />;
}

function ClerkUserMenu() {
  const { user } = useUser();
  const { organization } = useOrganization();
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: { infinite: true } });
  const clerk = useClerk();
  const [switching, setSwitching] = useState(false);
  const memberships = userMemberships?.data ?? [];
  const email = user?.primaryEmailAddress?.emailAddress ?? "";
  const name = user?.fullName || user?.username || email || "Account";

  const team = (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">Team</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        aria-label="Team"
        value={organization?.id ?? PERSONAL_TEAM}
        onValueChange={async (value) => {
          if (switching || !isLoaded) return;
          setSwitching(true);
          try {
            await setActive?.({ organization: value === PERSONAL_TEAM ? null : value });
            // Everything on screen belongs to the team it was loaded for: start over at home.
            window.location.assign("/");
          } catch {
            setSwitching(false);
          }
        }}
      >
        <DropdownMenuRadioItem value={PERSONAL_TEAM} disabled={switching}>
          Personal workspace
        </DropdownMenuRadioItem>
        {memberships.map((m) => (
          <DropdownMenuRadioItem key={m.organization.id} value={m.organization.id} disabled={switching}>
            <span className="truncate">{m.organization.name}</span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuItem
        onSelect={() => {
          if (organization) clerk.openOrganizationProfile();
          else clerk.openCreateOrganization({ afterCreateOrganizationUrl: "/" });
        }}
      >
        <TeamIcon className="h-4 w-4" /> {organization ? "Manage teams" : "Create a team"}
      </DropdownMenuItem>
    </>
  );

  return <MenuFrame name={name} email={email} imageUrl={user?.hasImage ? user.imageUrl : null} team={team} onSignOut={() => void clerk.signOut({ redirectUrl: "/sign-in" })} />;
}

function MenuFrame({ name, email, imageUrl, team, onSignOut }: { name: string; email: string; imageUrl: string | null; team?: ReactNode; onSignOut?: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Account menu" className={TRIGGER}>
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- Clerk's avatar URL; next/image would need its host configured
            <img src={imageUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <span aria-hidden>{initialsFor(name, email)}</span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-sm font-semibold">{name}</span>
          {email && email !== name && <span className="block truncate text-xs text-muted-foreground">{email}</span>}
        </DropdownMenuLabel>
        {team}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="/usage">
              <UsageIcon className="h-4 w-4" /> Usage
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/catalog">
              <TypesIcon className="h-4 w-4" /> Document types
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-semibold text-muted-foreground">Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup aria-label="Appearance" value={theme ?? "system"} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        {onSignOut && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onSignOut}>
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
