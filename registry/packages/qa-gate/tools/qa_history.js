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

// registry/src/qa-gate/src/tools/qa_history.ts
var qa_history_exports = {};
__export(qa_history_exports, {
  default: () => qa_history_default
});
module.exports = __toCommonJS(qa_history_exports);
var handler = async (input, api) => {
  const audits = (api.storage.get("audits") || []).slice().reverse();
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 10));
  if (!audits.length) return "No QA audits recorded yet \u2014 audits run automatically when a task reaches review.";
  return audits.slice(0, limit).map((a) => {
    const when = new Date(a.at).toLocaleString();
    return `${a.verdict.toUpperCase().padEnd(7)} ${when} \xB7 "${a.title}"${a.detail ? ` \u2014 ${a.detail}` : ""}`;
  }).join("\n");
};
var qa_history_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);