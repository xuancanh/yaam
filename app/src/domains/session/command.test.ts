import { describe, expect, it } from 'vitest'
import { envPrefix } from './command'

describe('envPrefix', () => {
  it('single-quotes literal values', () => {
    expect(envPrefix("A=1\nB=it's")).toBe(`A='1' B='it'\\''s' `)
    expect(envPrefix('# comment\n\nnot an assignment')).toBe('')
  })
  it('lets a bare $VAR / ${VAR} reference expand in the login shell', () => {
    expect(envPrefix('ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY')).toBe('ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY" ')
    expect(envPrefix('T=${KEY}')).toBe('T="$KEY" ')
    // anything beyond a bare reference stays literal (no command substitution)
    expect(envPrefix('T=$(whoami)')).toBe(`T='$(whoami)' `)
    expect(envPrefix('T=$A$B')).toBe(`T='$A$B' `)
  })
})
