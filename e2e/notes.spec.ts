// The overview's Notes tab (redesign3-spec.md §7): standalone notes in the
// note dialog, every document's notes as cards that open the document on its
// Notes tab, "Start a document", and search. Notes are made through the API
// with uid() names, as the store is shared by every test.

import { createDocument, createNote, expect, openOverview, overviewTabs, patchDocument, test, uid, type Page } from "./fixtures";

const notesPanel = (page: Page) => page.getByRole("tabpanel", { name: "Notes" });
const noteDialog = (page: Page) => page.getByRole("dialog", { name: "Note" });
/** A standalone note's card: a button whose name starts with the note's title. */
const noteCard = (page: Page, title: string) => notesPanel(page).getByRole("button", { name: title });
/** A document's notes card: a link named "<doc title> notes". */
const docNotesCard = (page: Page, title: string) => notesPanel(page).getByRole("link", { name: `${title} notes` });

async function openNotesTab(page: Page) {
  await openOverview(page, "/?tab=notes");
  await expect(overviewTabs(page).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
  await expect(notesPanel(page)).toBeVisible();
}

test("the Notes tab is a tab of the overview and keeps its address", async ({ page }) => {
  await openOverview(page);
  await overviewTabs(page).getByRole("tab", { name: "Notes" }).click();
  await expect(page).toHaveURL(/[?&]tab=notes/);
  await expect(notesPanel(page)).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  // Select only belongs to the Documents tab.
  await expect(page.getByRole("button", { name: "Select", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(overviewTabs(page).getByRole("tab", { name: "Notes" })).toHaveAttribute("aria-selected", "true");
});

test("note cards sit in the same columns, at the same height, as the document cards", async ({ page, request }) => {
  await createDocument(request, { title: uid("Grid doc") });
  await page.setViewportSize({ width: 2000, height: 1200 });
  await openOverview(page);
  const box = async (cell: ReturnType<Page["locator"]>) => {
    await expect(cell).toBeVisible();
    const b = (await cell.boundingBox())!;
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width) };
  };
  const docCell = await box(page.getByRole("region", { name: "Documents" }).locator("ul > li").first());
  await overviewTabs(page).getByRole("tab", { name: "Notes" }).click();
  const noteCell = await box(notesPanel(page).locator("ul > li").first());
  expect(noteCell).toEqual(docCell);
});

test("New note: the first line becomes the card's title; edit and delete it", async ({ page }) => {
  await openNotesTab(page);
  await notesPanel(page).getByRole("button", { name: "New note" }).click();
  const dialog = noteDialog(page);
  await expect(dialog).toBeVisible();
  const field = dialog.getByRole("textbox").first();
  await expect(field).toBeVisible();
  const title = uid("Note title");
  await field.click();
  await page.keyboard.type(`${title}\nThe rest of the note.`);
  await expect(dialog.getByText(/^Saved/).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  const card = noteCard(page, title);
  await expect(card).toBeVisible();
  await expect(card).toContainText("The rest of the note.");

  // Edit: a new first line renames the card.
  await card.click();
  await expect(dialog).toBeVisible();
  await expect(field).toHaveValue(new RegExp(title));
  const retitled = uid("Note retitled");
  await field.fill(`${retitled}\nChanged body.`);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(noteCard(page, retitled)).toBeVisible();
  await expect(noteCard(page, title)).toHaveCount(0);
  // Saved on the server (closing flushes the save).
  await page.reload();
  await expect(noteCard(page, retitled)).toContainText("Changed body.");

  // Delete asks inline first.
  await noteCard(page, retitled).click();
  await dialog.getByRole("button", { name: "Delete note" }).click();
  await expect(dialog.getByText("Delete this note?")).toBeVisible();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(noteCard(page, retitled)).toHaveCount(0);
});

test("a blank new note closed without text leaves no card", async ({ page }) => {
  await openNotesTab(page);
  const before = await notesPanel(page).getByRole("button", { name: /^Untitled note/ }).count();
  await notesPanel(page).getByRole("button", { name: "New note" }).click();
  await expect(noteDialog(page)).toBeVisible();
  await noteDialog(page).getByRole("button", { name: "Done", exact: true }).click();
  await expect(noteDialog(page)).toBeHidden();
  await page.reload();
  await expect(notesPanel(page)).toBeVisible();
  await expect(notesPanel(page).getByRole("button", { name: /^Untitled note/ })).toHaveCount(before);
});

test("a document's notes show as a card that opens the document on its Notes tab", async ({ page, request }) => {
  const docTitle = uid("Doc with notes");
  const id = await createDocument(request, { title: docTitle });
  const notesTitle = uid("Doc notes line");
  await patchDocument(request, id, { notes: `${notesTitle}\nMore of the document's notes.` });

  await openNotesTab(page);
  const card = docNotesCard(page, docTitle);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("href", `/d/${id}?notes=1`);
  await expect(card).toContainText(notesTitle);
  await expect(card.locator("svg").first()).toBeVisible();

  await card.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("textbox", { name: "Notes" })).toHaveValue(new RegExp(notesTitle));
  await expect(page).toHaveURL(new RegExp(`/d/${id}$`));
});

test("Start a document turns the note into a document; its card becomes the document's notes card", async ({ page }) => {
  const title = uid("Start doc note");
  // Through the API, then into the dialog from its card.
  await createNote(page.request, `${title}\nNotes to start from.`);
  await openNotesTab(page);
  await noteCard(page, title).click();
  const dialog = noteDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Start a document" }).click();

  await expect(page).toHaveURL(/\/d\/[0-9a-f-]{36}/);
  const modal = page.getByRole("dialog");
  await expect(modal.getByRole("tab", { name: "Notes", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(modal.getByRole("textbox", { name: "Notes" })).toHaveValue(new RegExp(title));
  await expect(page.locator("#doc-title")).toHaveValue(title);

  await openNotesTab(page);
  await expect(docNotesCard(page, title)).toBeVisible();
  await expect(noteCard(page, title)).toHaveCount(0);
});

test("search filters notes and documents' notes", async ({ page, request }) => {
  const marker = uid("Notesneedle");
  const hit = `${marker} standalone`;
  await createNote(request, `${hit}\nbody`);
  const docTitle = uid("Doc notes search");
  const id = await createDocument(request, { title: docTitle });
  await patchDocument(request, id, { notes: `${marker} in a document\nbody` });
  const miss = uid("Notes haystack");
  await createNote(request, `${miss}\nbody`);

  await openNotesTab(page);
  await expect(noteCard(page, miss)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search notes" }).fill(marker);
  await expect(noteCard(page, hit)).toBeVisible();
  await expect(docNotesCard(page, docTitle)).toBeVisible();
  await expect(noteCard(page, miss)).toHaveCount(0);
  await page.getByRole("searchbox", { name: "Search notes" }).fill("");
  await expect(noteCard(page, miss)).toBeVisible();
});
