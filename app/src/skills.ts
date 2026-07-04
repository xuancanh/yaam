// Skill registries: sources of reusable agent skills in the SKILL.md
// convention (a folder per skill with a SKILL.md carrying `name:` and
// `description:` frontmatter — the format of Anthropic's public skills repo,
// github.com/anthropics/skills). Supports GitHub tree URLs and local folders.
import { httpGetText, listDir, readTextFile } from './native'

export interface CatalogSkill {
  name: string
  description: string
  body: string
  /** registry name the skill came from */
  source: string
}

/** Tolerantly pull name/description out of SKILL.md frontmatter; returns the
 *  body with the frontmatter stripped. */
function parseSkillMd(text: string, fallbackName: string): { name: string; description: string; body: string } {
  let name = fallbackName
  let description = ''
  let body = text
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (m) {
    body = text.slice(m[0].length)
    for (const line of m[1].split('\n')) {
      const nm = line.match(/^name:\s*(.+)$/)
      if (nm) name = nm[1].trim().replace(/^["']|["']$/g, '')
      const dm = line.match(/^description:\s*(.+)$/)
      if (dm) description = dm[1].trim().replace(/^["']|["']$/g, '')
    }
  }
  if (!description) description = body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim().slice(0, 160) ?? ''
  return { name, description, body: body.trim() }
}

/** github.com/<owner>/<repo>/tree/<branch>/<path> → API + raw endpoints */
function parseGithubTree(url: string): { owner: string; repo: string; branch: string; path: string } | null {
  const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+?)\/?$/)
  return m ? { owner: m[1], repo: m[2], branch: m[3], path: m[4] } : null
}

async function fetchGithubRegistry(source: string, url: string): Promise<CatalogSkill[]> {
  const gh = parseGithubTree(url)
  if (!gh) throw new Error('expected a GitHub tree URL like https://github.com/anthropics/skills/tree/main/skills')
  const listing = JSON.parse(await httpGetText(
    `https://api.github.com/repos/${gh.owner}/${gh.repo}/contents/${gh.path}?ref=${gh.branch}`,
  )) as { name: string; type: string }[]
  if (!Array.isArray(listing)) throw new Error('unexpected GitHub API response')
  const dirs = listing.filter(e => e.type === 'dir')
  const raw = (dir: string) => `https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${gh.branch}/${gh.path}/${dir}/SKILL.md`
  const skills = await Promise.all(dirs.map(async d => {
    try {
      const text = await httpGetText(raw(d.name))
      return { ...parseSkillMd(text, d.name), source }
    } catch {
      return null // dir without a SKILL.md
    }
  }))
  return skills.filter((x): x is CatalogSkill => !!x)
}

async function fetchLocalRegistry(source: string, path: string): Promise<CatalogSkill[]> {
  const entries = await listDir(path)
  const skills = await Promise.all(entries.map(async e => {
    try {
      if (e.isDir) {
        const text = await readTextFile(`${e.path}/SKILL.md`)
        return { ...parseSkillMd(text, e.name), source }
      }
      if (/\.md$/i.test(e.name) && e.name.toLowerCase() !== 'readme.md') {
        const text = await readTextFile(e.path)
        return { ...parseSkillMd(text, e.name.replace(/\.md$/i, '')), source }
      }
    } catch { /* not a skill */ }
    return null
  }))
  return skills.filter((x): x is CatalogSkill => !!x)
}

/** Fetch a registry's full skill catalog (bodies included — SKILL.md is small). */
export function fetchSkillRegistry(source: string, url: string): Promise<CatalogSkill[]> {
  return /^https?:\/\//.test(url) ? fetchGithubRegistry(source, url) : fetchLocalRegistry(source, url)
}
