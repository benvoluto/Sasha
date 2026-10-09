// The print stylesheet (phase7-spec.md §4.4): one CSS for the server-rendered
// PDF and the browser's print fallback. US Letter with 1in margins, the
// document face when it is installed (no remote fonts: the page may load
// nothing), headings kept with what follows, and the citations as numbered
// endnotes (Chrome has no CSS footnotes).

export const PRINT_CSS = `
@page { size: Letter; margin: 1in; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0;
  color: #1a1a1a;
  background: #fff;
  font-family: "Hanken Grotesk Variable", "Hanken Grotesk", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
}
@media screen { body { max-width: 6.5in; margin: 0.75in auto; padding: 0 16px; } }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.5em; break-after: avoid; page-break-after: avoid; break-inside: avoid; }
h1 { font-size: 20pt; }
h2 { font-size: 15pt; }
h3 { font-size: 13pt; }
h4, h5, h6 { font-size: 11pt; }
header.doc-title h1 { margin-top: 0; font-size: 24pt; }
header.doc-title .doc-type { margin: -0.25em 0 1.5em; color: #555; font-size: 10pt; text-transform: uppercase; letter-spacing: 0.06em; }
p { margin: 0 0 0.75em; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 0.75em; padding-left: 1.5em; }
li > p { margin-bottom: 0.25em; }
blockquote { margin: 0 0 0.75em; padding-left: 1em; border-left: 3px solid #ccc; color: #444; }
pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 0.6em 0.8em; border-radius: 4px; font-size: 9.5pt; break-inside: avoid; }
code { font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 0.92em; }
p code, li code, td code { background: #f2f2f2; padding: 0 0.2em; border-radius: 3px; }
mark { background: #fff3a3; color: inherit; }
a { color: #1d4ed8; text-decoration: underline; }
hr { border: 0; border-top: 1px solid #ccc; margin: 1.5em 0; }
img { max-width: 100%; height: auto; break-inside: avoid; }
.image-missing { color: #666; font-style: italic; }
table { width: 100%; border-collapse: collapse; margin: 0 0 1em; font-size: 10pt; break-inside: auto; }
tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; font-weight: 600; }
td > p, th > p { margin: 0; }
sup.cite { font-size: 0.7em; line-height: 0; vertical-align: super; margin-left: 0.1em; }
sup.cite a { color: inherit; text-decoration: none; }
section.endnotes { margin-top: 2em; border-top: 1px solid #ccc; padding-top: 0.5em; font-size: 9.5pt; }
section.endnotes h2 { font-size: 12pt; margin-top: 0.5em; }
section.endnotes ol { padding-left: 1.8em; }
section.endnotes li { margin-bottom: 0.3em; break-inside: avoid; }
section.endnotes .stale, section.endnotes li.stale-ref { color: #8a5a00; }
section.endnotes .stale { font-style: italic; }
`.trim();
