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

// registry/src/dev-kitchen-sink/src/tools/sink_echo.ts
var sink_echo_exports = {};
__export(sink_echo_exports, {
  default: () => sink_echo_default
});
module.exports = __toCommonJS(sink_echo_exports);
var handler = async (input, api) => {
  const state = api.getState();
  const summary = state ? `${state.sessions.length} session(s), ${state.tasks.length} task(s), $${state.totals.cost} spent` : "state:read not granted";
  return `echo: ${String(input.text)} \u2014 app right now: ${summary}`;
};
var sink_echo_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);