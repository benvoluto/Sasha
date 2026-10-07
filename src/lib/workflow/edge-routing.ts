// Orthogonal routing for the workflow canvas's connections. Outputs sit on the
// bottom of a node and inputs on the top, so every route leaves straight down
// and arrives straight down. In between:
//
//   1. Each edge picks the route that crosses the fewest other nodes: a
//      horizontal run midway, just below its source, or just above its target,
//      or (when the target is above, or every direct route is blocked) a detour
//      down the side of the nodes in the way.
//   2. A lane manager then separates runs that would sit on top of each other:
//      horizontal runs at about the same height whose spans overlap, and side
//      detours at about the same x, each get their own lane LANE_GAP apart, like
//      lanes on a road. Edges from the same output share a lane, since they carry
//      the same value and splitting them would invent a fork.
//
// Pure geometry: the canvas feeds it node rectangles and handle positions.

export type Point = [number, number];
export type Rect = { x: number; y: number; width: number; height: number };
export type EdgeGeom = {
  id: string;
  source: string;
  /** Edges from the same output share lanes. */
  sourceKey: string;
  target: string;
  /** Edges into the same input merge; their halos must not notch each other. */
  targetKey: string;
  /** Bottom of the source handle and top of the target handle. */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
};

/** Space between parallel lanes. Wider than the halo drawn under each line, so a halo never hides its neighbour. */
export const LANE_GAP = 8;
/** How far a route runs straight out of an output, and into an input, before turning. */
export const STUB = 22;
/** Clearance between a side detour and the nodes it passes. */
const SIDE_MARGIN = 28;
/** Nodes are padded by this much when checking whether a route passes through them. */
const CLEARANCE = 6;

type Orient = "h" | "v";
/** A movable run of a route: points[index]→points[index + 1]. `rule` says which way its lanes stack: 0 centred, ±1 outward. */
type Slot = { index: number; orient: Orient; rule: -1 | 0 | 1 };
type Candidate = { points: Point[]; slots: Slot[]; cost: number };

const inflate = (r: Rect, by: number): Rect => ({ x: r.x - by, y: r.y - by, width: r.width + 2 * by, height: r.height + 2 * by });

/** Does the axis-aligned segment a→b pass through the inside of r? */
function crosses(a: Point, b: Point, r: Rect): boolean {
  const [x1, x2] = a[0] < b[0] ? [a[0], b[0]] : [b[0], a[0]];
  const [y1, y2] = a[1] < b[1] ? [a[1], b[1]] : [b[1], a[1]];
  return x1 < r.x + r.width && x2 > r.x && y1 < r.y + r.height && y2 > r.y;
}

function score(points: Point[], obstacles: Rect[], tiebreak: number): number {
  let hits = 0;
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    length += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
    for (const r of obstacles) if (crosses(a, b, r)) hits++;
  }
  return hits * 1e6 + length + (points.length - 2) * 30 + tiebreak;
}

function candidates(e: EdgeGeom, obstacles: Rect[], ends: Rect[]): Candidate[] {
  const out: Candidate[] = [];
  const S: Point = [e.sx, e.sy];
  const T: Point = [e.tx, e.ty];

  if (e.ty - e.sy >= 2 * STUB) {
    if (Math.abs(e.sx - e.tx) < 0.5) {
      out.push({ points: [S, T], slots: [], cost: score([S, T], obstacles, 0) });
    } else {
      const options: Array<[number, -1 | 0 | 1]> = [
        [(e.sy + e.ty) / 2, 0],
        [e.sy + STUB, 1],
        [e.ty - STUB, -1],
      ];
      options.forEach(([y, rule], i) => {
        const points: Point[] = [S, [e.sx, y], [e.tx, y], T];
        out.push({ points, slots: [{ index: 1, orient: "h", rule }], cost: score(points, obstacles, i) });
      });
    }
  }

  // Detours down either side of everything in the way (and of the two end nodes).
  const y1 = e.sy + STUB;
  const y2 = e.ty - STUB;
  const [lo, hi] = y1 < y2 ? [y1, y2] : [y2, y1];
  const inSpan = [...obstacles, ...ends].filter((r) => r.y < hi && r.y + r.height > lo);
  const right = Math.max(e.sx, e.tx, ...inSpan.map((r) => r.x + r.width)) + SIDE_MARGIN;
  const left = Math.min(e.sx, e.tx, ...inSpan.map((r) => r.x)) - SIDE_MARGIN;
  // Or through a gap between two of them, which is usually much shorter.
  const byX = [...inSpan].sort((a, b) => a.x - b.x);
  const gaps: Array<[number, -1 | 0 | 1]> = [];
  for (let i = 0; i < byX.length - 1; i++) {
    const [l, r] = [byX[i].x + byX[i].width, byX[i + 1].x];
    if (r - l >= LANE_GAP) gaps.push([(l + r) / 2, 0]);
  }
  for (const [x, rule] of [[right, 1], [left, -1], ...gaps] as const) {
    const points: Point[] = [S, [e.sx, y1], [x, y1], [x, y2], [e.tx, y2], T];
    out.push({
      points,
      slots: [
        { index: 1, orient: "h", rule: 1 },
        { index: 2, orient: "v", rule },
        { index: 3, orient: "h", rule: -1 },
      ],
      cost: score(points, obstacles, 3),
    });
  }
  return out;
}

