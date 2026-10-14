"use client";

// The formatting toolbar in the sticky row under the header (redesign3-spec.md
// §11): blue icons in groups (history | paragraph style | marks | table |
// alignment and lists | more), then `trailing` (the save status). The buttons
// scroll sideways inside their own row on narrow screens (the page never
// does); the save status stays outside that scroller, always in view.

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
  FileText,
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
  Trash2,
  Underline,
  Undo2,
} from "@/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type IconType = ComponentType<{ className?: string }>;

const FOCUS_RING = "focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--action)]";
/** 44px on phones (the touch target), 36px from sm, as in the mockup. */
const ICON_BOX = "grid h-11 w-11 shrink-0 place-items-center rounded-lg text-[var(--action)] sm:h-9 sm:w-9";
const ICON_BUTTON = `${ICON_BOX} hover:bg-[var(--action-soft)] data-[state=open]:bg-[var(--action-soft)] ${FOCUS_RING}`;

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
      className={`${ICON_BOX} transition-colors hover:bg-[var(--action-soft)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent motion-reduce:transition-none ${FOCUS_RING} ${
        active ? "bg-[var(--action-soft)]" : ""
      }`}
    >
      <Icon className="h-[22px] w-[22px]" />
    </button>
  );
}

const Group = ({ children }: { children: ReactNode }) => <div className="flex shrink-0 items-center gap-x-0.5 sm:gap-x-3">{children}</div>;

// Checked in this order, so a quote or code block wins over the paragraph inside it.
const BLOCKS = [
  { label: "Quote", is: (e: Editor) => e.isActive("blockquote"), run: (e: Editor) => e.chain().focus().toggleBlockquote().run() },
  { label: "Code block", is: (e: Editor) => e.isActive("codeBlock"), run: (e: Editor) => e.chain().focus().toggleCodeBlock().run() },
  { label: "Heading 1", is: (e: Editor) => e.isActive("heading", { level: 1 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 1 }).run() },
  { label: "Heading 2", is: (e: Editor) => e.isActive("heading", { level: 2 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 2 }).run() },
  { label: "Heading 3", is: (e: Editor) => e.isActive("heading", { level: 3 }), run: (e: Editor) => e.chain().focus().setHeading({ level: 3 }).run() },
  // Paragraph also takes the text out of a quote.
  { label: "Paragraph", is: (e: Editor) => e.isActive("paragraph"), run: (e: Editor) => (e.isActive("blockquote") ? e.chain().focus().setParagraph().lift("blockquote").run() : e.chain().focus().setParagraph().run()) },
];
/** The menu's order (the mockup's): body text first, then headings, then the rest. */
const MENU_ORDER = ["Paragraph", "Heading 1", "Heading 2", "Heading 3", "Quote", "Code block"];

/**
 * The paragraph-style picker: a bordered box with a page icon and up/down
 * caret (the icon alone is visible; the accessible name says the current style)
 * opening a radio menu with the current style checked.
 */
function BlockPicker({ editor }: { editor: Editor }) {
  const current = BLOCKS.find((b) => b.is(editor))?.label ?? "Paragraph";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={`Paragraph style: ${current}`}
          aria-label={`Paragraph style: ${current}`}
          onMouseDown={(e) => e.preventDefault()}
          className={`flex h-11 shrink-0 items-center gap-1 rounded-lg border border-[var(--doc-field-line)] bg-[var(--editor-bg)] px-2 text-[var(--ink)] transition-colors hover:bg-[var(--action-soft)] data-[state=open]:bg-[var(--action-soft)] motion-reduce:transition-none sm:h-10 ${FOCUS_RING}`}
        >
          <FileText className="h-[22px] w-[22px]" />
          <CaretUpDown className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-44">
        <DropdownMenuRadioGroup value={current} onValueChange={(label) => BLOCKS.find((b) => b.label === label)?.run(editor)}>
          {MENU_ORDER.map((label) => (
            <DropdownMenuRadioItem key={label} value={label} className="min-h-11 sm:min-h-8">
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
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
          className={ICON_BUTTON}
        >
          <Icon className="h-[22px] w-[22px]" />
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
          className={ICON_BUTTON}
        >
          <MoreHorizontalIcon className="h-[22px] w-[22px]" />
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

/**
 * `locked` (tell me is drafting) disables every control: the editor is
 * read-only then, but commands such as Undo would still change the document
 * under the drafts. A disabled fieldset disables all the buttons inside it.
 */
export function EditorToolbar({
  editor,
  onLink,
  locked = false,
  trailing,
}: {
  editor: Editor;
  onLink: () => void;
  locked?: boolean;
  /** After the More menu, outside the disabled fieldset and the scroller: the save status (save-status.tsx). */
  trailing?: ReactNode;
}) {
  const c = () => editor.chain().focus();
  const inTable = editor.isActive("table");
  return (
    // The save status sits beside the scrolling toolbar, not inside it, so it
    // stays in view when the buttons overflow (a tablet, the drawer layout). On
    // a phone it drops to a line of its own so the buttons keep the width.
    <div className="flex max-w-full flex-wrap items-center sm:flex-nowrap">
      {/* The small padding keeps focus outlines clear of the scroll container's clip edge. */}
      <div role="toolbar" aria-label="Formatting" className="flex w-full min-w-0 items-center overflow-x-auto p-1 [scrollbar-width:thin] sm:w-auto">
        <fieldset disabled={locked} className="m-0 flex w-max min-w-0 shrink-0 items-center gap-x-3 border-0 p-0 sm:gap-x-5 lg:gap-x-8">
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
        </fieldset>
      </div>
      {trailing && <div className="ml-1 flex shrink-0 items-center pr-1 sm:ml-6 lg:ml-10">{trailing}</div>}
    </div>
  );
}
