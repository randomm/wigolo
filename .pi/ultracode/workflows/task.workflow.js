// Ultracode DSL, not plain Node: top-level `return` and ambient agent()/parallel()/args
// are legal inside the workflow executor's function wrapper — the node --check
// "Illegal return statement" at save time is expected, not a bug.
//
// API ground truth (pi-ultracode@0.11.0; examples/workflows/loop-until-dry-bugs.workflow.js
// consumes r.bugs / v.real directly, verified by selftest on live runtime 2026-11-15):
//   - agent(prompt, {schema}) resolves to the VALIDATED VALUE ITSELF (an object) — no
//     wrapper: not .value, not .summary. No schema -> resolves to the final text string.
//   - agent options are {label, phase, schema, model, isolation, agentType}; `output:` is
//     silently DROPPED by normalizeAgentOptions (runtime.ts:1628) -> free-text string.
//   - parallel() resolves to an array of lane results (null entries possible -> guard).
//   - workflow return value must be plain JSON (value-limits.ts:343) — no undefined props.
export const meta = { name: "task", description: "TDD one plan task: red, green, verify, commit" };
const { taskId } = args;                       // e.g. "M1-task-2"
const plan = "docs/superpowers/plans/2026-11-15-fusion-endpoint-p1.md";

const red = await agent(
  `Read ${plan} task ${taskId} (and its Interfaces block + Global Constraints). ` +
  `Write ONLY the failing tests named in that task. Run them; capture the failure output. ` +
  `Do not implement anything. Commit "test(<scope>): red for ${taskId}".`,
  { label: "red", model: "b200/qwen3.8-flash-next:low" });

const redQuote = String(red).slice(0, 4000);  // no schema -> string result

const green = await agent(
  `Read ${plan} task ${taskId}. Tests for it already exist and fail (red output below). ` +
  `Implement the minimal code to pass — smallest diff, no speculative features (AGENTS.md §4). ` +
  `Commit "feat(<scope>): ${taskId}".\n\nRED OUTPUT:\n${redQuote}`,
  { label: "green", model: "b200/qwen3.8-flash-next:medium", isolation: "worktree" });

const verify = await agent(
  `In the integrated tree, run: make prove. Also re-run task ${taskId}'s tests alone, then ` +
  `audit the diff against the plan's Interfaces block for scope creep (extra files/functions ` +
  `not in the task = FAIL with file:line).`,
  { label: "verify", model: "b200/qwen3.8-flash-next:low",
    schema: { type: "object", properties: {
      prove_green: { type: "boolean" }, task_tests_pass: { type: "boolean" },
      scope_creep: { type: "array", items: { type: "string" } } },
      required: ["prove_green", "task_tests_pass", "scope_creep"] } });

// verify IS the schema-validated object; guard the shape so a string/undefined can never
// vacuously satisfy the gate — the #14 failure class, now a tested expectation.
const v = (verify && typeof verify === "object") ? verify : {};
const gatesOk = v.prove_green === true && v.task_tests_pass === true
  && Array.isArray(v.scope_creep) && v.scope_creep.length === 0;
if (!gatesOk)
  return { status: "blocked", taskId, red: redQuote, verify: v,
           green: String(green).slice(0, 2000) };
return { status: "done", taskId };
