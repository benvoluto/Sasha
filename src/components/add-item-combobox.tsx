'use client';

// "Add item" for a document's suggested sources or data: type to filter the names
// the app knows, pick one from the list, or add exactly what was typed.

import { useState } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Loader2, Plus } from '@/components/icons';
import { sameItem } from '@/lib/case-suggestions';

export function AddItemCombobox({
  options,
  existing,
  onAdd,
  label = 'Add item',
  placeholder = 'Type or choose…',
}: {
  options: string[];
  /** Names already on the list; hidden from the choices. */
  existing: string[];
  onAdd: (name: string) => Promise<void>;
  label?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const choices = options.filter((o) => !existing.some((e) => sameItem(e, o)));
  const typed = query.trim();
  const canAddTyped = !!typed && !options.some((o) => sameItem(o, typed)) && !existing.some((e) => sameItem(e, typed));

  const add = async (name: string) => {
    setBusy(true);
    try {
      await onAdd(name);
      setQuery('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={busy}
          className="flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-sm text-zinc-600 hover:border-teal-400 hover:text-teal-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-teal-400"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} {label}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={placeholder} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{typed ? 'No match in the list.' : 'Nothing left to add.'}</CommandEmpty>
            {canAddTyped && (
              <CommandGroup>
                {/* The value carries the query so the list's own filter always keeps this row. */}
                <CommandItem value={`add:${typed}`} onSelect={() => add(typed)}>
                  <Plus className="h-4 w-4" /> Add &ldquo;{typed}&rdquo;
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Known items">
              {choices.map((o) => (
                <CommandItem key={o} value={o} onSelect={() => add(o)}>
                  {o}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
