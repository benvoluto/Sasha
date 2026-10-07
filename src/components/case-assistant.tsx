"use client";

// Read-only document assistant chat. Sends the conversation to the in-process
// agent loop (/api/assistant/[groupId]); the model reads the document's source
// files via its tools and explains them. It cannot write — that's enforced
// server-side, not here.

import { useRef, useState } from "react";
import { Send, Loader2, Sparkles, ShieldCheck } from "@/components/icons";
import { MarkdownView } from "@/components/markdown-view";

type Msg = { role: "user" | "assistant"; content: string };
type Trace = { tool: string; target: string; ok: boolean };

const SUGGESTIONS = [
  "Summarize the uploaded sources.",
  "What are the key facts and figures in the sources?",
  "What's missing that I should still find?",
];

/**
 * `rail` is the narrow, always-present form in the document sidebar: the assistant
 * has to be reachable from every section, so it lives beside the document rather
 * than behind a tab. It drops the explanatory banner and starts as a single
 * prompt box that grows into a transcript once there's something to show.
 */
export function CaseAssistant({ groupId, variant = "panel" }: { groupId: string; variant?: "panel" | "rail" }) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastTrace, setLastTrace] = useState<Trace[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const next = [...messages, { role: "user" as const, content: question }];
    setMessages(next);
    setInput("");
    setBusy(true);
    setLastTrace([]);
    try {
      const res = await fetch(`/api/assistant/${groupId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json().catch(() => ({}));
      const answer = res.ok ? data.answer : `Sorry — ${data.error ?? "the assistant failed."}`;
      setMessages((m) => [...m, { role: "assistant", content: String(answer) }]);
      setLastTrace(Array.isArray(data.trace) ? data.trace : []);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — the assistant is unreachable right now." }]);
    } finally {
      setBusy(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }));
    }
  };

  const rail = variant === "rail";

  if (rail && messages.length === 0 && !busy) {
    // Resting state in the sidebar: the prompt box from the design, filling the
    // height the rail gave it, with the starter questions underneath.
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-2.5">
        <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex min-h-0 flex-1">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send(input);
              }
            }}
            placeholder="Try any prompt…"
            className="w-full flex-1 resize-none rounded-xl border border-transparent bg-zinc-200/70 px-3.5 py-3 text-[15px] text-zinc-700 outline-none placeholder:text-zinc-500 focus:border-teal-400 focus:bg-white dark:bg-zinc-800 dark:text-zinc-100 dark:placeholder:text-zinc-400 dark:focus:bg-zinc-900"
          />
        </form>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="rounded-full border border-zinc-300/70 px-2.5 py-1 text-left text-xs text-zinc-500 hover:border-teal-400 hover:text-teal-700 dark:border-zinc-700 dark:text-zinc-400"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${rail ? "min-h-0 flex-1" : ""}`}>
      {rail ? null : (
        <div className="flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400">
          <ShieldCheck className="h-4 w-4 text-teal-600" />
          Read-only. The assistant reads this document&apos;s sources — it never changes anything, and every read is audited.
        </div>
      )}

      <div
        ref={scrollRef}
        className={`flex flex-col gap-3 overflow-y-auto rounded-xl border border-zinc-200 dark:border-zinc-800 p-4 ${
          // In the rail the transcript takes the leftover height rather than a
          // fixed max: a capped box meant a long answer scrolled inside a short
          // window while the space below it sat empty.
          rail ? "min-h-0 flex-1 bg-white/60 dark:bg-zinc-900/40" : "max-h-[28rem] min-h-[12rem]"
        }`}
      >
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-start justify-center gap-2 text-sm text-zinc-500">
            <div className="flex items-center gap-2 text-zinc-400"><Sparkles className="h-4 w-4" /> Ask about this document</div>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => send(s)} className="rounded-full border border-zinc-200 dark:border-zinc-700 px-3 py-1.5 text-xs text-zinc-600 dark:text-zinc-300 hover:border-teal-400 hover:text-teal-700">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] min-w-0 rounded-2xl px-3.5 py-2 text-sm ${m.role === "user" ? "whitespace-pre-wrap bg-teal-600 text-white" : "bg-zinc-100 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100"}`}>
                {/* The model answers in markdown. Rendering it as plain text put
                    literal **bold** and bullet syntax in front of the user. */}
                {m.role === "user" ? m.content : <MarkdownView markdown={m.content} variant="chat" />}
              </div>
            </div>
          ))
        )}
        {busy ? (
          <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading the sources…</div>
        ) : null}
      </div>

      {lastTrace.length > 0 ? (
        <p className="shrink-0 text-xs text-zinc-400">
          Read: {lastTrace.map((t) => t.target || t.tool).filter(Boolean).join(", ")}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="flex shrink-0 items-center gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about this document…"
          disabled={busy}
          className="flex-1 rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2.5 text-sm outline-none focus:border-teal-400"
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          aria-label="Send"
          className="flex items-center gap-1.5 rounded-full bg-teal-600 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50"
        >
          <Send className="h-4 w-4" /> {rail ? null : "Send"}
        </button>
      </form>
    </div>
  );
}
