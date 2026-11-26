/**
 * Loads the labeled eval set: the 40 synthetic tickets from the tickets table
 * joined with evals/labels.json (the "core" set), plus the author-written
 * evals/hard-cases.json ("hard" set). Labels live in the repo; ticket text for
 * the core set is read from Supabase, the same rows the live demo shows.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

export type EvalSet = "core" | "hard" | "all" | "pilot";

export type EvalTicket = {
  id: string;
  set: "core" | "hard";
  subject: string;
  body: string;
  account_id: string | null;
  gold_category: string;
  gold_route: "escalate" | "auto_resolve";
  pilot: boolean;
  kind?: string;
};

type LabelRow = { id: string; gold_category: string; gold_route: "escalate" | "auto_resolve"; pilot: boolean };
type HardRow = { id: string; kind: string; subject: string; body: string; gold_category: string; gold_route: "escalate" | "auto_resolve" };

const ROOT = path.join(__dirname, "..", "..", "evals");

export function readLabels(): { core: LabelRow[]; hard: HardRow[] } {
  const core = JSON.parse(fs.readFileSync(path.join(ROOT, "labels.json"), "utf8")).tickets as LabelRow[];
  const hard = JSON.parse(fs.readFileSync(path.join(ROOT, "hard-cases.json"), "utf8")).tickets as HardRow[];
  return { core, hard };
}

/** Gold labels by ticket id, for both sets — what the report scores against. */
export function goldById(): Map<string, { set: "core" | "hard"; gold_category: string; gold_route: string; kind?: string; text?: string }> {
  const { core, hard } = readLabels();
  const m = new Map<string, { set: "core" | "hard"; gold_category: string; gold_route: string; kind?: string; text?: string }>();
  for (const r of core) m.set(r.id, { set: "core", gold_category: r.gold_category, gold_route: r.gold_route });
  for (const r of hard)
    m.set(r.id, { set: "hard", gold_category: r.gold_category, gold_route: r.gold_route, kind: r.kind, text: `${r.subject}\n\n${r.body}` });
  return m;
}

export async function loadEvalSet(supabase: SupabaseClient, which: EvalSet): Promise<EvalTicket[]> {
  const { core, hard } = readLabels();
  const out: EvalTicket[] = [];

  if (which !== "hard") {
    const { data, error } = await supabase.from("tickets").select("id, subject, body, account_id");
    if (error) throw new Error(error.message);
    const byId = new Map((data ?? []).map((t) => [t.id as string, t]));
    for (const l of core) {
      const t = byId.get(l.id);
      if (!t) throw new Error(`labeled ticket ${l.id} not found in tickets table`);
      if (which === "pilot" && !l.pilot) continue;
      out.push({
        id: l.id,
        set: "core",
        subject: t.subject as string,
        body: t.body as string,
        account_id: (t.account_id as string | null) ?? null,
        gold_category: l.gold_category,
        gold_route: l.gold_route,
        pilot: l.pilot,
      });
    }
  }

  if (which === "hard" || which === "all") {
    for (const h of hard) {
      out.push({ ...h, set: "hard", account_id: null, pilot: false });
    }
  }
  return out;
}

/** Core-set ticket text by id (for the safety net, which reads subject + body). */
export async function ticketTexts(supabase: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await supabase.from("tickets").select("id, subject, body");
  if (error) throw new Error(error.message);
  const m = new Map<string, string>();
  for (const t of data ?? []) m.set(t.id as string, `${t.subject}\n\n${t.body}`);
  return m;
}
