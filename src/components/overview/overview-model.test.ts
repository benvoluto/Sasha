import { describe, expect, it } from "vitest";
import {
  allSelected,
  belongsInView,
  bulkDeleteQuestion,
  displayTitle,
  documentCountLabel,
  errorMessage,
  escapeAction,
  isFlatList,
  listQuery,
  missingNotice,
  neighborAfterRemoval,
  overviewHeading,
  overviewHref,
  parseOverviewParams,
  ROOT_VIEW,
  selectionReducer,
  tabForKey,
  type OverviewView,
} from "./overview-model";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const FOLDER: OverviewView = { kind: "folder", id: ID };
const ARCHIVED: OverviewView = { kind: "archived" };
const params = (qs: string) => new URLSearchParams(qs);

describe("parseOverviewParams", () => {
  it("reads the tab and view", () => {
    expect(parseOverviewParams(params(""))).toEqual({ tab: "documents", view: ROOT_VIEW });
    expect(parseOverviewParams(params("tab=notes"))).toEqual({ tab: "notes", view: ROOT_VIEW });
    expect(parseOverviewParams(params(`folder=${ID.toUpperCase()}`))).toEqual({ tab: "documents", view: FOLDER });
    expect(parseOverviewParams(params("view=archived"))).toEqual({ tab: "documents", view: ARCHIVED });
  });
  it("ignores a malformed folder", () => {
    expect(parseOverviewParams(params("folder=nope")).view).toEqual(ROOT_VIEW);
  });
});

describe("overviewHref", () => {
  it("round-trips with parseOverviewParams", () => {
    expect(overviewHref("documents", ROOT_VIEW)).toBe("/");
    expect(overviewHref("documents", FOLDER)).toBe(`/?folder=${ID}`);
    expect(overviewHref("documents", ARCHIVED)).toBe("/?view=archived");
    expect(overviewHref("notes", FOLDER)).toBe("/?tab=notes");
  });
});

describe("listQuery", () => {
  it("asks for the top level at the root", () => {
    expect(listQuery(ROOT_VIEW, "")).toBe("folder=root&limit=200");
  });
  it("asks for the folder inside one", () => {
    expect(listQuery(FOLDER, "", 50)).toBe(`folder=${ID}&limit=50`);
  });
  it("searches across folders", () => {
    expect(listQuery(FOLDER, " plan ")).toBe("q=plan&limit=200");
    expect(isFlatList(FOLDER, " plan ")).toBe(true);
  });
  it("shows the archive across folders", () => {
    expect(listQuery(ARCHIVED, "")).toBe("archived=1&limit=200");
    expect(listQuery(ARCHIVED, "a b")).toBe("q=a+b&archived=1&limit=200");
    expect(isFlatList(ARCHIVED, "")).toBe(true);
  });
  it("treats whitespace as no search", () => {
    expect(isFlatList(ROOT_VIEW, "   ")).toBe(false);
    expect(listQuery(ROOT_VIEW, "   ")).toBe("folder=root&limit=200");
  });
});

describe("belongsInView", () => {
  it("keeps everything in a flat grid", () => {
    expect(belongsInView({ doc_folder_id: "x" }, ROOT_VIEW, true)).toBe(true);
  });
  it("keeps only unfiled documents at the root", () => {
    expect(belongsInView({ doc_folder_id: null }, ROOT_VIEW, false)).toBe(true);
    expect(belongsInView({ doc_folder_id: "x" }, ROOT_VIEW, false)).toBe(false);
  });
  it("keeps only the folder's documents inside it", () => {
    expect(belongsInView({ doc_folder_id: ID }, FOLDER, false)).toBe(true);
    expect(belongsInView({ doc_folder_id: null }, FOLDER, false)).toBe(false);
  });
});

