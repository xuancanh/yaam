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

// registry/src/github-issues/src/hooks/onTaskMoved.ts
var onTaskMoved_exports = {};
__export(onTaskMoved_exports, {
  default: () => onTaskMoved_default
});
module.exports = __toCommonJS(onTaskMoved_exports);
var handler = async (input, api) => {
  if (input.col !== "done") return;
  const cfg = await api.storage.get("config") || {};
  if (!cfg.autoClose) return;
  const issues = await api.storage.get("issues") || [];
  const iss = issues.find((i) => i.state === "synced" && i.taskId === input.taskId && !i.closed);
  if (!iss) return;
  const secrets = await api.secrets.list();
  if (!secrets.some((s) => s.name === "GITHUB_TOKEN" && s.set)) {
    await api.logEvent(`GitHub Issues: cannot close #${iss.number} \u2014 no GITHUB_TOKEN stored`);
    return;
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: "Bearer {{secret:GITHUB_TOKEN}}",
    "content-type": "application/json"
  };
  await api.http.request(
    "POST",
    `https://api.github.com/repos/${iss.repo}/issues/${iss.number}/comments`,
    { headers, body: JSON.stringify({ body: `Resolved by the linked yaam board task: "${String(input.title).slice(0, 120)}".` }) }
  ).catch(() => {
  });
  const res = await api.http.request(
    "PATCH",
    `https://api.github.com/repos/${iss.repo}/issues/${iss.number}`,
    { headers, body: JSON.stringify({ state: "closed" }) }
  );
  if (res.status === 200) {
    iss.closed = true;
    await api.storage.set("issues", issues);
    await api.notify("GitHub Issues", `Closed ${iss.repo}#${iss.number} \u2014 its task reached Done`);
  } else {
    await api.logEvent(`GitHub Issues: closing #${iss.number} failed \u2014 HTTP ${res.status}`);
  }
};
var onTaskMoved_default = handler;
const __handler = typeof module.exports === "function" ? module.exports : module.exports.default;
if (typeof __handler !== "function") throw new Error("handler module needs a default export function (input, api) => ...");
return await __handler(input, api);