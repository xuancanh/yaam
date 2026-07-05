// File-type icon for explorer trees and viewers. On macOS it shows the real
// system (Finder) icon, fetched once per extension through the Rust bridge and
// cached for the app's lifetime. Elsewhere — or while loading / on failure —
// it falls back to a colored per-type glyph so file types are still
// distinguishable at a glance.
import { useEffect, useState } from 'react'
import { fileIcon, isTauri } from '../core/native'
import { Icon } from './ui'

// GitHub-linguist-inspired language colors for the glyph fallback.
const EXT_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#3178c6', mts: '#3178c6', cts: '#3178c6',
  js: '#e8d44d', jsx: '#e8d44d', mjs: '#e8d44d', cjs: '#e8d44d',
  py: '#3572a5', rb: '#701516', rs: '#dea584', go: '#00add8',
  java: '#b07219', kt: '#a97bff', swift: '#f05138', c: '#555555',
  h: '#555555', cpp: '#f34b7d', hpp: '#f34b7d', cs: '#178600',
  php: '#4f5d95', sh: '#89e051', bash: '#89e051', zsh: '#89e051', fish: '#89e051',
  html: '#e34c26', css: '#563d7c', scss: '#c6538c', less: '#1d365d',
  json: '#cbcb41', jsonc: '#cbcb41', yaml: '#cb171e', yml: '#cb171e',
  toml: '#9c4221', xml: '#0060ac', svg: '#ffb13b',
  md: '#519aba', markdown: '#519aba', mdx: '#519aba', txt: '#8b93a1',
  sql: '#e38c00', graphql: '#e10098', proto: '#4a76c9',
  vue: '#41b883', svelte: '#ff3e00', astro: '#ff5a03',
  lock: '#8b93a1', env: '#ecd53f', gitignore: '#f14e32', dockerfile: '#384d54',
  png: '#26a69a', jpg: '#26a69a', jpeg: '#26a69a', gif: '#26a69a', webp: '#26a69a', ico: '#26a69a', bmp: '#26a69a',
  pdf: '#e53935', docx: '#2b579a', xlsx: '#217346', pptx: '#d24726', csv: '#217346',
  zip: '#a1887f', tar: '#a1887f', gz: '#a1887f', dmg: '#a1887f',
  mp4: '#7e57c2', mov: '#7e57c2', mp3: '#7e57c2', wav: '#7e57c2',
}

/** Cache key: file types render alike, so one fetch per extension (plus a few
 *  well-known extensionless names) covers the whole tree. */
function keyFor(name: string, isDir: boolean): string {
  if (isDir) return ':dir'
  const lower = name.toLowerCase().replace(/^\.+/, '') // dotfiles key by name
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : `:name:${lower}`
}

// data URL per key, null = system icon unavailable (glyph fallback stays)
const cache = new Map<string, string | null>()
const inflight = new Map<string, Promise<string | null>>()

function loadIcon(key: string, path: string): Promise<string | null> {
  let p = inflight.get(key)
  if (!p) {
    p = fileIcon(path)
      .then(b64 => `data:image/png;base64,${b64}`)
      .catch(() => null)
      .then(url => {
        cache.set(key, url)
        inflight.delete(key)
        return url
      })
    inflight.set(key, p)
  }
  return p
}

/** Colored per-type glyph: known types get a tinted file icon, directories a
 *  folder — used outside macOS and while the system icon loads. */
function GlyphIcon({ name, isDir, size }: { name: string; isDir: boolean; size: number }) {
  if (isDir) return <Icon paths={['M3 7a2 2 0 012-2h4l2 2h9a1 1 0 011 1v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z']} size={size} stroke={1.6} />
  const key = keyFor(name, false)
  const color = EXT_COLORS[key.startsWith(':name:') ? key.slice(6) : key]
  return (
    <span style={{ color: color ?? 'inherit', display: 'inline-flex', flexShrink: 0 }}>
      <Icon paths={['M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z', 'M14 3v5h5']} size={size} stroke={1.6} />
    </span>
  )
}

export function FileIcon({ name, path, isDir, size = 14 }: {
  name: string
  /** full path — used once per extension to fetch the system icon */
  path: string
  isDir: boolean
  size?: number
}) {
  const key = keyFor(name, isDir)
  const [url, setUrl] = useState<string | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    if (!isTauri || cache.get(key) !== undefined) {
      setUrl(cache.get(key) ?? null)
      return
    }
    let live = true
    void loadIcon(key, path).then(u => { if (live) setUrl(u) })
    return () => { live = false }
  }, [key, path])

  if (url) return <img src={url} alt="" width={size} height={size} style={{ flexShrink: 0, objectFit: 'contain' }} />
  return <GlyphIcon name={name} isDir={isDir} size={size} />
}
