#!/usr/bin/env node
// Benchmark: sequential-combined extraction (current gemini-url-upload.ts) vs
// parallel-per-document extraction (gemini-parallel.ts).
//
// We are NOT calling the live Gemini API — that would be non-reproducible and
// costs money. The change only affects the ORCHESTRATION (what runs serially vs
// concurrently), so we simulate each strategy's wall-clock with a discrete-event
// model over a documented per-call latency model, and report the makespan.
//
// LATENCY MODEL (assumptions, stated so they can be argued with)
//   upload(file)      = UPLOAD_BASE + bytes/UPLOAD_BPS         (network-bound)
//   readiness(file)   = per-file poll-to-ACTIVE (parallel path)
//                     = fixed 5000ms blanket sleep (sequential path)
//   generation:
//     LLM decode latency is dominated by OUTPUT token count (tokens are decoded
//     serially at a roughly constant rate). So:
//       one call over N docs  => GEN_BASE + (Σ outChars)/DECODE_CPS   [sequential]
//       one call per doc       => GEN_BASE + (outChars)/DECODE_CPS     [each; run concurrently]
//   Concurrency is capped at CONC workers; makespan honors the cap.
//
// Constants are mid-range for a "flash"-class model over a few-hundred-KB PDF.
// A sensitivity sweep at the end shows the conclusion is not knife-edge.

const UPLOAD_BASE = 250;      // ms fixed per resumable upload (handshake + size probe)
const UPLOAD_BPS  = 4_000_000 / 1000; // ~4 MB/s -> bytes per ms
const READY_PARALLEL = 1500;  // ms to poll a file to ACTIVE (parallel path, per file)
const READY_SEQUENTIAL = 5000;// ms fixed blanket sleep in current code
const GEN_BASE = 700;         // ms fixed per generateContent (request + TTFT-ish)
const DECODE_CPS = 3800;      // output chars/sec decoded (~950 tok/s * ~4 chars/tok)
const CONC = 5;               // concurrency cap (GEMINI_*_CONCURRENCY default)

// Makespan of `durations` across `workers` parallel slots (list-scheduling).
function makespan(durations, workers) {
  if (durations.length === 0) return 0;
  // longest-first isn't how the real pool schedules (it's arrival order), and
  // for equal caps the makespan is dominated by load, so schedule in given order.
  const slots = new Array(Math.max(1, Math.min(workers, durations.length))).fill(0);
  for (const d of durations) {
    let m = 0;
    for (let i = 1; i < slots.length; i++) if (slots[i] < slots[m]) m = i;
    slots[m] += d;
  }
  return Math.max(...slots, 0);
}

const uploadMs = (bytes) => UPLOAD_BASE + bytes / UPLOAD_BPS;
const genMs = (outChars) => GEN_BASE + (outChars / DECODE_CPS) * 1000;

// A document: input bytes on disk, and expected extracted output chars.
function sequentialTime(docs, k = {}) {
  const readySeq = k.READY_SEQUENTIAL ?? READY_SEQUENTIAL;
  const upload = docs.reduce((s, d) => s + uploadMs(d.bytes), 0);      // serial for-loop
  const ready = readySeq;                                             // one blanket sleep
  const totalOut = docs.reduce((s, d) => s + d.outChars, 0);
  const gen = genMs(totalOut);                                        // single big call
  return { upload, ready, gen, total: upload + ready + gen };
}

function parallelTime(docs, k = {}) {
  const conc = k.CONC ?? CONC;
  const upload = makespan(docs.map((d) => uploadMs(d.bytes)), conc);
  const ready = makespan(docs.map(() => READY_PARALLEL), conc);
  const gen = makespan(docs.map((d) => genMs(d.outChars)), conc);     // per-doc, concurrent
  return { upload, ready, gen, total: upload + ready + gen };
}

const KB = 1024;
const scenarios = [
  { name: "1 doc, small (single report)", docs: mk([[300 * KB, 4000]]) },
  { name: "3 docs, ~equal", docs: mk([[300 * KB, 4000], [280 * KB, 3800], [320 * KB, 4200]]) },
  { name: "8 docs, ~equal (typical full file)", docs: mk(Array.from({ length: 8 }, () => [300 * KB, 4000])) },
  { name: "5 docs, mixed sizes", docs: mk([[150*KB,2000],[250*KB,3000],[600*KB,6000],[300*KB,4000],[900*KB,9000]]) },
  { name: "12 docs, small (cap engaged)", docs: mk(Array.from({ length: 12 }, () => [180 * KB, 2000])) },
  { name: "20 docs, small (heavy case)", docs: mk(Array.from({ length: 20 }, () => [200 * KB, 2200])) },
];

function mk(pairs) { return pairs.map(([bytes, outChars]) => ({ bytes, outChars })); }
const fmt = (ms) => (ms / 1000).toFixed(2) + "s";
const pad = (s, n) => String(s).padEnd(n);
const padl = (s, n) => String(s).padStart(n);

console.log("\nExtraction orchestration benchmark  (simulated wall-clock; model documented in source)\n");
console.log(pad("Scenario", 38), padl("seq up", 8), padl("seq gen", 9), padl("SEQ tot", 9), padl("PAR tot", 9), padl("speedup", 9));
console.log("-".repeat(38 + 8 + 9 + 9 + 9 + 9 + 5));
for (const s of scenarios) {
  const seq = sequentialTime(s.docs);
  const par = parallelTime(s.docs);
  const speed = seq.total / par.total;
  console.log(
    pad(s.name, 38),
    padl(fmt(seq.upload), 8),
    padl(fmt(seq.gen), 9),
    padl(fmt(seq.total), 9),
    padl(fmt(par.total), 9),
    padl(speed.toFixed(2) + "x", 9),
  );
}

// Phase breakdown for the representative 8-doc case.
{
  const s = scenarios[2];
  const seq = sequentialTime(s.docs), par = parallelTime(s.docs);
  console.log(`\nPhase breakdown — ${s.name}:`);
  console.log(`  upload:      seq ${fmt(seq.upload)}  ->  par ${fmt(par.upload)}`);
  console.log(`  readiness:   seq ${fmt(seq.ready)}  ->  par ${fmt(par.ready)}`);
  console.log(`  generation:  seq ${fmt(seq.gen)}  ->  par ${fmt(par.gen)}   (Σ chars -> max chars)`);
  console.log(`  TOTAL:       seq ${fmt(seq.total)}  ->  par ${fmt(par.total)}   (${(seq.total/par.total).toFixed(2)}x)`);
}

// Sensitivity: does the 8-doc conclusion hold if decode rate / concurrency move?
console.log("\nSensitivity (8-doc case) — speedup as assumptions vary:");
const eight = scenarios[2].docs;
for (const cps of [2500, 3800, 6000]) {
  const row = [];
  for (const conc of [3, 5, 10]) {
    const seq = { ...sequentialTime(eight) };
    // recompute gen with this decode rate
    const totalOut = eight.reduce((s, d) => s + d.outChars, 0);
    seq.gen = GEN_BASE + (totalOut / cps) * 1000; seq.total = seq.upload + seq.ready + seq.gen;
    const parUp = makespan(eight.map((d) => uploadMs(d.bytes)), conc);
    const parReady = makespan(eight.map(() => READY_PARALLEL), conc);
    const parGen = makespan(eight.map((d) => GEN_BASE + (d.outChars / cps) * 1000), conc);
    const parTot = parUp + parReady + parGen;
    row.push(`conc=${conc}: ${(seq.total / parTot).toFixed(2)}x`);
  }
  console.log(`  decode=${cps} cps  ->  ${row.join("   ")}`);
}
console.log();
