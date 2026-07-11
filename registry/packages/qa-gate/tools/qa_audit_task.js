const module = { exports: {} };
const exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// registry/src/qa-gate/src/tools/qa_audit_task.ts
var qa_audit_task_exports = {};
__export(qa_audit_task_exports, {
  default: () => qa_audit_task_default
});
module.exports = __toCommonJS(qa_audit_task_exports);
var handler = async (input, api) => {
  const state = api.getState();
  const task = state.tasks.find((t) => t.id === input.task_id);
  if (!task) return `no board task with id ${input.task_id}`;
  const audits = api.storage.get("audits") || [];
  if (audits.some((a) => a.taskId === task.id && a.verdict === "running")) return "an audit is already running for that task";
  const criteria = (task.criteria || []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none recorded \u2014 judge from the description)";
  const prompt = [
    "You are an independent QA auditor. Verify whether this task's acceptance criteria are ACTUALLY met in the current workspace \u2014 run checks and inspect files; never trust claims and never modify anything.",
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : "",
    `Acceptance criteria:
${criteria}`,
    'Finish with exactly one line "QA VERDICT: pass" or "QA VERDICT: fail \u2014 <reason>", preceded by a short evidence list.'
  ].filter(Boolean).join("\n\n");
  const quoted = "'" + prompt.replace(/'/g, "'\\''") + "'";
  const sid = api.launchSession(`claude -p --permission-mode plan ${quoted}`, task.cwd || "", `qa\xB7${task.title.slice(0, 14)}`);
  if (!sid) return "failed to launch the auditor session";
  api.storage.set("audits", [...audits, { taskId: task.id, title: task.title, at: Date.now(), sessionId: sid, verdict: "running", detail: "" }].slice(-50));
  api.tasks.chat(task.id, "QA Gate: a manual audit was requested \u2014 the auditor session is re-verifying the acceptance criteria now.");
  return `auditor session started for "${task.title}" \u2014 the verdict will be posted to the task chat and recorded in qa_history`;
};
var qa_audit_task_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);