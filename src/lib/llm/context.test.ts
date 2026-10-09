import { describe, expect, it } from "vitest";
import { contextFor, currentModelContext, enterModelContext, withModelContext } from "./context";

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("model context", () => {
  it("is null outside any context", () => {
    expect(currentModelContext()).toBeNull();
  });

  it("reaches through awaits, timers and promise chains", async () => {
    const seen = await withModelContext({ teamId: "org:a", userId: "u1", agent: "ann" }, async () => {
      await tick();
      return Promise.resolve()
        .then(() => tick())
        .then(() => currentModelContext());
    });
    expect(seen).toEqual({ teamId: "org:a", userId: "u1", agent: "ann" });
    expect(currentModelContext()).toBeNull();
  });

  it("merges an inner context over the outer one", async () => {
    await withModelContext({ teamId: "org:a", userId: "u1", agent: "ann", documentId: "d1" }, async () => {
      const inner = await withModelContext({ teamId: "org:a", userId: "u1", runId: "r1" }, async () => currentModelContext());
      expect(inner).toEqual({ teamId: "org:a", userId: "u1", agent: "ann", documentId: "d1", runId: "r1" });
      expect(currentModelContext()?.runId).toBeUndefined();
    });
  });

  it("enterModelContext holds for the rest of the async call that entered it, including work started later", async () => {
    let background: Promise<unknown> | null = null;
    async function route() {
      enterModelContext(contextFor({ teamId: "org:b", userId: "u2", agent: "bo" }, { documentId: "d2" }));
      await tick();
      background = tick().then(() => currentModelContext());
      return currentModelContext();
    }
    expect(await route()).toEqual({ teamId: "org:b", userId: "u2", agent: "bo", documentId: "d2" });
    expect(await background).toMatchObject({ teamId: "org:b", documentId: "d2" });
  });

  it("keeps concurrent requests apart", async () => {
    const run = (teamId: string) =>
      withModelContext({ teamId, userId: teamId }, async () => {
        await tick();
        return currentModelContext()?.teamId;
      });
    expect(await Promise.all([run("org:a"), run("org:b"), run("org:c")])).toEqual(["org:a", "org:b", "org:c"]);
  });
});