/** Where a run's neighbouring segments leave it: at `at` along the run, heading `dir` (−1 or +1) across it. */
type RunEnd = { at: number; dir: number };
type Run = { edge: string; key: string; slot: Slot; base: number; lo: number; hi: number; lane: number; ends: RunEnd[] };

const laneOffset = (run: Run, lane: number, lanes: number) =>
  run.slot.rule === 0 ? (lane - (lanes - 1) / 2) * LANE_GAP : run.slot.rule * lane * LANE_GAP;

/**
 * How many times runs in these lanes cross each other's connecting segments: a
 * run's neighbour leaves it at `at` and heads off one side, so it crosses every
 * run on that side whose span contains `at`.
 */
function laneCrossings(cluster: Run[], laneOf: (r: Run) => number, lanes: number): number {
  let n = 0;
  for (const p of cluster) {
    const cp = laneOffset(p, laneOf(p), lanes);
    for (const q of cluster) {
      if (q === p || q.key === p.key) continue;
      const cq = laneOffset(q, laneOf(q), lanes);
      for (const end of p.ends) if (end.at > q.lo && end.at < q.hi && (cq - cp) * end.dir > 0) n++;
    }
  }
  return n;
}

function permutations(n: number): number[][] {
  if (n <= 1) return [[0]];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)]));
}

/**
 * Give every run its lane. Runs of one orientation are clustered by their
 * fixed coordinate (within LANE_GAP of each other), and within a cluster runs
 * whose spans overlap get different lanes unless they come from the same output.
 */
function assignLanes(runs: Run[]): Map<Run, number> {
  const offsets = new Map<Run, number>();
  const sorted = [...runs].sort((a, b) => a.base - b.base || a.lo - b.lo || a.edge.localeCompare(b.edge));
  let i = 0;
  while (i < sorted.length) {
    const cluster: Run[] = [];
    const start = sorted[i].base;
    while (i < sorted.length && sorted[i].base - start <= LANE_GAP) cluster.push(sorted[i++]);
    cluster.sort((a, b) => a.lo - b.lo || a.edge.localeCompare(b.edge));
    const lanes: Run[][] = [];
    for (const run of cluster) {
      let lane = lanes.findIndex((l) => l.every((o) => o.key === run.key || run.lo > o.hi + LANE_GAP || o.lo > run.hi + LANE_GAP));
      if (lane < 0) lane = lanes.push([]) - 1;
      lanes[lane].push(run);
      run.lane = lane;
    }
    // Order the lanes so the runs cross each other's connections as little as
    // possible (the lanes themselves are fixed; only which run sits where changes).
    let order = lanes.map((_, i) => i);
    if (lanes.length > 1 && lanes.length <= 5) {
      // Start from the greedy order, so ties keep it and lanes don't jump around while dragging.
      let best = laneCrossings(cluster, (r) => r.lane, lanes.length);
      for (const perm of permutations(lanes.length)) {
        const crossings = laneCrossings(cluster, (r) => perm[r.lane], lanes.length);
        if (crossings < best) [best, order] = [crossings, perm];
      }
    }
    for (const run of cluster) {
      // Snap the cluster to its first run's coordinate, so near-misses line up as lanes.
      offsets.set(run, start - run.base + laneOffset(run, order[run.lane], lanes.length));
    }
  }
  return offsets;
}

/** Route every edge. Returns each edge's polyline, from its source handle to its target handle. */
export function routeEdges(edges: EdgeGeom[], nodes: Map<string, Rect>): Map<string, Point[]> {
  const padded = new Map([...nodes].map(([id, r]) => [id, inflate(r, CLEARANCE)]));
  const chosen = new Map<string, Candidate>();
  for (const e of edges) {
    const obstacles = [...padded].filter(([id]) => id !== e.source && id !== e.target).map(([, r]) => r);
    const ends = [nodes.get(e.source), nodes.get(e.target)].filter((r): r is Rect => !!r);
    const best = candidates(e, obstacles, ends).sort((a, b) => a.cost - b.cost)[0];
    if (best) chosen.set(e.id, { ...best, points: best.points.map((p) => [...p] as Point) });
  }

  const runs: Run[] = [];
  const keyOf = new Map(edges.map((e) => [e.id, e.sourceKey]));
  for (const [id, c] of chosen) {
    for (const slot of c.slots) {
      const [a, b] = [c.points[slot.index], c.points[slot.index + 1]];
      const axis = slot.orient === "h" ? 0 : 1;
      const [before, after] = [c.points[slot.index - 1], c.points[slot.index + 2]];
      const ends = [
        { at: a[axis], dir: Math.sign(before[1 - axis] - a[1 - axis]) },
        { at: b[axis], dir: Math.sign(after[1 - axis] - b[1 - axis]) },
      ];
      runs.push({ edge: id, key: keyOf.get(id)!, slot, base: a[1 - axis], lo: Math.min(a[axis], b[axis]), hi: Math.max(a[axis], b[axis]), lane: 0, ends });
    }
  }
  for (const orient of ["h", "v"] as const) {
    for (const [run, offset] of assignLanes(runs.filter((r) => r.slot.orient === orient))) {
      if (!offset) continue;
      const pts = chosen.get(run.edge)!.points;
      const coord = orient === "h" ? 1 : 0;
      pts[run.slot.index][coord] += offset;
      pts[run.slot.index + 1][coord] += offset;
    }
  }
  return new Map([...chosen].map(([id, c]) => [id, c.points]));
}

