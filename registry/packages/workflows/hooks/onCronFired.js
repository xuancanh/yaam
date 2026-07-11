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

// registry/src/workflows/src/hooks/onCronFired.ts
var onCronFired_exports = {};
__export(onCronFired_exports, {
  default: () => onCronFired_default
});
module.exports = __toCommonJS(onCronFired_exports);
var handler = async (input, api) => {
  if (!String(input.name || "").startsWith("wf-")) return;
  const wfId = String(input.name).slice(3);
  const workflows = await api.storage.get("workflows") || [];
  const wf = workflows.find((w) => w.id === wfId);
  if (!wf || !Array.isArray(wf.nodes) || !wf.nodes.length) return;
  if (wf.enabled === false) {
    await api.logEvent(`workflow "${wf.name}" ignored a cron trigger \u2014 workflow is paused`);
    return;
  }
  const runs = await api.storage.get("runs") || [];
  if (runs.some((r) => r.wfId === wf.id && r.status === "running")) {
    await api.logEvent(`workflow "${wf.name}" skipped a cron trigger \u2014 previous run still going`);
    return;
  }
  wf.runSeq = (wf.runSeq || 0) + 1;
  await api.storage.set("workflows", workflows);
  const start = wf.nodes.find((n) => n.id === wf.start) || wf.nodes[0];
  const run = {
    id: "run" + Date.now().toString(36),
    num: wf.runSeq,
    wfId: wf.id,
    wfName: wf.name,
    startedAt: Date.now(),
    status: "running",
    trigger: "cron",
    current: start.id,
    taskId: null,
    visits: {},
    path: []
  };
  const taskId = await api.tasks.add(start.title, "backlog", {
    description: [`[workflow "${wf.name}" \xB7 run ${run.id} \xB7 step ${start.id}]`, start.description || ""].filter(Boolean).join("\n\n"),
    criteria: start.criteria || [],
    cwd: start.cwd || void 0,
    isolate: start.isolate === true ? true : void 0
  });
  run.taskId = taskId;
  run.visits[start.id] = 1;
  run.path.push({ nodeId: start.id, title: start.title, taskId, outcome: "running", at: Date.now() });
  await api.storage.set("runs", [run, ...runs].slice(0, 30));
  await api.tasks.start(taskId);
  await api.notify("Workflow started", `"${wf.name}" \u2014 entered step "${start.title}"`);
};
var onCronFired_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);