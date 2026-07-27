/**
 * Day 1 data foundation: generate ~40 synthetic developer support tickets
 * spanning every routing category, via OpenRouter. Tickets are LLM-generated
 * only — never scraped from a real user, forum post, or support thread.
 *
 * Usage: npm run generate-tickets
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { getSupabaseAdmin } from "../src/lib/supabase";

const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

const CATEGORY_PLAN: { category: string; count: number; brief: string }[] = [
  {
    category: "informational",
    count: 12,
    brief:
      "Doc-answerable developer questions about the Claude API: rate limits, pricing tiers, tool-use / function-calling syntax, prompt caching, streaming, context window sizes, model migration (e.g. moving between Claude model versions), SDK usage.",
  },
  {
    category: "billing",
    count: 6,
    brief:
      "Billing disputes: unexpected charge on the account, refund request, confusion about an invoice, a charge that doesn't match usage, failed payment method.",
  },
  {
    category: "security",
    count: 5,
    brief:
      "Security or abuse reports: suspected API key leak, reporting misuse of the API by a third party, a vulnerability report, suspicious account activity.",
  },
  {
    category: "sales",
    count: 5,
    brief:
      "Enterprise or sales inquiries: asking about enterprise pricing, requesting a higher rate limit for a large rollout, procurement/security questionnaire requests, asking to speak with a sales rep.",
  },
  {
    category: "bug",
    count: 8,
    brief:
      "Bug reports: API returning unexpected errors, SDK behaving inconsistently with docs, malformed streaming responses, a specific endpoint returning wrong status codes.",
  },
  {
    category: "ambiguous",
    count: 4,
    brief:
      "Vague or multi-part tickets where the category is unclear from the subject alone, or that mix an informational question with something that sounds like a bug, forcing a real classification judgment call.",
  },
];

type GeneratedTicket = { subject: string; body: string };

async function generateForCategory(category: string, brief: string, count: number): Promise<GeneratedTicket[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY must be set");

  const prompt = `Generate ${count} realistic, synthetic developer support tickets for the Claude API (Anthropic's LLM API product).

Category: ${category}
Description: ${brief}

Each ticket should read like a real developer wrote it: varied tone, varied technical depth, occasional typos or informal phrasing, specific enough to feel real (mention SDK names, error codes, model names, etc. where plausible) but entirely fictional. Do not reference any real person, company, or real support thread.

Return ONLY a JSON array, no prose, no markdown fences, of exactly ${count} objects shaped like:
[{"subject": "...", "body": "..."}]`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter error ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  const raw: string = json.choices[0].message.content;
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const parsed = JSON.parse(jsonText) as GeneratedTicket[];
  return parsed;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function main() {
  const supabase = getSupabaseAdmin();

  const { data: accounts, error: accountsError } = await supabase.from("accounts").select("id");
  if (accountsError) throw accountsError;
  if (!accounts || accounts.length === 0) {
    throw new Error("No accounts found — run the migration (it seeds mock accounts) before generating tickets");
  }

  const rows: {
    subject: string;
    body: string;
    category: string;
    account_id: string;
    status: string;
  }[] = [];

  for (const { category, count, brief } of CATEGORY_PLAN) {
    console.log(`Generating ${count} "${category}" tickets...`);
    const tickets = await generateForCategory(category, brief, count);
    for (const t of tickets) {
      rows.push({
        subject: t.subject,
        body: t.body,
        category,
        account_id: pickRandom(accounts).id,
        status: "new",
      });
    }
  }

  console.log(`Inserting ${rows.length} tickets...`);
  const { error } = await supabase.from("tickets").insert(rows);
  if (error) throw error;

  console.log(`Done. ${rows.length} synthetic tickets inserted.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
