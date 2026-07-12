const module = { exports: {} };
const exports = module.exports;
"use strict";
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

// registry/src/workflows/src/hooks/onTaskMoved.ts
var onTaskMoved_exports = {};
__export(onTaskMoved_exports, {
  default: () => onTaskMoved_default
});
module.exports = __toCommonJS(onTaskMoved_exports);
var handler = async (input, api) => {
  if (input.col !== "done" && input.col !== "failed") return;
  const runs = await api.storage.get("runs") || [];
  const run = runs.find((r) => r.status === "running" && r.taskId === input.taskId);
  if (!run) return;
  const workflows = await api.storage.get("workflows") || [];
  const wf = workflows.find((w) => w.id === run.wfId);
  const node = wf && wf.nodes.find((n) => n.id === run.current);
  const outcome = input.col === "done" ? "done" : "failed";
  const last = run.path[run.path.length - 1];
  if (last && last.taskId === input.taskId) last.outcome = outcome;
  const nextId = node ? outcome === "done" ? node.onDone : node.onFail : null;
  const next = nextId && wf ? wf.nodes.find((n) => n.id === nextId) : null;
  const halt = async (status, why) => {
    run.status = status;
    run.current = null;
    run.taskId = null;
    run.finishedAt = Date.now();
    await api.storage.set("runs", runs);
    await api.notify(
      status === "done" ? "Workflow finished" : "Workflow failed",
      `"${run.wfName}" \u2014 ${why}`
    );
  };
  if (!next) {
    await halt(outcome, outcome === "done" ? `halted after "${input.title}" (terminal step)` : `step "${input.title}" failed with no failure transition`);
    return;
  }
  const visits = (run.visits[next.id] || 0) + 1;
  const cap = Number(next.maxVisits) > 0 ? Number(next.maxVisits) : 3;
  if (visits > cap) {
    await halt("failed", `step "${next.title}" exceeded its ${cap}-visit cap \u2014 breaking the loop`);
    return;
  }
  const taskId = await api.tasks.add(next.title, "backlog", {
    description: [
      `[workflow "${wf.name}" \xB7 run ${run.id} \xB7 step ${next.id} \xB7 visit ${visits}]`,
      outcome === "failed" ? `You are the failure branch: the previous step "${node.title}" FAILED \u2014 diagnose and remedy before/while doing your own work.` : "",
      next.description || ""
    ].filter(Boolean).join("\n\n"),
    criteria: next.criteria || [],
    cwd: next.cwd || void 0,
    isolate: next.isolate === true ? true : void 0
  });
  run.current = next.id;
  run.taskId = taskId;
  run.visits[next.id] = visits;
  run.path.push({ nodeId: next.id, title: next.title, taskId, outcome: "running", at: Date.now(), via: outcome });
  await api.storage.set("runs", runs);
  await api.tasks.start(taskId);
  await api.logEvent(`workflow "${run.wfName}": ${outcome === "done" ? "\u2713" : "\u2717"} "${input.title}" \u2192 "${next.title}"${visits > 1 ? " (visit " + visits + ")" : ""}`);
};
var onTaskMoved_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);