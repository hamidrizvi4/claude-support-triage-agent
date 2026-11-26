// 2048 dims to match doc_chunks.embedding vector(2048). Was the free
// nvidia/nemotron-3-embed-1b until OpenRouter retired it on 2026-11-23 (HTTP
// 410); its free successor proved too rate-limited and unstable to rebuild a
// 13k-chunk index, so this uses a cheap paid model (~$0.07 for the full
// corpus) that supports Matryoshka truncation to 2048 dims. Changing this
// model requires re-embedding the whole index (npm run reembed-docs): query
// and document vectors must come from the same model.
export const EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";
export const EMBEDDING_DIMENSIONS = 2048;

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set to generate embeddings");

  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter embeddings error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const vectors: number[][] = json.data.map((d: { embedding: number[] }) => d.embedding);
  if (vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
    throw new Error(`expected ${EMBEDDING_DIMENSIONS}-d embeddings from ${EMBEDDING_MODEL}, got ${vectors[0]?.length}`);
  }
  return vectors;
}
