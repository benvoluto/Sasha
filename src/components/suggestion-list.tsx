'use client';

// A document's suggested sources or data: the system's suggestions (each can be
// dismissed), items the team added (each can be removed), the dismissed ones
// (collapsed, each can be restored), and "Add item" to add one by name.

import { useState, type ReactNode } from 'react';
import { CheckCircle2, HelpCircle, Loader2, Plus, X } from '@/components/icons';
import { AddItemCombobox } from '@/components/add-item-combobox';
import { isDismissed, sameItem, type SuggestionAction, type SuggestionEdits, type SuggestionKind } from '@/lib/case-suggestions';

type Catalog = { sources: string[]; data: string[] };
const EMPTY_CATALOG: Catalog = { sources: [], data: [] };

/**
 * Known source and data names offered by "Add item". Empty until the
 * document-type catalog lands; free-text entries still work.
 */
export function useCatalog(): Catalog {
  return EMPTY_CATALOG;
}

/** Save one edit to the document's suggestions; returns its updated edits. */
export async function saveSuggestionEdit(groupId: string, kind: SuggestionKind, action: SuggestionAction, name: string): Promise<SuggestionEdits> {
  const res = await fetch(`/api/cases/${groupId}/suggestions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, action, name }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Could not save (${res.status})`);
  return body.suggestionEdits;
}

/** The suggestions still showing: the system's, less those dismissed, plus the team's own. */
export function visibleSuggestions(suggested: string[], edits: SuggestionEdits, kind: SuggestionKind): string[] {
  const own = edits.added[kind].filter((a) => !suggested.some((s) => sameItem(s, a)));
  return [...suggested.filter((s) => !isDismissed(edits, kind, s)), ...own];
}

export function SuggestionList({
  kind,
  suggested,
  edits,
  onAction,
  options,
  details,
  empty,
}: {
  kind: SuggestionKind;
  /** The system's suggestions, by name. */
  suggested: string[];
  edits: SuggestionEdits;
  onAction: (action: SuggestionAction, name: string) => Promise<void>;
  /** Names offered by "Add item". */
  options: string[];
  /** Extra detail under a suggestion, and whether it is already covered. */
  details?: (name: string) => { body?: ReactNode; done?: boolean } | undefined;
  empty: string;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const own = edits.added[kind].filter((a) => !suggested.some((s) => sameItem(s, a)));
  const showing = suggested.filter((s) => !isDismissed(edits, kind, s));
  const dismissed = suggested.filter((s) => isDismissed(edits, kind, s));
  const noun = kind === 'sources' ? 'source' : 'data item';

  const act = async (action: SuggestionAction, name: string) => {
    setPending(`${action}:${name}`);
    try {
      await onAction(action, name);
    } finally {
      setPending(null);
    }
  };

  const iconButton = (action: SuggestionAction, name: string, title: string, icon: ReactNode) => (
    <button
      type="button"
      onClick={() => act(action, name)}
      disabled={!!pending}
      title={title}
      aria-label={`${title}: ${name}`}
      className="shrink-0 rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
    >
      {pending === `${action}:${name}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      {showing.length === 0 && own.length === 0 ? <p className="text-sm text-zinc-500">{empty}</p> : null}
      {showing.map((name) => {
        const d = details?.(name);
        return (
          <div key={name} className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm ${d?.done ? 'border-zinc-200 dark:border-zinc-800' : 'border-orange-200 dark:border-orange-900/40'}`}>
            {d?.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" /> : <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />}
            <div className="min-w-0 flex-1">
              <p className={d?.done ? 'font-medium text-zinc-800 dark:text-zinc-100' : 'text-orange-700 dark:text-orange-300'}>{name}</p>
              {d?.body}
            </div>
            {iconButton('dismiss', name, `Dismiss this suggested ${noun}`, <X className="h-3.5 w-3.5" />)}
          </div>
        );
      })}
      {own.map((name) => (
        <div key={`own:${name}`} className="flex items-start gap-2 rounded-lg border border-teal-200 px-3 py-2.5 text-sm dark:border-teal-900/50">
          <Plus className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
          <span className="min-w-0 flex-1 text-teal-800 dark:text-teal-300">{name}</span>
          <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">added</span>
          {iconButton('remove', name, `Remove this ${noun}`, <X className="h-3.5 w-3.5" />)}
        </div>
      ))}
      <AddItemCombobox
        options={options}
        existing={[...showing, ...own]}
        onAdd={(name) => act('add', name)}
        placeholder={kind === 'sources' ? 'Type or choose a source…' : 'Type or choose a data item…'}
      />
      {dismissed.length > 0 && (
        <div className="text-sm">
          <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => setShowDismissed((v) => !v)}>
            {showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed
          </button>
          {showDismissed && (
            <ul className="mt-1.5 space-y-1">
              {dismissed.map((name) => (
                <li key={name} className="flex items-center gap-2 text-zinc-500">
                  <span className="min-w-0 flex-1 truncate line-through">{name}</span>
                  <button type="button" disabled={!!pending} onClick={() => act('restore', name)} className="shrink-0 text-xs text-teal-700 hover:underline disabled:opacity-50 dark:text-teal-400">
                    {pending === `restore:${name}` ? 'Restoring…' : 'Restore'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
