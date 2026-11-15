// Ultracode DSL, not plain Node — see task.workflow.js header for the verified
// pi-ultracode@0.11.0 API ground truth (agent() resolves to the validated value itself;
// schema: NOT output:; parallel() lanes may be null; plain-JSON returns).
export const meta = { name: "review", description: "Parallel read-only PR review lanes; structured findings" };
const { pr } = args;
const spec = "docs/specs/2026-11-14-fusion-endpoint-design.md";
const FINDINGS_SCHEMA = { type: "object", properties: { findings: { type: "array", items: {
  type: "object", properties: { sev: { enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
  where: { type: "string" }, what: { type: "string" } }, required: ["sev", "where", "what"] } } },
  required: ["findings"] };

const lanes = [
  ["correctness",  `Review PR #${pr} for lifecycle/cancellation bugs against ${spec} §7.3/§7.8.`],
  ["budget",       `Recompute every number in the diff against ${spec} §9 (integers, not vibes).`],
  ["contract",     `Check SSE/usage/tools contract against ${spec} §7.6 and Q1/Q9/Q12.`],
  ["fences",       `Check nonce fences (all three stages) + tool quarantine against §9/§7.5.`],
  ["lean",         `Minimalist audit (AGENTS.md): deletions preferred, no speculative code/tests/comments, file-size caps, docs policy §9 (lowercase-hyphenated under docs/, 200-PR test).`],
  ["test-quality", `Every new gate observed red on a deliberate mutant in the same PR? Tests assert behaviour, not mocks?`],
];
const runLane = async (name, instr) => {
  // lanes die transiently (b200 socket resets): retry per-lane before declaring INCOMPLETE
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await agent(`${instr} Quote file:line per finding. Severity CRITICAL|HIGH|MEDIUM|LOW. No fixes, findings only.`,
      { label: `review:${name}${attempt ? `:retry${attempt}` : ""}`, agentType: "reviewer",
        model: `b200/qwen3.8-flash-next:${name === "lean" ? "high" : "medium"}`,
        schema: FINDINGS_SCHEMA });
    if (r && typeof r === "object" && Array.isArray(r.findings)) return r;
  }
  return null;
};
const raw = await parallel(lanes.map(([name, instr]) => () => runLane(name, instr)));

// Lane result IS the validated {findings:[...]} object. Index BEFORE filtering
// (filter-then-index misaligns lane labels — the #14-era bug). A failed lane is reported
// as a HIGH "review INCOMPLETE" finding; never a silent clean list.
const flat = raw.flatMap((r, i) => {
  if (!r || typeof r !== "object" || !Array.isArray(r.findings))
    return [{ sev: "HIGH", where: `.pi/ultracode/workflows/review.workflow.js lane '${lanes[i][0]}'`,
              what: "lane returned no schema-validated findings — treat review as INCOMPLETE, not clean" }];
  return r.findings.map(x => ({ ...x, lane: lanes[i][0] }));
});
return { blocking: flat.filter(f => f.sev === "CRITICAL" || f.sev === "HIGH"),
         disclosed: flat.filter(f => f.sev === "MEDIUM" || f.sev === "LOW") };
