# YAAM application

This directory contains the React 19 frontend and Tauri 2 desktop backend for YAAM.

- Start with the repository [README](../README.md) for product behavior.
- Read the [development guide](../DEVELOPMENT.md) for architecture, data flows, constraints, and verification.
- Read the [addon reference](../docs/addons.md) when changing the addon API or package format.

Run application commands from this directory:

```sh
npm install
npm run tauri dev
npx tsc --noEmit
npm run lint
(cd src-tauri && cargo check)
```
