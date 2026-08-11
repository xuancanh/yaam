// Runtime-only provenance for the "needs input" flag. The deterministic
// scanner (settle scan + TUI scan) may auto-clear a flag only when it set that
// flag itself: a monitor/watcher/Master flag is context-aware, and the regex
// heuristics must not undo it just because they don't recognize the prompt.
// Never persisted — a flag with no recorded source is treated as LLM-authored
// (the safe default: the scanner leaves it alone).

const scannerFlags = new Set<string>()
const hookFlags = new Set<string>()

/** record that the deterministic scanner raised this session's needs-input flag */
export const markScannerNeedsFlag = (id: string): void => { scannerFlags.add(id); hookFlags.delete(id) }

/** true when this session's current needs-input flag was raised by the scanner */
export const isScannerNeedsFlag = (id: string): boolean => scannerFlags.has(id)

/** record that a CLI lifecycle hook raised this session's needs-input flag */
export const markHookNeedsFlag = (id: string): void => { hookFlags.add(id); scannerFlags.delete(id) }

/** true when this session's current needs-input flag came from a CLI hook */
export const isHookNeedsFlag = (id: string): boolean => hookFlags.has(id)

/** drop the provenance record (flag cleared/answered, session disposed) */
export const clearNeedsFlagSource = (id: string): void => { scannerFlags.delete(id); hookFlags.delete(id) }

/** full teardown (settle runtime dispose) */
export const resetNeedsFlagSources = (): void => { scannerFlags.clear(); hookFlags.clear() }
