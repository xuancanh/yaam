#!/usr/bin/env node
// Scaffold a YAAM addon. No dependencies — copies a template, fills
// placeholders, and links the SDK packages (file: inside the yaam repo,
// versions elsewhere).
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')

function usage(code) {
  console.log(`create-yaam-addon — scaffold a YAAM addon

usage:
  npm create yaam-addon <dir> [-- --template react-ts|vanilla --name "My Addon" --icon 🧩]

templates:
  react-ts   React + TypeScript + Vite, built by yaam-addon into the addon format (default)
  vanilla    plain single-file view.html + addon.yaml, no build step
`)
  process.exit(code)
}

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}

const template = flag('--template') ?? 'react-ts'
const icon = flag('--icon') ?? '🧩'
let name = flag('--name')
if (args.includes('--help') || args.includes('-h')) usage(0)
const dir = args[0]
if (!dir) usage(1)
if (!existsSync(join(TEMPLATES_DIR, template))) {
  console.error(`unknown template "${template}" (have: ${readdirSync(TEMPLATES_DIR).join(', ')})`)
  process.exit(1)
}

const target = resolve(dir)
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`${target} exists and is not empty`)
  process.exit(1)
}
name ??= basename(target)
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-addon'

// Inside the yaam repo (or any checkout that has sdk/addon-sdk), link the
// workspace packages so the scaffold works before anything is published.
function findSdkRoot(from) {
  for (let d = from; ; d = dirname(d)) {
    if (existsSync(join(d, 'sdk', 'addon-sdk', 'package.json'))) return join(d, 'sdk')
    if (dirname(d) === d) return null
  }
}
const sdkRoot = findSdkRoot(target)
const dep = pkg => sdkRoot
  ? `file:${relative(target, join(sdkRoot, pkg)).split('\\').join('/')}`
  : '^0.1.0'

cpSync(join(TEMPLATES_DIR, template), target, { recursive: true })

// placeholder substitution in every text file
const fill = file => {
  const text = readFileSync(file, 'utf8')
  const out = text
    .replaceAll('__ADDON_NAME__', name)
    .replaceAll('__ADDON_SLUG__', slug)
    .replaceAll('__ICON__', icon)
    .replaceAll('__ADDON_SDK_DEP__', dep('addon-sdk'))
    .replaceAll('__YAAM_ADDON_DEP__', dep('yaam-addon'))
  if (out !== text) writeFileSync(file, out)
}
const walk = d => {
  for (const entry of readdirSync(d)) {
    const p = join(d, entry)
    if (statSync(p).isDirectory()) walk(p)
    else fill(p)
  }
}
walk(target)

// npm strips dotfiles from published packages; ship them prefixed
for (const [from, to] of [['_gitignore', '.gitignore']]) {
  if (existsSync(join(target, from))) renameSync(join(target, from), join(target, to))
}

console.log(`created ${name} (${template}) in ${target}\n`)
console.log(['next steps:',
  `  cd ${relative(process.cwd(), target) || '.'}`,
  ...(template === 'react-ts'
    ? ['  npm install', '  npm run dev        # browser + mock host, HMR', '  npm run build      # → dist/ (install via YAAM → Addons → Install from folder)', '  npm run pack       # → a shareable .yaam.json']
    : ['  edit addon.yaml + view.html', '  install: YAAM → Addons → Install from folder']),
].join('\n'))
