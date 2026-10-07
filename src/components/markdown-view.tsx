"use client";

// Renders report markdown as styled HTML inline. Elements are styled explicitly
// (no typography plugin needed). Content is app-generated determination markdown;
// react-markdown does not render raw HTML, so there is no injection surface.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  h1: ({ children }) => <h1 className="mb-3 mt-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-4 text-sm font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-300">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{children}</h3>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{children}</p>,
  ul: ({ children }) => <ul className="my-2 ml-5 list-disc space-y-1 text-sm text-zinc-700 dark:text-zinc-300">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 ml-5 list-decimal space-y-1 text-sm text-zinc-700 dark:text-zinc-300">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{children}</strong>,
  em: ({ children }) => <em className="text-zinc-500 dark:text-zinc-400">{children}</em>,
  hr: () => <hr className="my-4 border-zinc-200 dark:border-zinc-800" />,
  a: ({ children, href }) => (
    <a href={href} className="text-teal-700 underline dark:text-teal-300" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-zinc-200 dark:border-zinc-800 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-zinc-200 dark:border-zinc-800 px-2 py-1">{children}</td>,
  code: ({ children }) => <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 text-[12px]">{children}</code>,
};

/**
 * Chat answers sit in a coloured bubble in a narrow rail, so they inherit the
 * bubble's colour rather than setting their own, drop the report's uppercase
 * teal headings, and tighten the vertical rhythm. Long tokens wrap instead of
 * widening the bubble.
 */
const chatComponents: Components = {
  ...components,
  h1: ({ children }) => <h1 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1 mt-2.5 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 text-sm leading-relaxed first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5 text-sm">{children}</ol>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic opacity-80">{children}</em>,
  hr: () => <hr className="my-2.5 border-current opacity-20" />,
  a: ({ children, href }) => (
    <a href={href} className="underline underline-offset-2" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  code: ({ children }) => <code className="rounded bg-black/5 px-1 py-0.5 text-[12px] dark:bg-white/10">{children}</code>,
};

export function MarkdownView({ markdown, variant = "report" }: { markdown: string; variant?: "report" | "chat" }) {
  return (
    <div className={variant === "chat" ? "max-w-none break-words" : "max-w-none"}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={variant === "chat" ? chatComponents : components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
