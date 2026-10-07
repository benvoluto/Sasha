'use client';

// Connections drawn along routes worked out for the whole graph at once (see
// lib/workflow/edge-routing), so parallel runs get their own lanes. Each line is
// drawn over a halo in the canvas colour, which opens a small gap wherever a
// later line crosses an earlier one, so it is clear which line goes where.

import { BaseEdge, useStore, type Edge, type EdgeProps, type ReactFlowState } from '@xyflow/react';
import { createContext, useContext, useMemo } from 'react';
import { fitEndpoints, haloPath, roundedPath, routeEdges, sharedStretches, type EdgeGeom, type Point, type Rect } from '@/lib/workflow/edge-routing';

export type RoutedEdgeData = { highlight?: boolean };
export type RoutedEdgeType = Edge<RoutedEdgeData, 'routed'>;

export type Routes = { points: Map<string, Point[]>; clear: Map<string, { start: number; end: number }> };
const RoutesContext = createContext<Routes>({ points: new Map(), clear: new Map() });
export const RoutesProvider = RoutesContext.Provider;

type HandleBounds = { id?: string | null; x: number; y: number; width: number; height: number };
type NodeGeom = { id: string; rect: Rect; sources: Record<string, [number, number]>; targets: Record<string, [number, number]> };

/**
 * The geometry routing needs, as a string: the store's node map is updated in
 * place, so a selector returning it would never re-render, and a string compares
 * cheaply while nodes are dragged.
 */
function geometryKey(s: ReactFlowState): string {
  const out: NodeGeom[] = [];
  for (const n of s.nodeLookup.values()) {
    const { x, y } = n.internals.positionAbsolute;
    const width = n.measured.width ?? 0;
    const height = n.measured.height ?? 0;
    if (!width || !height) continue;
    // Outputs leave from the bottom-centre of their handle; inputs arrive at the top-centre.
    const at = (hs: HandleBounds[] | null | undefined, bottom: boolean) =>
      Object.fromEntries((hs ?? []).map((h) => [h.id ?? '', [x + h.x + h.width / 2, y + h.y + (bottom ? h.height : 0)] as [number, number]]));
    out.push({ id: n.id, rect: { x, y, width, height }, sources: at(n.internals.handleBounds?.source, true), targets: at(n.internals.handleBounds?.target, false) });
  }
  return JSON.stringify(out);
}

/** Routes for every edge, recomputed when nodes move or resize or the edges change. */
export function useEdgeRoutes(edges: Array<Pick<Edge, 'id' | 'source' | 'target' | 'sourceHandle' | 'targetHandle'>>): Routes {
  const key = useStore(geometryKey);
  return useMemo(() => {
    const nodes: NodeGeom[] = JSON.parse(key);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const geoms: EdgeGeom[] = [];
    for (const e of edges) {
      const s = byId.get(e.source)?.sources[e.sourceHandle ?? ''];
      const t = byId.get(e.target)?.targets[e.targetHandle ?? ''];
      if (!s || !t) continue;
      geoms.push({ id: e.id, source: e.source, sourceKey: `${e.source}:${e.sourceHandle}`, target: e.target, targetKey: `${e.target}:${e.targetHandle}`, sx: s[0], sy: s[1], tx: t[0], ty: t[1] });
    }
    const points = routeEdges(geoms, new Map(nodes.map((n) => [n.id, n.rect])));
    return { points, clear: sharedStretches(geoms, points) };
  }, [key, edges]);
}

export function RoutedEdge({ id, sourceX, sourceY, targetX, targetY, selected, data, style, markerEnd }: EdgeProps<RoutedEdgeType>) {
  const routes = useContext(RoutesContext);
  const points = fitEndpoints(routes.points.get(id), sourceX, sourceY, targetX, targetY);
  const clear = routes.clear.get(id);
  const emphasis = selected || data?.highlight;
  return (
    <>
      <path
        d={haloPath(points, clear?.start, clear?.end)}
        className="fill-none stroke-zinc-50 dark:stroke-[#141414]"
        // Inline, so the animated-edge dash rule (which targets every path in an edge) can't dash the halo.
        style={{ strokeWidth: 6, strokeLinecap: 'butt', strokeLinejoin: 'round', strokeDasharray: 'none', animation: 'none' }}
      />
      <BaseEdge
        id={id}
        path={roundedPath(points)}
        markerEnd={markerEnd}
        interactionWidth={14}
        style={{ ...style, strokeWidth: emphasis ? 2.25 : 1.5, ...(emphasis ? { stroke: '#ea580c' } : {}) }}
      />
    </>
  );
}
