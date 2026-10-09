// False on the server and during hydration, true once the client has taken
// over: for components whose first client render can differ from the server's
// (Clerk's UserButton renders its host <div> as soon as clerk-js is loaded,
// which after a reload with clerk-js cached can be before hydration, a
// mismatch the e2e page-error check caught). Read through an external store,
// like useSpeechToText's support flag, so it needs no effect.

import { useSyncExternalStore } from "react";

const noSubscription = () => () => {};

export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscription, () => true, () => false);
}
