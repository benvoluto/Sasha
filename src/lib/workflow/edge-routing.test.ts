import { describe, expect, it } from "vitest";
import { fitEndpoints, haloPath, LANE_GAP, routeEdges, sharedStretches, STUB, type EdgeGeom, type Point, type Rect } from "./edge-routing";

const rect = (x: number, y: number, width = 300, height = 100): Rect => ({ x, y, width, height });
const edge = (id: string, source: string, port: string, target: string, sx: number, sy: number, tx: number, ty: number): EdgeGeom => ({
  id,
  source,
  sourceKey: `${source}:${port}`,
  target,
  targetKey: `${target}:in`,
  sx,
  sy,
  tx,
  ty,
});

/** The y of a route's first horizontal run. */
const runY = (pts: Point[]) => pts.find((p, i) => i > 0 && pts[i + 1] && p[1] === pts[i + 1][1])![1];

function crossesRect(pts: Point[], r: Rect): boolean {
  return pts.slice(1).some((b, i) => {
    const a = pts[i];
    return Math.min(a[0], b[0]) < r.x + r.width && Math.max(a[0], b[0]) > r.x && Math.min(a[1], b[1]) < r.y + r.height && Math.max(a[1], b[1]) > r.y;
  });
}

describe("routeEdges", () => {
  // Two nodes side by side above two below: a/b each feed the node diagonally opposite, so both runs cross the same gap.
  const nodes = new Map([
    ["a", rect(0, 0)],
    ["b", rect(400, 0)],
    ["c", rect(0, 300)],
    ["d", rect(400, 300)],
  ]);

  it("puts overlapping runs from different outputs in separate lanes", () => {
    const routes = routeEdges([edge("ad", "a", "out", "d", 150, 100, 550, 300), edge("bc", "b", "out", "c", 550, 100, 150, 300)], nodes);
    const [y1, y2] = [runY(routes.get("ad")!), runY(routes.get("bc")!)];
    expect(Math.abs(y1 - y2)).toBe(LANE_GAP);
    // Centred on the midway channel.
    expect((y1 + y2) / 2).toBe(200);
  });

  it("orders lanes so parallel runs don't cross each other", () => {
    // Both head right and down; the one that turns down later must run above, or the other would cross it.
    const wide = new Map([
      ["s", rect(0, 0, 400)],
      ["t", rect(300, 300, 600)],
    ]);
    const routes = routeEdges([edge("near", "s", "a", "t", 100, 100, 450, 300), edge("far", "s", "b", "t", 250, 100, 750, 300)], wide);
    expect(runY(routes.get("far")!)).toBeLessThan(runY(routes.get("near")!));
  });

  it("lets edges from the same output share a lane", () => {
    const routes = routeEdges([edge("ac", "a", "out", "c", 150, 100, 100, 300), edge("ad", "a", "out", "d", 150, 100, 550, 300)], nodes);
    expect(runY(routes.get("ac")!)).toBe(runY(routes.get("ad")!));
  });

  it("goes around a node in the way instead of through it", () => {
    const stack = new Map([
      ["top", rect(0, 0)],
      ["middle", rect(0, 200)],
      ["bottom", rect(0, 400)],
    ]);
    const pts = routeEdges([edge("skip", "top", "out", "bottom", 150, 100, 150, 400)], stack).get("skip")!;
    expect(crossesRect(pts, stack.get("middle")!)).toBe(false);
    expect(pts[0]).toEqual([150, 100]);
    expect(pts.at(-1)).toEqual([150, 400]);
  });

  it("routes an edge to a node above around the side", () => {
    const pts = routeEdges([edge("back", "c", "out", "a", 150, 400, 150, 0)], nodes).get("back")!;
    expect(pts).toHaveLength(6);
    expect(pts[1][1]).toBe(400 + STUB);
    expect(pts[4][1]).toBe(0 - STUB);
    expect(crossesRect(pts, nodes.get("a")!)).toBe(false);
    expect(crossesRect(pts, nodes.get("c")!)).toBe(false);
  });

  it("draws a straight line when the ports line up", () => {
    expect(routeEdges([edge("s", "a", "out", "c", 150, 100, 150, 300)], nodes).get("s")).toEqual([
      [150, 100],
      [150, 300],
    ]);
  });
});

describe("fitEndpoints", () => {
  it("moves the ends to the drawn handles and keeps the first and last runs vertical", () => {
    const pts = fitEndpoints(
      [
        [150, 100],
        [150, 200],
        [550, 200],
        [550, 300],
      ],
      152,
      101,
      548,
      299,
    );
    expect(pts).toEqual([
      [152, 101],
      [152, 200],
      [548, 200],
      [548, 299],
    ]);
  });
});

describe("haloPath", () => {
  it("leaves the ends and the turns beside the ports unmasked", () => {
    const d = haloPath([
      [0, 0],
      [0, 100],
      [200, 100],
      [200, 200],
    ]);
    expect(d).toBe("M 0 7 L 0 93 M 7 100 L 193 100 M 200 107 L 200 193");
  });
});

describe("sharedStretches", () => {
  it("keeps the halo off the stretch two edges share into one input", () => {
    // Both enter t's one input at x=350; b joins lower than a.
    const edges = [edge("a", "a", "out", "t", 150, 100, 350, 300), edge("b", "b", "out", "t", 550, 100, 350, 300)];
    const routes = new Map<string, Point[]>([
      ["a", [[150, 100], [150, 200], [350, 200], [350, 300]]],
      ["b", [[550, 100], [550, 230], [350, 230], [350, 300]]],
    ]);
    const s = sharedStretches(edges, routes);
    // a's last run must stay clear up past where b joins (70 px above the port).
    expect(s.get("a")).toEqual({ start: 7, end: 77 });
    expect(s.get("b")).toEqual({ start: 7, end: 107 });
  });
});
