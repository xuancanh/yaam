import { describe, expect, it, beforeEach } from 'vitest'
import { applyTranscriptLines, dropTranscriptEvents, resetTranscriptEvents, transcriptEventsFor } from './transcript-events'
import { useAppStore } from '../../core/store'
import type { Agent, AppState } from '../../core/types'

const agent = (over: Partial<Agent>): Agent =>
  ({ id: 'a1', name: 'A', status: 'running', kind: 'real', log: [], memory: [], tools: [], ...over }) as unknown as Agent
const stateRef = { get current() { return useAppStore.getState() } }

beforeEach(() => {
  resetTranscriptEvents()
  useAppStore.setState({ agents: [agent({})] } as Partial<AppState> as AppState)
})

describe('applyTranscriptLines', () => {
  it('parses JSONL into the session ring and skips junk lines', () => {
    applyTranscriptLines({ stateRef }, {
      agent: 'a1',
      lines: ['{"type":"user"}', 'not json', '{"type":"assistant","message":{}}'],
    })
    expect(transcriptEventsFor('a1').map(e => e.type)).toEqual(['user', 'assistant'])
  })

  it('marks a running session as responding when assistant events stream', () => {
    applyTranscriptLines({ stateRef }, { agent: 'a1', lines: ['{"type":"assistant"}'] })
    expect(useAppStore.getState().agents[0].responding).toBe(true)
  })

  it('treats codex rollout items as activity too', () => {
    applyTranscriptLines({ stateRef }, { agent: 'a1', lines: ['{"type":"response_item","payload":{}}'] })
    expect(useAppStore.getState().agents[0].responding).toBe(true)
  })

  it('caps the ring and ignores unknown or archived sessions', () => {
    const lines = Array.from({ length: 120 }, (_, i) => `{"type":"user","i":${i}}`)
    applyTranscriptLines({ stateRef }, { agent: 'a1', lines })
    expect(transcriptEventsFor('a1')).toHaveLength(100)
    expect(transcriptEventsFor('a1')[0].i).toBe(20)

    applyTranscriptLines({ stateRef }, { agent: 'ghost', lines: ['{"type":"user"}'] })
    expect(transcriptEventsFor('ghost')).toHaveLength(0)

    useAppStore.setState({ agents: [agent({ archived: true })] } as Partial<AppState> as AppState)
    dropTranscriptEvents('a1')
    applyTranscriptLines({ stateRef }, { agent: 'a1', lines: ['{"type":"user"}'] })
    expect(transcriptEventsFor('a1')).toHaveLength(0)
  })
})
