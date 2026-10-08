// What the classifier chip shows, from the stored result (phase4-spec.md §3.3).
// Pure and client-safe: candidates outside the team's enabled types, types the
// person turned down three times (or just now), and freeform results show
// nothing. A typed document only hears about a strong drift to another type.

import {
  CHIP_ALT_MIN_CONFIDENCE,
  CHIP_MIN_CONFIDENCE,
  CLASSIFY_MAX_DISMISSALS,
  DRIFT_CHIP_MIN_CONFIDENCE,
  DRIFT_MAX_CURRENT,
  type ChipInput,
  type ChipSuggestion,
} from "./contract";

export function chipSuggestion(i: ChipInput): ChipSuggestion | null {
  const last = i.state.last;
  if (!last || last.freeform) return null;
  const blocked = (key: string) => (i.state.dismissals[key] ?? 0) >= CLASSIFY_MAX_DISMISSALS || !!i.locallyDismissed?.has(key);
  const candidates = [...last.candidates]
    .filter((c) => i.titles.has(c.key) && !blocked(c.key))
    .sort((a, b) => b.confidence - a.confidence);
  const top = candidates[0];
  if (!top) return null;

  if (i.typeKey === null) {
    if (top.confidence < CHIP_MIN_CONFIDENCE) return null;
  } else {
    const current = last.candidates.find((c) => c.key === i.typeKey)?.confidence ?? 0;
    if (last.trigger !== "drift" || top.key === i.typeKey || top.confidence < DRIFT_CHIP_MIN_CONFIDENCE || current > DRIFT_MAX_CURRENT) return null;
  }

  const alternatives = candidates
    .slice(1)
    .filter((c) => c.key !== i.typeKey && c.confidence >= CHIP_ALT_MIN_CONFIDENCE)
    .map((c) => ({ key: c.key, title: i.titles.get(c.key)!, confidence: c.confidence, why: c.why }));
  return { key: top.key, title: i.titles.get(top.key)!, confidence: top.confidence, why: top.why, alternatives };
}
