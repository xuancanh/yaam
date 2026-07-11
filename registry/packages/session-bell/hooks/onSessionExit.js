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

// registry/src/session-bell/src/hooks/onSessionExit.ts
var onSessionExit_exports = {};
__export(onSessionExit_exports, {
  default: () => onSessionExit_default
});
module.exports = __toCommonJS(onSessionExit_exports);
var handler = async (input, api) => {
  api.notify(`${input.name} exited`, input.code === 0 ? "finished cleanly" : `exit code ${input.code}`);
  api.flash(`${input.name} done`);
};
var onSessionExit_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);