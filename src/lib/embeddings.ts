const EMBEDDING_MODEL = "text-embedding-3-small"; // 1536 dims, matches doc_chunks.embedding

export async function embed(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY must be set to generate embeddings");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI embeddings error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  return json.data.map((d: { embedding: number[] }) => d.embedding);
}
