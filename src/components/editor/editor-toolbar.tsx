"use client";

// The formatting toolbar across the top of the document card.

import type { Editor } from "@tiptap/react";
import type { ComponentType, ReactNode } from "react";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  CaretUpDown,
  Code,
  Eraser,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  MoreHorizontalIcon,
  Quotes,
  Redo2,
  Strikethrough,
  Table,
  TextT,
  Trash2,
  Underline,
  Undo2,
} from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type IconType = ComponentType<{ className?: string }>;

function ToolButton({ icon: Icon, label, onClick, active, disabled }: { icon: IconType; label: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`grid h-9 w-9 place-items-center rounded-lg text-[var(--doc-accent)] transition-colors hover:bg-[var(--doc-accent-soft)] disabled:cursor-not-allowed disabled:opacity-35 ${
        active ? "bg-[var(--doc-accent-soft)]" : ""
      }`}
    >
      <Icon className="h-5 w-5" />
    </button>
  );
}

const Group = ({ children }: { children: ReactNode }) => <div className="flex items-center gap-0.5">{children}</div>;

const BLOCKS = [
  { label: "Paragraph", is: (e: Editor) => e.isActive("paragraph"), run: (e: Editor) => e.chain().focus().setParagraph().run() },
  { label: "Heading 1", is: (e: Editor) => e.isActive("heading", { level: 1 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", is: (e: Editor) => e.isActive("heading", { level: 2 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", is: (e: Editor) => e.isActive("heading", { level: 3 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run() },
  { label: "Quote", is: (e: Editor) => e.isActive("blockquote"), run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code block", is: (e: Editor) => e.isActive("codeBlock"), run: (e: Editor) => e.chain().focus().toggleCodeBlock().run() },
];

function BlockPicker({ editor }: { editor: Editor }) {
  const current = BLOCKS.find((b) => b.is(editor))?.label ?? "Paragraph";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Text style: ${current}`}
          aria-label={`Text style: ${current}`}
          onMouseDown={(e) => e.preventDefault()}
          className="flex h-9 items-center gap-1 rounded-lg border border-[var(--doc-line)] bg-[var(--doc-surface)] px-2 text-[var(--doc-ink)] shadow-sm hover:bg-[var(--doc-accent-soft)]"
        >
          <TextT className="h-5 w-5" />
          <CaretUpDown className="h-4 w-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {BLOCKS.map((b) => (
          <DropdownMenuItem key={b.label} onSelect={() => b.run(editor)} className={b.label === current ? "font-semibold" : ""}>
            {b.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AlignMenu({ editor }: { editor: Editor }) {
  const options = [
    { value: "left", label: "Align left", icon: AlignLeft },
    { value: "center", label: "Center", icon: AlignCenter },
    { value: "right", label: "Align right", icon: AlignRight },
    { value: "justify", label: "Justify", icon: AlignJustify },
  ] as const;
  const current = options.find((o) => editor.isActive({ textAlign: o.value })) ?? options[0];
  const Icon = current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Alignment"
          aria-label="Alignment"
          onMouseDown={(e) => e.preventDefault()}
          className="grid h-9 w-9 place-items-center rounded-lg text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
        >
          <Icon className="h-5 w-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => editor.chain().focus().setTextAlign(o.value).run()}>
            <o.icon className="h-4 w-4" /> {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MoreMenu({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const inTable = editor.isActive("table");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="More"
          aria-label="More formatting"
          onMouseDown={(e) => e.preventDefault()}
          className="grid h-9 w-9 place-items-center rounded-lg text-[var(--doc-accent)] hover:bg-[var(--doc-accent-soft)]"
        >
          <MoreHorizontalIcon className="h-5 w-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuItem onSelect={onLink}>
          <Link2 className="h-4 w-4" /> Link…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quotes className="h-4 w-4" /> Quote
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => editor.chain().focus().setHorizontalRule().run()}>
          <Minus className="h-4 w-4" /> Divider line
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          <Eraser className="h-4 w-4" /> Clear formatting
        </DropdownMenuItem>
        {inTable && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => editor.chain().focus().addRowAfter().run()}>Add row below</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.chain().focus().addColumnAfter().run()}>Add column right</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.chain().focus().deleteRow().run()}>Delete row</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.chain().focus().deleteColumn().run()}>Delete column</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => editor.chain().focus().toggleHeaderRow().run()}>Toggle header row</DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function EditorToolbar({ editor, onLink }: { editor: Editor; onLink: () => void }) {
  const c = () => editor.chain().focus();
  const inTable = editor.isActive("table");
  return (
    <div role="toolbar" aria-label="Formatting" className="flex w-max items-center gap-x-4 gap-y-1 md:w-auto md:flex-wrap md:justify-center">
      <Group>
        <ToolButton icon={Undo2} label="Undo" onClick={() => c().undo().run()} disabled={!editor.can().undo()} />
        <ToolButton icon={Redo2} label="Redo" onClick={() => c().redo().run()} disabled={!editor.can().redo()} />
      </Group>
      <BlockPicker editor={editor} />
      <Group>
        <ToolButton icon={Bold} label="Bold" active={editor.isActive("bold")} onClick={() => c().toggleBold().run()} />
        <ToolButton icon={Italic} label="Italic" active={editor.isActive("italic")} onClick={() => c().toggleItalic().run()} />
        <ToolButton icon={Strikethrough} label="Strikethrough" active={editor.isActive("strike")} onClick={() => c().toggleStrike().run()} />
        <ToolButton icon={Underline} label="Underline" active={editor.isActive("underline")} onClick={() => c().toggleUnderline().run()} />
        <ToolButton icon={Highlighter} label="Highlight" active={editor.isActive("highlight")} onClick={() => c().toggleHighlight().run()} />
        <ToolButton icon={Code} label="Code" active={editor.isActive("code")} onClick={() => c().toggleCode().run()} />
      </Group>
      <Group>
        <ToolButton icon={Table} label="Insert table" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} disabled={inTable} />
        <ToolButton icon={Trash2} label="Delete table" onClick={() => c().deleteTable().run()} disabled={!inTable} />
      </Group>
      <Group>
        <AlignMenu editor={editor} />
        <ToolButton icon={List} label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()} />
        <ToolButton icon={ListOrdered} label="Numbered list" active={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()} />
      </Group>
      <MoreMenu editor={editor} onLink={onLink} />
    </div>
  );
}
