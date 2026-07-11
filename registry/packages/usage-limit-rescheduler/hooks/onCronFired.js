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

// registry/src/usage-limit-rescheduler/src/hooks/onCronFired.ts
var onCronFired_exports = {};
__export(onCronFired_exports, {
  default: () => onCronFired_default
});
module.exports = __toCommonJS(onCronFired_exports);
var handler = async (input, api) => {
  if (!String(input.name || "").startsWith("retry-")) return;
  const retries = await api.storage.get("retries") || {};
  const entry = retries[input.name];
  if (!entry) return;
  const task = await api.tasks.get(entry.taskId);
  if (!task) {
    delete retries[input.name];
    await api.storage.set("retries", retries);
    return;
  }
  if (task.col === "failed") {
    await api.tasks.restart(entry.taskId);
    await api.tasks.chat(entry.taskId, "Usage-Limit Rescheduler: the limit window has passed \u2014 restarting this task now (attempt " + (entry.attempts || 1) + ").");
    await api.notify("Task rescheduled", '"' + String(entry.title || task.title).slice(0, 60) + '" restarted after the usage-limit window');
  } else {
    await api.logEvent("retry " + input.name + " skipped \u2014 task already moved to " + task.col);
  }
  const history = await api.storage.get("history") || [];
  history.unshift({ at: Date.now(), taskId: entry.taskId, title: entry.title || task.title, attempts: entry.attempts || 1, outcome: task.col === "failed" ? "restarted" : "skipped (" + task.col + ")" });
  await api.storage.set("history", history.slice(0, 50));
  delete retries[input.name];
  await api.storage.set("retries", retries);
  await api.schedules.remove(input.name);
};
var onCronFired_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);