/**
 * Pin a route's ends to where the canvas actually drew the handles, keeping the
 * first and last runs vertical. Falls back to a midway route when there is none yet.
 */
export function fitEndpoints(points: Point[] | undefined, sx: number, sy: number, tx: number, ty: number): Point[] {
  if (!points || points.length < 2) {
    const y = (sy + ty) / 2;
    return Math.abs(sx - tx) < 0.5 ? [[sx, sy], [tx, ty]] : [[sx, sy], [sx, y], [tx, y], [tx, ty]];
  }
  const p = points.map((q) => [...q] as Point);
  p[0] = [sx, sy];
  p[p.length - 1] = [tx, ty];
  if (p.length > 2) {
    p[1][0] = sx;
    p[p.length - 2][0] = tx;
  }
  return p;
}

/** An SVG path through the points with rounded corners. */
export function roundedPath(points: Point[], radius = 6): string {
  if (points.length < 2) return "";
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [p, c, n] = [points[i - 1], points[i], points[i + 1]];
    const r = Math.min(radius, Math.hypot(c[0] - p[0], c[1] - p[1]) / 2, Math.hypot(n[0] - c[0], n[1] - c[1]) / 2);
    const into = towards(c, p, r);
    const out = towards(c, n, r);
    d += ` L ${into[0]} ${into[1]} Q ${c[0]} ${c[1]} ${out[0]} ${out[1]}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

/**
 * How far along its first and last runs each edge's halo must stay clear. Where
 * edges leave one output, they run together until each turns off, and where
 * edges enter one input they run together after each joins; a halo along that
 * shared stretch would notch the sibling's line where it joins, making a merge
 * look like a crossing. So the halo starts below the last fork and ends above
 * the first join.
 */
export function sharedStretches(edges: EdgeGeom[], routes: Map<string, Point[]>, trim = HALO_TRIM): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  const group = (key: (e: EdgeGeom) => string) => {
    const m = new Map<string, EdgeGeom[]>();
    for (const e of edges) m.set(key(e), [...(m.get(key(e)) ?? []), e]);
    return m;
  };
  const bySource = group((e) => e.sourceKey);
  const byTarget = group((e) => e.targetKey);
  for (const e of edges) {
    const pts = routes.get(e.id);
    if (!pts) continue;
    let start = trim;
    let end = trim;
    for (const o of bySource.get(e.sourceKey) ?? []) {
      const op = routes.get(o.id);
      // A sibling's first turn, measured down this edge's first run.
      if (o.id !== e.id && op && op.length > 2) start = Math.max(start, Math.abs(op[1][1] - pts[0][1]) + trim);
    }
    for (const o of byTarget.get(e.targetKey) ?? []) {
      const op = routes.get(o.id);
      if (o.id !== e.id && op && op.length > 2) end = Math.max(end, Math.abs(pts[pts.length - 1][1] - op[op.length - 2][1]) + trim);
    }
    out.set(e.id, { start, end });
  }
  return out;
}

const HALO_TRIM = 7;

/**
 * The halo under a line: the same path, kept clear `start` px from the source
 * port along the first run and `end` px from the target port along the last
 * (see sharedStretches), and `trim` px around the turns beside the ports.
 */
export function haloPath(points: Point[], clearStart = HALO_TRIM, clearEnd = HALO_TRIM, trim = HALO_TRIM): string {
  const n = points.length;
  if (n < 2) return "";
  // How far to keep clear of each point: the ports, and the corners beside them.
  const clear = new Map<number, number>([
    [0, clearStart],
    [n - 1, clearEnd],
  ]);
  if (n > 2) {
    clear.set(1, Math.max(trim, clear.get(1) ?? 0));
    clear.set(n - 2, Math.max(trim, clear.get(n - 2) ?? 0));
  }
  const parts: string[] = [];
  let joined = false; // whether the pen is still at the end of the previous run
  for (let i = 0; i < n - 1; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const start = clear.get(i) ?? 0;
    const end = clear.get(i + 1) ?? 0;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= start + end) {
      joined = false;
      continue;
    }
    const p = towards(a, b, start);
    const q = towards(b, a, end);
    if (!joined || start) parts.push(`M ${p[0]} ${p[1]}`);
    parts.push(`L ${q[0]} ${q[1]}`);
    joined = !end;
  }
  return parts.join(" ");
}

function towards(from: Point, to: Point, dist: number): Point {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (!len) return from;
  return [from[0] + ((to[0] - from[0]) / len) * dist, from[1] + ((to[1] - from[1]) / len) * dist];
}
