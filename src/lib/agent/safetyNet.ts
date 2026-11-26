/**
 * Category safety net — a deterministic second opinion on the four
 * always-escalate categories, read straight from the ticket text.
 *
 * Why it exists: the hard routing rule ("billing / security / sales / bug
 * reports always reach a human") keys off the *model's* category label. If the
 * model files a refund request under `feature_question`, the rule never fires
 * and the ticket can auto-resolve on confidence alone. This net catches that
 * case without trusting the model at all.
 *
 * Design constraints:
 *  - It can only ever push a ticket *toward* a human, never away from one.
 *  - Patterns target account events (a charge, a refund, a leaked key, a
 *    contract), not topics. "How are cache writes billed?" is a docs question
 *    about pricing and must NOT trip the billing net; "I was billed twice" must.
 *  - bug_report is deliberately not covered: "bug" language is everywhere in
 *    ordinary technical questions, so a keyword net would mostly add noise. Its
 *    coverage gap is measured in the eval rather than papered over.
 */
export type SafetyCategory = "billing" | "security_abuse" | "sales_enterprise";

const RULES: { category: SafetyCategory; patterns: RegExp[] }[] = [
  {
    category: "security_abuse",
    patterns: [
      /\b(?:api )?keys? (?:was |were |got |has been |have been )?(?:leaked|compromised|exposed|stolen)\b/i,
      /\b(?:leaked|compromised|exposed|stolen) (?:api )?keys?\b/i,
      /\bcommitted (?:our |my |the |an? )?(?:\w+ )?(?:api )?key\b/i,
      /\bkey compromise\b/i,
      /\bunauthori[sz]ed (?:access|use|usage|key|api key|login|activity)\b/i,
      /\b(?:phishing|malware|ransomware)\b/i,
      /\b(?:abuse|misuse) (?:team|report|of (?:the|your) api)\b/i,
      /\breport(?:ing)? (?:api )?(?:abuse|misuse)\b/i,
      /\b(?:jailbreak|prompt injection|content filter bypass|bypass(?:ing)? (?:the )?(?:content|safety) filter)\b/i,
      /\bvulnerability\b|\bresponsible disclosure\b|\bsecurity (?:issue|incident|breach|report)\b/i,
      /\btor exit node\b|\banomalous (?:calls|requests|usage)\b/i,
    ],
  },
  {
    category: "billing",
    patterns: [
      /\brefund\b|\bchargeback\b|\bgoodwill (?:adjustment|credit)\b/i,
      /\b(?:double|twice|incorrectly|wrongly|over)[- ]?(?:billed|charged)\b/i,
      /\b(?:billed|charged) (?:twice|me|us|for (?:something|usage) (?:i|we) didn'?t)\b/i,
      /\b(?:been|was|were|got|getting) (?:billed|charged)\b/i,
      /\bunexpected (?:\$[\d,.]+ )?(?:charge|bill|invoice)\b/i,
      /\b(?:invoice|INV-[\d-]+)\b.*\b(?:wrong|mismatch|doesn'?t match|don'?t match|incorrect|duplicate|off)\b/i,
      /\binvoice line items\b|\btwo invoices\b|\bduplicate invoice\b/i,
      /\bpayment (?:failed|declined)\b|\bcard (?:expired|declined)\b|\bpast due\b|\boutstanding balance\b/i,
      /\bbilling (?:dispute|error|issue)\b/i,
    ],
  },
  {
    category: "sales_enterprise",
    patterns: [
      /\benterprise (?:agreement|contract|plan|pricing|deal|tier)\b/i,
      /\b(?:volume|committed|custom) (?:pricing|discount|throughput|contract)\b/i,
      /\b(?:speak|talk) (?:with|to) (?:sales|an account (?:rep|manager))\b|\bsales (?:team|rep)\b/i,
      /\bprocurement\b|\bvendor (?:packet|assessment|questionnaire|security)\b|\bsecurity questionnaire\b/i,
      /\b(?:MSA|BAA|DPA)\b|\bdata processing addendum\b|\bmaster services agreement\b/i,
      /\bSOC ?2\b|\bISO ?27001\b|\bHIPAA\b|\bCAIQ\b|\bSIG Lite\b/i,
      /\bdedicated (?:capacity|deployment|tenancy)\b|\bSLA[- ]backed\b|\bprivate ?link\b/i,
    ],
  },
];

export type SafetyNetHit = { category: SafetyCategory; matched: string };

/**
 * Returns the first sensitive category the ticket text matches, or null.
 * Security is checked first: a leaked key that also mentions a charge is a
 * security incident before it's a billing question.
 */
export function safetyNet(text: string): SafetyNetHit | null {
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const m = pattern.exec(text);
      if (m) return { category: rule.category, matched: m[0] };
    }
  }
  return null;
}
