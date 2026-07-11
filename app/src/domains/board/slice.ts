// Board domain AppState slice. Imports only entity types (never core/types).
import type { BoardTask, BoardCol } from '../../core/entities'

/** Kanban board state. */
export interface BoardSlice {
  tasks: BoardTask[]
  dragOverCol: BoardCol | null
  /** the New-task dialog, openable from anywhere (⌘N, command palette) */
  newTaskOpen: boolean
  /** one-shot handoff: open this task's detail when the board next renders
   *  (set by addon focusTask / deep links, cleared by the board) */
  focusTaskId: string | null
}

/** Initial board slice for a fresh app state. */
export function freshBoardSlice(): BoardSlice {
  return { tasks: [], dragOverCol: null, newTaskOpen: false, focusTaskId: null }
}
