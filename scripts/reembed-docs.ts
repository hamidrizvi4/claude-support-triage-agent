/**
 * Re-embeds every doc_chunks row with the current EMBEDDING_MODEL and writes
 * the vectors back in place. Needed when the embedding model changes: query
 * vectors from one model are meaningless against document vectors from
 * another, so a model swap without this leaves search_docs silently useless.
 *
 * (OpenRouter retired nvidia/nemotron-3-embed-1b on 2026-11-23; the index was
 * rebuilt on its 2048-d successor with this script.)
 *
 * Resumable: progress is checkpointed to the OS temp dir, so an interrupted
 * run picks up where it stopped. Pass --restart to ignore the checkpoint.
 *
 * Usage: npm run reembed-docs [-- --restart]
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSupabaseAdmin } from "../src/lib/supabase";
import { embed, EMBEDDING_MODEL } from "../src/lib/embeddings";

const PAGE = 150; // rows fetched per page (written as concurrent slices)
const BATCH = 48; // texts per embeddings request
const UPSERT = 50; // rows written per upsert (larger writes of 2048-d vectors hit the statement timeout)
const CHECKPOINT = path.join(os.tmpdir(), `reembed-${EMBEDDING_MODEL.replace(/\W+/g, "_")}.json`);

type Row = { id: string; source_url: string; title: string; content: string; section: string | null };

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  tries = 6,
  retryable: (err: unknown) => boolean = () => true
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= tries || !retryable(err)) throw err;
      const wait = Math.min(60_000, 2_000 * 2 ** (attempt - 1));
      console.warn(`  ! ${label} failed (attempt ${attempt}): ${(err as Error).message.slice(0, 160)} — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const REJECTED = /\b422\b|content safety/i;

/**
 * Embeds a batch; if the provider's content screen rejects it (422), splits
 * the batch to isolate the offending chunk(s). A chunk rejected on its own
 * gets `null`: better no vector than a stale one from the retired model, which
 * would return meaningless similarities instead of simply not matching.
 */
async function embedOrSplit(texts: string[]): Promise<(number[] | null)[]> {
  try {
    return await withRetry("embed", () => embed(texts), 4, (e) => !REJECTED.test((e as Error).message));
  } catch (err) {
    if (!REJECTED.test((err as Error).message)) throw err;
    if (texts.length === 1) return [null];
    const mid = Math.ceil(texts.length / 2);
    return [...(await embedOrSplit(texts.slice(0, mid))), ...(await embedOrSplit(texts.slice(mid)))];
  }
}

let skipped = 0;

async function main() {
  const supabase = getSupabaseAdmin();
  const restart = process.argv.includes("--restart");
  let lastId = "";
  let done = 0;
  if (!restart && fs.existsSync(CHECKPOINT)) {
    ({ lastId, done, skipped = 0 } = JSON.parse(fs.readFileSync(CHECKPOINT, "utf8")));
    console.log(`Resuming after id ${lastId} (${done} rows already re-embedded)`);
  }

  const { count } = await supabase.from("doc_chunks").select("id", { count: "exact", head: true });
  console.log(`Re-embedding ${count ?? "?"} chunks with ${EMBEDDING_MODEL}`);

  for (;;) {
    let query = supabase
      .from("doc_chunks")
      .select("id, source_url, title, content, section")
      .order("id", { ascending: true })
      .limit(PAGE);
    if (lastId) query = query.gt("id", lastId);
    const { data, error } = await withRetry("fetch page", async () => {
      const res = await query;
      if (res.error) throw new Error(res.error.message);
      return res;
    });
    if (error) throw error;
    const rows = (data ?? []) as Row[];
    if (rows.length === 0) break;

    // Slices of one page run concurrently; the checkpoint only advances once
    // the whole page is written, so a restart never skips a row.
    const slices: Row[][] = [];
    for (let i = 0; i < rows.length; i += UPSERT) slices.push(rows.slice(i, i + UPSERT));
    await Promise.all(
      slices.map(async (slice) => {
        const vectors: (number[] | null)[] = [];
        for (let j = 0; j < slice.length; j += BATCH) {
          const texts = slice.slice(j, j + BATCH).map((r) => r.content);
          const out = await embedOrSplit(texts);
          skipped += out.filter((v) => v === null).length;
          vectors.push(...out);
        }
        const payload = slice.map((r, k) => ({ ...r, embedding: vectors[k] }));
        await withRetry("upsert", async () => {
          const { error: upsertError } = await supabase.from("doc_chunks").upsert(payload, { onConflict: "id" });
          if (upsertError) throw new Error(upsertError.message);
        });
      })
    );
    done += rows.length;
    lastId = rows[rows.length - 1].id;
    fs.writeFileSync(CHECKPOINT, JSON.stringify({ lastId, done, skipped }));
    console.log(`  ${done}/${count ?? "?"}${skipped ? ` (${skipped} rejected by the provider's content screen, set to null)` : ""}`);
  }

  fs.rmSync(CHECKPOINT, { force: true });
  console.log(`Done. ${done} chunks processed with ${EMBEDDING_MODEL}; ${skipped} rejected by the provider's content screen (embedding set to null).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