describe("labels", () => {
  it("falls back to Untitled for blank titles", () => {
    expect(displayTitle("")).toBe("Untitled");
    expect(displayTitle("  ")).toBe("Untitled");
    expect(displayTitle(null)).toBe("Untitled");
    expect(displayTitle(" Plan ")).toBe("Plan");
  });
  it("counts documents", () => {
    expect(documentCountLabel(1)).toBe("1 document");
    expect(documentCountLabel(0)).toBe("0 documents");
    expect(bulkDeleteQuestion(3)).toBe("Delete 3 documents?");
  });
  it("names the page", () => {
    expect(overviewHeading("documents", ROOT_VIEW, null)).toBe("Documents");
    expect(overviewHeading("documents", FOLDER, "Grants")).toBe("Grants");
    expect(overviewHeading("documents", FOLDER, null)).toBe("Folder");
    expect(overviewHeading("documents", ARCHIVED, null)).toBe("Archived");
    expect(overviewHeading("notes", FOLDER, "Grants")).toBe("Notes");
  });
  it("explains skipped documents", () => {
    expect(missingNotice(0)).toBeNull();
    expect(missingNotice(1)).toMatch(/^1 document wasn't found/);
    expect(missingNotice(2)).toMatch(/^2 documents weren't found/);
  });
  it("reads a request's error", () => {
    expect(errorMessage(new Error("Nope."), "Fallback")).toBe("Nope.");
    expect(errorMessage("x", "Fallback")).toBe("Fallback");
  });
});

describe("tabForKey", () => {
  it("moves between the two tabs, wrapping", () => {
    expect(tabForKey("documents", "ArrowRight")).toBe("notes");
    expect(tabForKey("notes", "ArrowRight")).toBe("documents");
    expect(tabForKey("documents", "ArrowLeft")).toBe("notes");
    expect(tabForKey("notes", "Home")).toBe("documents");
    expect(tabForKey("documents", "End")).toBe("notes");
    expect(tabForKey("documents", "Enter")).toBeNull();
  });
});

describe("selectionReducer", () => {
  it("toggles ids in and out", () => {
    let s = selectionReducer([], { type: "toggle", id: "a" });
    s = selectionReducer(s, { type: "toggle", id: "b" });
    expect(s).toEqual(["a", "b"]);
    expect(selectionReducer(s, { type: "toggle", id: "a" })).toEqual(["b"]);
  });
  it("selects all (deduplicated) and none", () => {
    expect(selectionReducer(["a"], { type: "all", ids: ["a", "b", "b"] })).toEqual(["a", "b"]);
    expect(selectionReducer(["a"], { type: "none" })).toEqual([]);
    const empty: string[] = [];
    expect(selectionReducer(empty, { type: "none" })).toBe(empty);
  });
  it("prunes ids a bulk action finished with", () => {
    expect(selectionReducer(["a", "b", "c"], { type: "prune", ids: ["b", "z"] })).toEqual(["a", "c"]);
    const s = ["a"];
    expect(selectionReducer(s, { type: "prune", ids: ["z"] })).toBe(s);
  });
  it("retains only visible ids", () => {
    expect(selectionReducer(["a", "b"], { type: "retain", ids: ["b", "c"] })).toEqual(["b"]);
  });
  it("knows when all visible are selected", () => {
    expect(allSelected(["a", "b"], ["a", "b"])).toBe(true);
    expect(allSelected(["a"], ["a", "b"])).toBe(false);
    expect(allSelected([], [])).toBe(false);
  });
});

describe("escapeAction", () => {
  it("leaves Select mode", () => {
    expect(escapeAction({ defaultPrevented: false, guarded: false, selecting: true })).toBe("exit-select");
  });
  it("does nothing outside Select mode", () => {
    expect(escapeAction({ defaultPrevented: false, guarded: false, selecting: false })).toBe("ignore");
  });
  it("ignores handled or guarded presses", () => {
    expect(escapeAction({ defaultPrevented: true, guarded: false, selecting: true })).toBe("ignore");
    expect(escapeAction({ defaultPrevented: false, guarded: true, selecting: true })).toBe("ignore");
  });
});

describe("neighborAfterRemoval", () => {
  const ids = ["a", "b", "c", "d"];
  it("picks the next remaining card", () => {
    expect(neighborAfterRemoval(ids, ["b"])).toBe("c");
    expect(neighborAfterRemoval(ids, ["b", "c"])).toBe("d");
  });
  it("falls back to the previous card at the end", () => {
    expect(neighborAfterRemoval(ids, ["d"])).toBe("c");
    expect(neighborAfterRemoval(ids, ["c", "d"])).toBe("b");
  });
  it("is null when nothing is left or nothing was removed", () => {
    expect(neighborAfterRemoval(["a"], ["a"])).toBeNull();
    expect(neighborAfterRemoval(ids, ["z"])).toBeNull();
    expect(neighborAfterRemoval([], ["a"])).toBeNull();
  });
});
