import { describe, expect, it } from "vitest";
import type { ActivityItem } from "@/lib/activity/contract";
import { activitySentence, isWaiting, splitActivity, timeAgo } from "./activity-model";

const run = (id: string, status: Extract<ActivityItem, { kind: "run" }>["status"], title = "Plan"): ActivityItem => ({
  kind: "run",
  id: `run:${id}`,
  run_id: id,
  document_id: "d1",
  document_title: title,
  workflow_name: "Rubric check",
  status,
  actor: "bo@example.com",
  at: "2026-10-12T10:00:00.000Z",
  href: `/d/d1?run=${id}`,
});
const doc = (action: "created" | "edited", title = "Plan"): ActivityItem => ({
  kind: "document",
  id: "doc:d1",
  document_id: "d1",
  document_title: title,
  type_key: null,
  action,
  actor: "ann@example.com",
  at: "2026-10-12T09:00:00.000Z",
  href: "/d/d1",
});

describe("isWaiting / splitActivity", () => {
  it("puts runs awaiting review or paused under Needs you", () => {
    expect(isWaiting("awaiting_review")).toBe(true);
    expect(isWaiting("paused")).toBe(true);
    expect(isWaiting("running")).toBe(false);
    const items = [run("a", "complete"), run("b", "awaiting_review"), doc("edited"), run("c", "paused")];
    const { needsYou, rest } = splitActivity(items);
    expect(needsYou.map((i) => i.id)).toEqual(["run:b", "run:c"]);
    expect(rest.map((i) => i.id)).toEqual(["run:a", "doc:d1"]);
  });
});

describe("activitySentence", () => {
  it("reads runs and documents", () => {
    expect(activitySentence(run("a", "complete"))).toBe("Rubric check on “Plan”: Complete");
    expect(activitySentence(run("a", "paused", " "))).toBe("Rubric check on “Untitled”: Waiting for review");
    expect(activitySentence(doc("created"))).toBe("ann@example.com created “Plan”");
    expect(activitySentence(doc("edited", ""))).toBe("ann@example.com edited “Untitled”");
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-10-12T12:00:00Z").getTime();
  it("counts minutes, hours and days", () => {
    expect(timeAgo("2026-10-12T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-10-12T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-10-12T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-10-11T11:00:00Z", now)).toBe("1 day ago");
    expect(timeAgo("2026-10-08T12:00:00Z", now)).toBe("4 days ago");
  });
  it("shows the date after a week", () => {
    expect(timeAgo("2026-03-04T12:00:00Z", now)).toBe("Mar 4");
    expect(timeAgo("2025-03-04T12:00:00Z", now)).toBe("Mar 4, 2025");
  });
  it("is blank for a bad time and never negative", () => {
    expect(timeAgo("nope", now)).toBe("");
    expect(timeAgo("2026-10-12T12:05:00Z", now)).toBe("just now");
  });
});
