// Ultracode DSL, not plain Node — see task.workflow.js header for the verified
// pi-ultracode@0.11.0 API ground truth (agent() resolves to the validated value itself;
// schema: NOT output:; parallel() lanes may be null; plain-JSON returns).
export const meta = { name: "spike", description: "P0 throwaway spike vs fake engine" };

const FINDINGS_SCHEMA = { type: "object", properties: { findings: { type: "array", items: {
  type: "object", properties: { sev: { enum: ["CRITICAL", "HIGH", "MEDIUM", "LOW"] },
  where: { type: "string" }, what: { type: "string" } }, required: ["sev", "where", "what"] } } },
  required: ["findings"] };

const built = await agent(
  "Build throwaway src/spike/: fan-out N=5 vs tests/fake_engine.py, judge, synth, SSE keepalive, " +
  "terminal usage chunk. Then run make prove-lite (fake engine) and print stage timings, " +
  "mean candidate length, estimate-vs-billed deltas. Delete src/spike/ before committing.",
  { label: "build", model: "b200/qwen3.8-flash-next:medium", isolation: "worktree" });
const [contract, math] = await parallel([
  () => agent("Check spike SSE/usage contract against docs/specs/2026-11-14-fusion-endpoint-design.md §7.6; structured findings, quote file:line.",
    { label: "contract", agentType: "reviewer", model: "b200/qwen3.8-flash-next:medium",
      schema: FINDINGS_SCHEMA }),
  () => agent("Independently recompute spec §9 arithmetic vs the spike's measured usages; " +
    "flag any estimate-vs-billed gap >10% (estimator calibration input).",
    { label: "math", model: "b200/qwen3.8-flash-next:high", schema: FINDINGS_SCHEMA }),
]);
const findings = (r) => (r && typeof r === "object" && Array.isArray(r.findings))
  ? r.findings
  : [{ sev: "HIGH", where: "spike.workflow.js", what: "lane returned no schema-validated findings" }];
return { built: String(built).slice(0, 4000), contract: findings(contract), math: findings(math) };
