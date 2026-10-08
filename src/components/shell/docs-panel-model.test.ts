import { describe, expect, it } from "vitest";
import {
  allSelected,
  belongsInView,
  displayTitle,
  documentCountLabel,
  escapeAction,
  formatPanelDate,
  isFlatList,
  isWritingPath,
  listQuery,
  neighborAfterRemoval,
  ROOT_VIEW,
  selectionReducer,
  trapNextIndex,
  type PanelView,
} from "./docs-panel-model";

const FOLDER: PanelView = { kind: "folder", id: "0f0e0d0c-0b0a-4908-8706-050403020100", name: "Reports" };

describe("isWritingPath", () => {
  it("shows the frame on the editor, documents, library and catalog", () => {
    for (const p of ["/", "/d/abc", "/library", "/library/x", "/catalog", "/catalog/fie"]) expect(isWritingPath(p)).toBe(true);
  });
  it("steps aside elsewhere", () => {
    for (const p of ["/cases/1", "/workflows", "/sign-in", "/libraryx", "/d", "", null, undefined]) expect(isWritingPath(p)).toBe(false);
  });
});

describe("formatPanelDate", () => {
  it("formats as M/D/YYYY", () => {
    expect(formatPanelDate("2026-01-14T12:00:00")).toBe("1/14/2026");
    expect(formatPanelDate("2026-11-03T09:30:00")).toBe("11/3/2026");
  });
  it("is blank for missing or bad input", () => {
    expect(formatPanelDate("")).toBe("");
    expect(formatPanelDate(null)).toBe("");
    expect(formatPanelDate("not a date")).toBe("");
  });
});

describe("documentCountLabel", () => {
  it("is singular for one", () => {
    expect(documentCountLabel(1)).toBe("1 document");
  });
  it("is plural otherwise", () => {
    expect(documentCountLabel(0)).toBe("0 documents");
    expect(documentCountLabel(3)).toBe("3 documents");
  });
});

describe("listQuery", () => {
  it("asks for the top level at the root", () => {
    expect(listQuery(ROOT_VIEW, "", false)).toBe("folder=root");
  });
  it("asks for the folder inside one", () => {
    expect(listQuery(FOLDER, "", false)).toBe(`folder=${FOLDER.kind === "folder" ? FOLDER.id : ""}`);
  });
  it("searches across folders", () => {
    expect(listQuery(FOLDER, " plan ", false)).toBe("q=plan");
    expect(isFlatList(" plan ", false)).toBe(true);
  });
  it("shows the archive across folders", () => {
    expect(listQuery(ROOT_VIEW, "", true)).toBe("archived=1");
    expect(listQuery(FOLDER, "a b", true)).toBe("q=a+b&archived=1");
  });
  it("treats whitespace as no search", () => {
    expect(isFlatList("   ", false)).toBe(false);
    expect(listQuery(ROOT_VIEW, "   ", false)).toBe("folder=root");
  });
});

describe("belongsInView", () => {
  it("keeps everything in a flat list", () => {
    expect(belongsInView({ doc_folder_id: "x" }, ROOT_VIEW, true)).toBe(true);
  });
  it("keeps only unfiled documents at the root", () => {
    expect(belongsInView({ doc_folder_id: null }, ROOT_VIEW, false)).toBe(true);
    expect(belongsInView({ doc_folder_id: "x" }, ROOT_VIEW, false)).toBe(false);
  });
  it("keeps only the folder's documents inside it", () => {
    const id = FOLDER.kind === "folder" ? FOLDER.id : "";
    expect(belongsInView({ doc_folder_id: id }, FOLDER, false)).toBe(true);
    expect(belongsInView({ doc_folder_id: null }, FOLDER, false)).toBe(false);
  });
});

describe("displayTitle", () => {
  it("falls back for blank titles", () => {
    expect(displayTitle("")).toBe("Untitled document");
    expect(displayTitle("  ")).toBe("Untitled document");
    expect(displayTitle("Plan")).toBe("Plan");
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
  it("closes the panel by default", () => {
    expect(escapeAction({ defaultPrevented: false, guarded: false, selecting: false })).toBe("close");
  });
  it("leaves Select mode first", () => {
    expect(escapeAction({ defaultPrevented: false, guarded: false, selecting: true })).toBe("exit-select");
  });
  it("ignores handled or guarded presses", () => {
    expect(escapeAction({ defaultPrevented: true, guarded: false, selecting: false })).toBe("ignore");
    expect(escapeAction({ defaultPrevented: false, guarded: true, selecting: true })).toBe("ignore");
  });
});

describe("neighborAfterRemoval", () => {
  const ids = ["a", "b", "c", "d"];
  it("picks the next remaining row", () => {
    expect(neighborAfterRemoval(ids, ["b"])).toBe("c");
    expect(neighborAfterRemoval(ids, ["b", "c"])).toBe("d");
  });
  it("falls back to the previous row at the end of the list", () => {
    expect(neighborAfterRemoval(ids, ["d"])).toBe("c");
    expect(neighborAfterRemoval(ids, ["c", "d"])).toBe("b");
  });
  it("is null when nothing is left or nothing was removed", () => {
    expect(neighborAfterRemoval(["a"], ["a"])).toBeNull();
    expect(neighborAfterRemoval(ids, ["z"])).toBeNull();
    expect(neighborAfterRemoval([], ["a"])).toBeNull();
  });
});

describe("trapNextIndex", () => {
  it("moves forward and back, wrapping at both ends", () => {
    expect(trapNextIndex(4, 1, false)).toBe(2);
    expect(trapNextIndex(4, 3, false)).toBe(0);
    expect(trapNextIndex(4, 0, true)).toBe(3);
    expect(trapNextIndex(4, 2, true)).toBe(1);
  });
  it("treats focus outside the list (the heading) as just after the rail button", () => {
    expect(trapNextIndex(4, -1, false)).toBe(1);
    expect(trapNextIndex(4, -1, true)).toBe(0);
    expect(trapNextIndex(1, -1, false)).toBe(0);
  });
  it("is null with nothing to focus", () => {
    expect(trapNextIndex(0, -1, false)).toBeNull();
  });
});
