// Guards the palettes in globals.css against WCAG AA regressions, in both
// themes: every text/background pairing the shell, editor chrome, document
// screen and its alerts actually render must reach 4.5:1 (all of it is under
// the "large text" size), and focus rings and field borders 3:1 (non-text,
// WCAG 1.4.11). --doc-line is left out on purpose: it only draws decorative
// dividers; field borders use --doc-field-line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** The custom properties declared in the first `<selector> { ... }` block that defines `probe`. */
function tokens(selector: string, probe: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
  for (const match of css.matchAll(re)) {
    if (!match[1].includes(probe)) continue;
    const out: Record<string, string> = {};
    for (const [, name, value] of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
    return out;
  }
  throw new Error(`no ${selector} block declaring ${probe}`);
}

/** Every custom property declared in any `<selector> { ... }` block (later blocks win). */
function allTokens(selector: string): Record<string, string> {
  const re = new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "g");
  const out: Record<string, string> = {};
  for (const match of css.matchAll(re)) {
    for (const [, name, value] of match[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  }
  return out;
}

/** Linear-light sRGB channels of `oklch(L C h)` (OKLab to linear sRGB, clamped to gamut). */
function oklchToLinear(value: string): [number, number, number] {
  const m = value.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`unsupported colour ${value}`);
  const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
  const [a, b] = [C * Math.cos(h), C * Math.sin(h)];
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}

function luminance(color: string): number {
  let rgb: number[];
  if (color.startsWith("oklch(")) rgb = oklchToLinear(color);
  else {
    const h = color.replace("#", "");
    rgb = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
  }
  const [r, g, b] = rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** [text token, background token, where it shows]. */
const PAIRS: [string, string, string][] = [
  ["--go", "--go-soft", "floating button label"],
  ["--go", "--go-soft-strong", "pressed/hovered floating button label"],
  ["--go", "--editor-bg", "Share button label"],
  ["--panel-head", "--panel-bg", "panel section headers"],
  ["--panel-ink", "--panel-bg", "panel rows"],
  ["--panel-ink", "--panel-hover", "hovered panel rows"],
  ["--panel-muted", "--panel-bg", "panel secondary text"],
  ["--panel-muted", "--panel-hover", "search placeholder / hovered secondary text"],
  ["--panel-ink", "--panel-select", "pressed Archived filter"],
  ["--panel-head", "--panel-badge-bg", "Active badge"],
  ["--action", "--editor-bg", "toolbar and type picker"],
  ["--action", "--panel-bg", "panel Select / New actions"],
];

describe.each([
  ["light", tokens(":root", "--go:")],
  ["dark", tokens(".dark", "--go:")],
])("%s chrome palette", (_theme, t) => {
  it.each(PAIRS)("%s on %s (%s) reaches AA 4.5:1", (fg, bg) => {
    expect(t[fg], fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t[bg], bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
});

/** Document screen and alerts: [text token, background token, where it shows]. */
const DOC_TEXT: [string, string, string][] = [
  ["--ink", "--editor-bg", "document body and title"],
  ["--doc-muted", "--editor-bg", "save status, title placeholder"],
  ["--doc-muted", "--doc-surface", "secondary text in cards and panels"],
  ["--doc-muted", "--doc-bg", "library and catalog header links"],
  ["--doc-ink", "--doc-surface", "library and catalog text"],
  ["--doc-ink", "--doc-bg", "library and catalog header"],
  ["--doc-accent", "--editor-bg", "links in the document"],
  ["--doc-accent", "--doc-surface", "accent text and links in cards"],
  ["--doc-accent", "--doc-accent-soft", "selected chips"],
  ["--doc-on-accent", "--doc-accent", "solid accent buttons"],
  ["--doc-cite", "--editor-bg", "citation numbers"],
  ["--doc-filled", "--editor-bg", "text filled from notes"],
  ["--ink", "--doc-highlight", "highlighted text"],
  ["--doc-stale", "--doc-surface", "stale citation number"],
  ["--doc-stale", "--doc-stale-soft", "stale citation notice"],
  ["--alert-warn-ink", "--alert-warn-bg", "save conflict alert"],
  ["--alert-warn-bg", "--alert-warn-ink", "Keep mine button"],
  ["--alert-danger-ink", "--editor-bg", "save error text"],
  ["--alert-danger-ink", "--doc-surface", "error text in cards"],
  // Redesign 2 (redesign2-spec.md §2): the Tools and Outline cards and the empty-state helper.
  ["--tools-ink", "--tools-bg", "Tools card title, labels and close"],
  ["--tools-ink", "--tools-chip", "Rewrite as… chips and Tools rows"],
  ["--tools-ink", "--tools-chip-hover", "hovered chips"],
  ["--tools-ink", "--tools-field", "Custom request text"],
  ["--tools-placeholder", "--tools-field", "Try any prompt… placeholder"],
  ["--outline-ink", "--outline-card-bg", "Outline card title and rows"],
  ["--outline-ink", "--outline-hover", "hovered outline rows, Add pill"],
  ["--tools-bg", "--tools-ink", "Custom request Rewrite button"],
  ["--helper-ink", "--editor-bg", "empty-state helper text"],
  ["--helper-link", "--editor-bg", "empty-state helper links"],
];

/** Non-text (3:1): [indicator token, background token, where it shows]. */
const NON_TEXT: [string, string, string][] = [
  ["--doc-field-line", "--doc-surface", "text field borders in cards and dialogs"],
  ["--doc-field-line", "--editor-bg", "text field borders on the editor page"],
  ["--doc-accent", "--doc-surface", "focus rings in cards and dialogs"],
  ["--doc-accent", "--editor-bg", "focus rings on the editor page"],
  ["--action", "--editor-bg", "toolbar and title focus outline"],
  ["--go", "--editor-bg", "Notes / Share / floating button focus outline"],
  ["--panel-head", "--panel-bg", "documents panel focus outline"],
  ["--ring", "--background", "focus rings on shared UI controls"],
  ["--ring", "--popover", "focus rings inside popovers and menus"],
  ["--tools-focus", "--tools-bg", "focus rings inside the Tools card"],
  ["--tools-focus", "--tools-field", "focus ring on the Custom request field"],
  ["--outline-current", "--outline-card-bg", "current-section pill outline"],
  ["--outline-current", "--outline-hover", "hovered current-section pill outline"],
  ["--tools-ink", "--tools-bg", "dashed outline of disabled Tools controls"],
  ["--outline-ink", "--outline-hover", "Required tag and Choose a type borders on a hovered row"],
  ["--outline-ink", "--outline-card-bg", "focus rings inside the Outline card"],
  ["--helper-link", "--editor-bg", "helper link focus outline"],
];

describe.each([
  ["light", allTokens(":root")],
  ["dark", allTokens(".dark")],
])("%s document palette", (_theme, t) => {
  it.each(DOC_TEXT)("%s on %s (%s) reaches AA 4.5:1", (fg, bg) => {
    expect(t[fg], fg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(t[bg], bg).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(NON_TEXT)("%s against %s (%s) reaches 3:1", (fg, bg) => {
    expect(t[fg], fg).toBeTruthy();
    expect(t[bg], bg).toBeTruthy();
    expect(contrast(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe("oklch luminance", () => {
  it("matches the hex luminance of white and black", () => {
    expect(luminance("oklch(1 0 0)")).toBeCloseTo(1, 3);
    expect(luminance("oklch(0 0 0)")).toBeCloseTo(0, 5);
    expect(contrast("oklch(1 0 0)", "#000000")).toBeCloseTo(21, 1);
  });
});
