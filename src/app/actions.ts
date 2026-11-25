"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { ReviewAction } from "@/lib/data/types";

/** No auth in v1 — every review is attributed to the demo operator. */
const REVIEWER = "demo.reviewer";

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  "approve",
  "edit_and_approve",
  "reject",
]);

export type ReviewResult = { ok: true } | { ok: false; error: string };

export async function submitReview(input: {
  ticketId: string;
  action: ReviewAction;
  editedResponse?: string | null;
}): Promise<ReviewResult> {
  // Trust boundary: this is a server action, the client can send anything.
  if (!input?.ticketId) return { ok: false, error: "Missing ticket id." };
  if (!VALID_ACTIONS.has(input.action)) {
    return { ok: false, error: `Unknown review action "${input.action}".` };
  }

  const edited =
    input.action === "edit_and_approve" ? (input.editedResponse ?? "").trim() : null;
  if (input.action === "edit_and_approve" && !edited) {
    return { ok: false, error: "Edited response can't be empty." };
  }

  const supabase = getSupabaseAdmin();

  const { error: reviewError } = await supabase.from("reviews").insert({
    ticket_id: input.ticketId,
    reviewer: REVIEWER,
    action: input.action,
    edited_response: edited,
  });
  if (reviewError) return { ok: false, error: reviewError.message };

  const { error: ticketError } = await supabase
    .from("tickets")
    .update({ status: "reviewed" })
    .eq("id", input.ticketId);
  if (ticketError) return { ok: false, error: ticketError.message };

  revalidatePath("/queue");
  revalidatePath("/dashboard");
  return { ok: true };
}
