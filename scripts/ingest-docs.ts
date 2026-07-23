/**
 * Day 1 data foundation: fetch public docs.claude.com + support.claude.com
 * pages, chunk them (~500 tokens, section-aware), embed, and upsert into
 * doc_chunks. Public pages only — see CLAUDE.md hard constraint.
 *
 * Usage: npm run ingest-docs
 */
import "dotenv/config";
import { getSupabaseAdmin } from "../src/lib/supabase";
import { embed } from "../src/lib/embeddings";

const CHUNK_WORD_LIMIT = 375; // ~500 tokens at ~0.75 words/token
const SOURCES = [
  { base: "https://docs.claude.com", sitemap: "https://docs.claude.com/sitemap.xml", kind: "mintlify" as const },
  { base: "https://support.claude.com", sitemap: "https://support.claude.com/sitemap.xml", kind: "zendesk" as const },
];

type Chunk = { section: string | null; content: string };

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "claude-support-triage-agent/ingest" } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractSitemapUrls(xml: string): string[] {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1].trim());
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(h[1-6])[^>]*>/gi, "\n\n## ")
    .replace(/<\/(h[1-6])>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function titleFromMarkdown(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : fallback;
}

function chunkContent(text: string): Chunk[] {
  const lines = text.split("\n");
  const chunks: Chunk[] = [];
  let currentSection: string | null = null;
  let buffer: string[] = [];
  let wordCount = 0;

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (content) chunks.push({ section: currentSection, content });
    buffer = [];
    wordCount = 0;
  };

  for (const line of lines) {
    const headerMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headerMatch) {
      flush();
      currentSection = headerMatch[1].trim();
    }
    buffer.push(line);
    wordCount += line.split(/\s+/).filter(Boolean).length;
    if (wordCount >= CHUNK_WORD_LIMIT) flush();
  }
  flush();

  return chunks.filter((c) => c.content.length > 40);
}

async function main() {
  const supabase = getSupabaseAdmin();
  let totalChunks = 0;

  for (const source of SOURCES) {
    const sitemapXml = await fetchText(source.sitemap);
    if (!sitemapXml) {
      console.warn(`Could not fetch sitemap for ${source.base}, skipping`);
      continue;
    }
    const urls = extractSitemapUrls(sitemapXml).filter((u) => u.startsWith(source.base));
    console.log(`${source.base}: found ${urls.length} pages`);

    for (const url of urls) {
      const pageUrl = source.kind === "mintlify" ? `${url}.md` : url;
      const raw = await fetchText(pageUrl);
      if (!raw) {
        console.warn(`  skip (fetch failed): ${pageUrl}`);
        continue;
      }
      const text = source.kind === "mintlify" ? raw : htmlToText(raw);
      const title = titleFromMarkdown(text, url);
      const chunks = chunkContent(text);
      if (chunks.length === 0) continue;

      const embeddings = await embed(chunks.map((c) => c.content));
      const rows = chunks.map((c, i) => ({
        source_url: url,
        title,
        content: c.content,
        section: c.section,
        embedding: embeddings[i],
      }));

      const { error } = await supabase.from("doc_chunks").upsert(rows);
      if (error) {
        console.error(`  upsert failed for ${url}: ${error.message}`);
        continue;
      }
      totalChunks += rows.length;
      console.log(`  ingested ${rows.length} chunks: ${url}`);
    }
  }

  console.log(`Done. ${totalChunks} chunks upserted into doc_chunks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
