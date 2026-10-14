"use client";

// Sasha the dog, fixed at the bottom left of the overview and the editor
// (redesign3-spec.md §4; she lived at the foot of the app rail before redesign
// 3). Decorative, or a button while a page gives her something to do
// (dogActionAtom: the editor's empty-state helper sets "Hide Sasha's tips").
// Hidden on very short windows, where she would cover content.
//
// CONTRACT (redesign 3 foundation): mounted once by the app shell; the
// editor's empty-state helper sits beside her (DOG_WIDTH).

import { useAtomValue } from "jotai";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { dogActionAtom } from "./dog-action";

/** Her width plus her left offset (px, from sm up): the empty-state helper starts just past it. */
export const DOG_WIDTH = 88;

export function Dog() {
  const action = useAtomValue(dogActionAtom);
  if (!action) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a small static SVG; next/image adds nothing here
      <img src="/sasha.svg" alt="" width={64} height={80} draggable={false} className="pointer-events-none fixed bottom-0 left-1 z-40 w-14 select-none sm:left-4 sm:w-16 [@media(max-height:520px)]:hidden" />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={action.label}
          onClick={action.run}
          className="fixed bottom-0 left-1 z-40 block min-h-11 min-w-11 cursor-pointer rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)] sm:left-4 [@media(max-height:520px)]:hidden"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- a small static SVG; next/image adds nothing here */}
          <img src="/sasha.svg" alt="" width={64} height={80} draggable={false} className="block w-14 select-none sm:w-16" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {action.label}
      </TooltipContent>
    </Tooltip>
  );
}
