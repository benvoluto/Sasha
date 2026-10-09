"use client";

// Calls or tokens per day as a single-series column chart: thin columns with a
// rounded top on one baseline, hairline gridlines, three date labels, and a
// tooltip for the day under the pointer. Screen readers get a one-line summary
// (role="img") and the full by-day table beside it, so the chart never holds
// a value the table doesn't.
//
// Column colour: --doc-accent in light mode; in dark mode a slightly deeper
// blue than --doc-accent (#5f8fdc), which keeps 3:1 against the card while
// staying inside the chart palette's lightness band.

import { useLayoutEffect, useRef, useState } from "react";
import type { UsageGroup } from "@/lib/usage/contract";
import { dayLabel, formatCount, metricValue, niceScale, type ChartMetric } from "./usage-model";

const HEIGHT = 180;
const PAD = { top: 8, right: 8, bottom: 24, left: 44 };
const MAX_BAR = 24;

export function UsageChart({ days, metric }: { days: UsageGroup<"day">[]; metric: ChartMetric }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.clientWidth));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const values = days.map((d) => metricValue(d, metric));
  const peak = Math.max(0, ...values);
  const scale = niceScale(peak);
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const slot = days.length ? plotW / days.length : plotW;
  // A 2px surface gap between neighbours when there is room for one.
  const gap = slot >= 6 ? 2 : 0;
  const barW = Math.max(1, Math.min(MAX_BAR, slot - gap));
  const y = (v: number) => PAD.top + plotH - (v / scale.max) * plotH;
  const unit = metric === "calls" ? "calls" : "tokens";
  const peakIndex = values.indexOf(peak);
  const labelled = days.length ? [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])] : [];
  const summary = days.length
    ? `${unit === "calls" ? "Model calls" : "Tokens"} per day from ${dayLabel(days[0].day, true)} to ${dayLabel(days.at(-1)!.day, true)}. ${
        peak > 0 ? `Highest: ${formatCount(peak)} ${unit} on ${dayLabel(days[peakIndex].day, true)}.` : `No ${unit} in this range.`
      } The table below lists every day.`
    : "No days to show.";

  const hovered = hover === null ? null : days[hover];
  return (
    <div ref={box} className="relative w-full">
      <svg role="img" aria-label={summary} width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} className="block max-w-full" onPointerLeave={() => setHover(null)}>
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="stroke-[var(--doc-line)]" strokeWidth={1} shapeRendering="crispEdges" />
            <text x={PAD.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="fill-[var(--doc-muted)] text-[11px] tabular-nums">
              {formatCount(t)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const v = values[i];
          const x = PAD.left + i * slot + (slot - barW) / 2;
          const h = Math.max(0, y(0) - y(v));
          const r = Math.min(4, barW / 2, h);
          return (
            <g key={d.day} onPointerEnter={() => setHover(i)}>
              {/* The hit target is the whole slot, taller than the column. */}
              <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} fill="transparent" />
              {v > 0 && (
                <path
                  d={`M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + barW - r} Q${x + barW},${y(v)} ${x + barW},${y(v) + r} V${y(0)} Z`}
                  className={`fill-[var(--doc-accent)] dark:fill-[#5f8fdc] ${hover !== null && hover !== i ? "opacity-60" : ""}`}
                />
              )}
            </g>
          );
        })}
        {labelled.map((i) => (
          <text
            key={i}
            x={PAD.left + i * slot + slot / 2}
            y={HEIGHT - 6}
            textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"}
            className="fill-[var(--doc-muted)] text-[11px]"
          >
            {dayLabel(days[i].day)}
          </text>
        ))}
      </svg>
      {hovered && hover !== null && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md border border-[var(--doc-line)] bg-[var(--doc-surface)] px-2 py-1 text-xs text-[var(--doc-ink)] shadow-[var(--doc-pop-shadow)]"
          style={{ left: Math.min(width - 60, Math.max(60, PAD.left + hover * slot + slot / 2)) }}
        >
          <span className="font-semibold">{dayLabel(hovered.day, true)}</span> · {formatCount(values[hover])} {unit}
        </div>
      )}
    </div>
  );
}
