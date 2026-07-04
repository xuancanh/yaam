#!/usr/bin/env node
// Pack a folder-format addon into a single-file *.yaam.json for URL/registry
// distribution. Mirrors the in-app loader (app/src/addons.ts):
//   node scripts/pack-addon.mjs registry/packages/qa-gate [out.yaam.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: node scripts/pack-addon.mjs <addon-folder> [out.yaam.json]')
  process.exit(1)
}

// ---- strict YAML subset (same rules as the in-app parser) ----
function parseSimpleYaml(text) {
  const lines = text.split('\n')
  let i = 0
  const err = (msg, ln) => { throw new Error(`manifest line ${ln + 1}: ${msg}`) }
  const indentOf = l => l.match(/^ */)[0].length
  const scalar = v => {
    const t = v.trim()
    if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) || (t.startsWith("'") && t.endsWith("'") && t.length > 1)) return t.slice(1, -1)
    if (t === 'true') return true
    if (t === 'false') return false
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return t
  }
  const skipBlank = () => { while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('#'))) i++ }
  const MAP_RE = /^([^:#]+?):(?:\s+(.*))?$/
  function parseBlock(indent) {
    skipBlank()
    if (i >= lines.length || indentOf(lines[i]) < indent) return {}
    return lines[i].trim().startsWith('-') ? parseList(indentOf(lines[i])) : parseMap(indentOf(lines[i]))
  }
  function parseMap(indent) {
    const out = {}
    for (;;) {
      skipBlank()
      if (i >= lines.length) break
      const cur = indentOf(lines[i])
      if (cur < indent) break
      if (cur > indent) err('unexpected indentation', i)
      const t = lines[i].trim()
      if (t.startsWith('-')) err('unexpected list item (expected "key: value")', i)
      const m = t.match(MAP_RE)
      if (!m) err(`expected "key: value", got "${t}"`, i)
      const [, key, rest] = m
      i++
      out[key.trim()] = rest === undefined || rest === '' ? parseBlock(indent + 2) : scalar(rest)
    }
    return out
  }
  function parseList(indent) {
    const out = []
    for (;;) {
      skipBlank()
      if (i >= lines.length) break
      const cur = indentOf(lines[i])
      if (cur < indent || !lines[i].trim().startsWith('-')) break
      const rest = lines[i].trim().slice(1).trim()
      if (!rest) { i++; out.push(parseBlock(indent + 2)); continue }
      if (MAP_RE.test(rest) && !/^["']/.test(rest)) {
        lines[i] = ' '.repeat(indent + 2) + rest
        out.push(parseMap(indent + 2))
      } else {
        i++
        out.push(scalar(rest))
      }
    }
    return out
  }
  return parseMap(0)
}

const FILE_REF = /\.(js|html|txt|md)$/i
const SHORTHAND_TYPES = ['string', 'number', 'boolean', 'array', 'object']

function expandInputShorthand(input) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(input)) {
    const [head, ...rest] = String(spec).split(/\s*[·–-]\s+/)
    let type = head.trim()
    if (type.endsWith('!')) { required.push(key); type = type.slice(0, -1) }
    if (!SHORTHAND_TYPES.includes(type)) throw new Error(`tool input "${key}": unknown type "${type}"`)
    properties[key] = {
      type,
      ...(type === 'array' ? { items: { type: 'string' } } : {}),
      ...(rest.length ? { description: rest.join(' ') } : {}),
    }
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

// ---- resolve ----
const manifestName = ['addon.yaml', 'addon.yml', 'addon.json'].find(c => existsSync(join(dir, c)))
if (!manifestName) {
  console.error(`no addon.yaml / addon.yml / addon.json in ${dir}`)
  process.exit(1)
}
const manifestText = readFileSync(join(dir, manifestName), 'utf8')
const raw = manifestText.trim().startsWith('{') ? JSON.parse(manifestText) : parseSimpleYaml(manifestText)
const readRef = rel => readFileSync(join(dir, rel), 'utf8')
const ref = v => (typeof v === 'string' && v.trim() && FILE_REF.test(v.trim()) ? readRef(v.trim()) : v)

const out = { ...raw }
if (typeof raw.view === 'string') {
  out.html = readRef(raw.view.trim())
  delete out.view
}
if (Array.isArray(raw.tools)) {
  out.tools = raw.tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema ?? (t.input && typeof t.input === 'object' ? expandInputShorthand(t.input) : undefined),
    handler: ref(t.handler),
  }))
}
if (raw.hooks && typeof raw.hooks === 'object') {
  out.hooks = Object.fromEntries(Object.entries(raw.hooks).map(([k, v]) => [k, ref(v)]))
}
if (raw.agent && typeof raw.agent === 'object') {
  out.agent = { ...raw.agent, system: ref(raw.agent.system) }
}

const target = process.argv[3] ?? join(dir, '..', `${basename(dir)}.yaam.json`)
writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(`packed ${dir} → ${target}`)
