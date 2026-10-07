'use client';

import { useUser, useClerk } from '@clerk/nextjs';
import { ClipboardList, FileText, FileBarChart2, Archive, LayoutTemplate, LogOut, Workflow } from "@/components/icons";
import { Popover, PopoverTrigger, PopoverContent } from '@radix-ui/react-popover';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

// The workspace name. We don't track an org record yet, so this is the app
// name rather than fabricated org data.
const WORKSPACE_NAME = 'Sasha';

// Nav sections. Documents, Archived and Workflows have destinations; Notes, Reports and
// Templates are part of the design but not yet built, so they're shown inactive
// rather than linking nowhere.
const TABS = [
  { key: 'cases', label: 'Documents', icon: ClipboardList, href: '/' },
  { key: 'notes', label: 'Notes', icon: FileText },
  { key: 'reports', label: 'Reports', icon: FileBarChart2 },
  { key: 'archived', label: 'Archived', icon: Archive, href: '/archived' },
  { key: 'workflow', label: 'Workflows', icon: Workflow, href: '/workflows' },
  { key: 'templates', label: 'Templates', icon: LayoutTemplate },
];

export function CaseNav({ counts }: { counts?: Partial<Record<string, number>> }) {
  const pathname = usePathname();
  const { user } = useUser();
  const { signOut } = useClerk();
  const initials = (user?.fullName || user?.primaryEmailAddress?.emailAddress || 'U')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('');

  return (
    <header className="w-full border-b border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-950/80 backdrop-blur">
      <div className="mx-auto max-w-7xl flex items-center justify-between gap-4 px-4 py-3">
        <Link href="/" aria-label={WORKSPACE_NAME} className="flex items-center shrink-0 font-bold text-2xl">
          {WORKSPACE_NAME}
        </Link>

        <nav className="hidden items-center gap-1 rounded-full p-1 dark:bg-zinc-900 md:flex">
          {TABS.map(({ key, label, icon: Icon, href }) => {
            const active = !!href && (href === '/' ? pathname === '/' : pathname.startsWith(href));
            const count = counts?.[key];
            const inner = (
              <>
                <Icon className="h-4 w-4" />
                {label}
                {count !== undefined ? (
                  <span className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs font-semibold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                    {count}
                  </span>
                ) : null}
              </>
            );
            const cls = `flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[15px] font-medium ${
              active
                ? 'bg-zinc-100 text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                : href
                  ? 'text-zinc-600 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60'
                  : 'cursor-default text-zinc-400 dark:text-zinc-600'
            }`;
            return href ? (
              <Link key={key} href={href} aria-current={active ? 'page' : undefined} className={cls}>
                {inner}
              </Link>
            ) : (
              <span key={key} title="Coming soon" className={cls}>
                {inner}
              </span>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
          {user && (
            <Popover>
              <PopoverTrigger asChild>
                <button className="grid h-8 w-8 place-items-center rounded-full bg-orange-600 text-sm font-semibold text-white">
                  {initials}
                </button>
              </PopoverTrigger>
              <PopoverContent className="z-50 mr-4 mt-2 w-56 rounded-lg border bg-white dark:bg-zinc-900 p-2 shadow-lg">
                <div className="px-2 py-1.5 text-sm">
                  <div className="font-medium text-zinc-800 dark:text-zinc-100">{user.fullName}</div>
                  <div className="text-zinc-500 truncate">{user.primaryEmailAddress?.emailAddress}</div>
                </div>
                <button
                  onClick={() => signOut()}
                  className="mt-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                >
                  <LogOut className="h-4 w-4" /> Sign out
                </button>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </header>
  );
}
