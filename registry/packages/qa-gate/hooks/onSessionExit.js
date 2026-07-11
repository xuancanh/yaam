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

// registry/src/qa-gate/src/hooks/onSessionExit.ts
var onSessionExit_exports = {};
__export(onSessionExit_exports, {
  default: () => onSessionExit_default
});
module.exports = __toCommonJS(onSessionExit_exports);
var handler = async (input, api) => {
  const audits = api.storage.get("audits") || [];
  const idx = audits.findIndex((a2) => a2.sessionId === input.sessionId && a2.verdict === "running");
  if (idx < 0) return;
  const out = api.sessions.readOutput(input.sessionId, 60);
  const m = out.match(/QA VERDICT:\s*(pass|fail)\s*(?:[—-]\s*)?([^\n]*)/i);
  const verdict = m ? m[1].toLowerCase() : input.code === 0 ? "unclear" : "error";
  const detail = m && m[2] ? m[2].trim() : "";
  audits[idx] = { ...audits[idx], verdict, detail, doneAt: Date.now() };
  api.storage.set("audits", audits);
  const a = audits[idx];
  const line = verdict === "pass" ? "QA Gate verdict: PASS \u2014 criteria independently verified. Safe to mark done." : verdict === "fail" ? `QA Gate verdict: FAIL \u2014 ${detail || "see the auditor session output"}. Moving back to In progress; please address the findings.` : `QA Gate: the auditor exited without a clear verdict (${verdict}). Check its session output.`;
  api.tasks.chat(a.taskId, line);
  api.notify(`QA ${verdict.toUpperCase()}`, a.title.slice(0, 60));
  api.logEvent(`QA ${verdict} for "${a.title.slice(0, 40)}"`);
  if (verdict === "fail") api.tasks.move(a.taskId, "progress");
};
var onSessionExit_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);