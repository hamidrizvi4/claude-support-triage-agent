/**
 * Local, in-memory copy of the doc index for the eval.
 *
 * Why: the eval measures the agent and its routing, not the database. Under
 * load, the production search (an exact pgvector scan over 13k 2048-d vectors
 * on a small Supabase instance) hits Postgres' statement timeout, and a run
 * whose searches failed says nothing about the agent. So the eval downloads
 * the stored vectors once and runs the same exact cosine top-k that
 * match_doc_chunks runs (`1 - (embedding <=> query)`), in memory. Same
 * vectors, same query embedding model, same math — only the place it runs
 * changes. `verifyAgainstDb()` checks that claim on live queries.
 *
 * Cache: evals/.cache/ (gitignored). Rebuild with --refresh-index.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { embed, EMBEDDING_DIMENSIONS } from "../../src/lib/embeddings";

const CACHE = path.join(__dirname, "..", "..", "evals", ".cache");
const META = path.join(CACHE, "chunks.json");
const VECS = path.join(CACHE, "vectors.f32");

type Meta = { id: string; source_url: string; title: string; content: string; section: string | null };
export type SearchRow = Meta & { similarity: number };

let loaded: { meta: Meta[]; vecs: Float32Array } | null = null;

function parseVector(v: unknown): number[] {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") return JSON.parse(v) as number[];
  throw new Error("unexpected embedding format");
}

export async function downloadIndex(supabase: SupabaseClient, refresh = false): Promise<void> {
  if (!refresh && fs.existsSync(META) && fs.existsSync(VECS)) return;
  fs.mkdirSync(CACHE, { recursive: true });
  const meta: Meta[] = [];
  const parts: Float32Array[] = [];
  let lastId = "";
  for (;;) {
    let q = supabase.from("doc_chunks").select("id, source_url, title, content, section, embedding").order("id").limit(200);
    if (lastId) q = q.gt("id", lastId);
    let rows: (Meta & { embedding: unknown })[] | null = null;
    for (let attempt = 1; attempt <= 5 && !rows; attempt++) {
      const { data, error } = await q;
      if (!error) rows = (data ?? []) as (Meta & { embedding: unknown })[];
      else await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
    if (!rows) throw new Error("could not download doc_chunks page");
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r.embedding == null) continue; // unembedded chunks can't match in the DB either
      const v = parseVector(r.embedding);
      if (v.length !== EMBEDDING_DIMENSIONS) throw new Error(`chunk ${r.id} has ${v.length} dims`);
      meta.push({ id: r.id, source_url: r.source_url, title: r.title, content: r.content, section: r.section });
      parts.push(Float32Array.from(v));
    }
    lastId = rows[rows.length - 1].id;
    process.stdout.write(`\r  downloaded ${meta.length} chunks`);
  }
  process.stdout.write("\n");
  const all = new Float32Array(parts.length * EMBEDDING_DIMENSIONS);
  parts.forEach((p, i) => all.set(p, i * EMBEDDING_DIMENSIONS));
  fs.writeFileSync(VECS, Buffer.from(all.buffer));
  fs.writeFileSync(META, JSON.stringify(meta));
}

function load() {
  if (loaded) return loaded;
  const meta = JSON.parse(fs.readFileSync(META, "utf8")) as Meta[];
  const buf = fs.readFileSync(VECS);
  const vecs = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  // Pre-normalize so a dot product is the cosine similarity.
  const D = EMBEDDING_DIMENSIONS;
  for (let i = 0; i < meta.length; i++) {
    let n = 0;
    for (let d = 0; d < D; d++) n += vecs[i * D + d] ** 2;
    n = Math.sqrt(n) || 1;
    for (let d = 0; d < D; d++) vecs[i * D + d] /= n;
  }
  loaded = { meta, vecs };
  return loaded;
}

export function indexSize(): number {
  return load().meta.length;
}

/** Exact cosine top-k, same result shape as the match_doc_chunks RPC. */
export async function localSearch(query: string, topK = 5): Promise<{ results: SearchRow[] }> {
  const { meta, vecs } = load();
  const [q] = await embed([query]);
  const D = EMBEDDING_DIMENSIONS;
  let qn = 0;
  for (const x of q) qn += x * x;
  qn = Math.sqrt(qn) || 1;
  const k = Math.max(1, Math.min(50, Math.floor(topK) || 5));
  const best: { i: number; s: number }[] = [];
  for (let i = 0; i < meta.length; i++) {
    let s = 0;
    const off = i * D;
    for (let d = 0; d < D; d++) s += vecs[off + d] * q[d];
    s /= qn;
    if (best.length < k || s > best[best.length - 1].s) {
      best.push({ i, s });
      best.sort((a, b) => b.s - a.s);
      if (best.length > k) best.pop();
    }
  }
  return { results: best.map(({ i, s }) => ({ ...meta[i], similarity: s })) };
}

/** Compares local top-k with the live RPC for a few queries; returns overlap stats. */
export async function verifyAgainstDb(supabase: SupabaseClient, queries: string[]): Promise<{ query: string; overlap: number; maxDiff: number } []> {
  const out: { query: string; overlap: number; maxDiff: number }[] = [];
  for (const query of queries) {
    const [qv] = await embed([query]);
    const { data, error } = await supabase.rpc("match_doc_chunks", { query_embedding: qv, match_count: 5 });
    if (error) {
      out.push({ query, overlap: NaN, maxDiff: NaN });
      continue;
    }
    const db = (data ?? []) as SearchRow[];
    const local = (await localSearch(query, 5)).results;
    const ids = new Set(db.map((r) => r.id));
    const overlap = local.filter((r) => ids.has(r.id)).length / Math.max(1, db.length);
    const byId = new Map(local.map((r) => [r.id, r.similarity]));
    const maxDiff = Math.max(0, ...db.filter((r) => byId.has(r.id)).map((r) => Math.abs(r.similarity - byId.get(r.id)!)));
    out.push({ query, overlap, maxDiff });
  }
  return out;
}
