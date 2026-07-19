# YAAM documentation

These documents describe the current implementation. When code and an older
planning document disagree, the implementation documents below are canonical.

## Implementation references

- [System architecture](architecture.md) — processes, runtime composition,
  state, data flows, persistence, technologies, and operating constraints.
- [Frontend domains](frontend-domains.md) — React/application-runtime domains,
  their state, actions, services, UI, dependencies, and tests.
- [Backend domains](backend-domains.md) — Rust/Tauri domains and the IPC command
  boundary.
- [Security model](security.md) — trust zones, authorization layers, secret and
  filesystem handling, addon isolation, and known limitations.
- [Current implementation design](design-runtime-2026-07.md) — the July 2026
  design chapter for workspace ownership, remote control, terminal/files
  boundaries, sandboxing, and persistence.
- [Session sandbox audit (2026-07)](sandbox-audit-2026-07.md) — threat model,
  findings, executed hardening, lifecycle coverage, and residual limitations.
- [Addon architecture and authoring](addons.md) — package format, permissions,
  view bridge, handlers, hooks, agents, and registry format.

## Product and contributor references

- [Product overview](../README.md)
- [Planning documents](planning/README.md)
- [Original product roadmap](planning/roadmap.md)
- [Session-first roadmap proposal](planning/roadmap-session-first.md)
- [Development guide](../DEVELOPMENT.md)
- [Repository agent context](../AGENTS.md)
- [Chat revamp record](planning/chat-revamp.md)

## Historical design and review documents

These explain why the current architecture changed, but do not describe the
current runtime exactly:

- [Original store domain refactor plan](planning/store-domain-refactor-plan.md)
- [Store refactor progress review](planning/store-refactor-progress-review.md)
- [Broader rearchitecture hotspots](planning/rearchitecture-hotspots.md)

The `design/` directory is the original HTML visual prototype. Runtime behavior
is defined by `app/src` and `app/src-tauri/src`; the current implementation
design chapter above records the decisions that the visual prototype does not.
