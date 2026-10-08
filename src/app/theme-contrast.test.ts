// Guards the app-chrome palette in globals.css against WCAG AA regressions:
// every text/background pairing the shell and editor chrome actually render
// must reach 4.5:1 (all of it is under the "large text" size), in both themes.

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

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
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
