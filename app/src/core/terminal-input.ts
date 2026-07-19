/** Reconstruct submitted terminal text from xterm's raw onData stream.
 * Programmatic PTY writes never pass through this tracker. */
export class TerminalInputBuffer {
  private chars: string[] = []
  private cursor = 0
  private bracketedPaste = false

  feed(data: string): string[] {
    const submitted: string[] = []
    let i = 0
    while (i < data.length) {
      if (data.startsWith('\x1b[200~', i)) { this.bracketedPaste = true; i += 6; continue }
      if (data.startsWith('\x1b[201~', i)) { this.bracketedPaste = false; i += 6; continue }

      const cp = data.codePointAt(i)
      if (cp === undefined) break
      const ch = String.fromCodePoint(cp)

      if (ch === '\x1b') {
        // eslint-disable-next-line no-control-regex -- xterm sends literal ESC-prefixed CSI sequences
        const seq = data.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/)?.[0]
        if (seq) {
          this.applyCsi(seq)
          i += seq.length
        } else {
          i += ch.length
        }
        continue
      }

      if (ch === '\r' || ch === '\n') {
        if (this.bracketedPaste) this.insert('\n')
        else {
          submitted.push(this.value())
          this.clear()
          if (ch === '\r' && data[i + 1] === '\n') i++
        }
        i += ch.length
        continue
      }

      if (ch === '\x7f' || ch === '\b') this.backspace()
      else if (ch === '\x01') this.cursor = 0 // Ctrl+A
      else if (ch === '\x05') this.cursor = this.chars.length // Ctrl+E
      else if (ch === '\x15' || ch === '\x03') this.clear() // Ctrl+U / Ctrl+C
      else if (ch === '\x17') this.deleteWord() // Ctrl+W
      else if (cp >= 0x20 && cp !== 0x7f) this.insert(ch)
      i += ch.length
    }
    return submitted
  }

  private value(): string { return this.chars.join('').slice(0, 4000) }
  private clear() { this.chars = []; this.cursor = 0; this.bracketedPaste = false }
  private insert(ch: string) {
    this.chars.splice(this.cursor, 0, ch)
    this.cursor++
    if (this.chars.length > 4000) {
      const drop = this.chars.length - 4000
      this.chars.splice(0, drop)
      this.cursor = Math.max(0, this.cursor - drop)
    }
  }
  private backspace() {
    if (this.cursor <= 0) return
    this.chars.splice(--this.cursor, 1)
  }
  private deleteWord() {
    while (this.cursor > 0 && /\s/.test(this.chars[this.cursor - 1])) this.backspace()
    while (this.cursor > 0 && !/\s/.test(this.chars[this.cursor - 1])) this.backspace()
  }
  private applyCsi(seq: string) {
    const final = seq.at(-1)
    if (final === 'D') this.cursor = Math.max(0, this.cursor - 1)
    else if (final === 'C') this.cursor = Math.min(this.chars.length, this.cursor + 1)
    else if (final === 'H') this.cursor = 0
    else if (final === 'F') this.cursor = this.chars.length
    else if (seq.endsWith('3~') && this.cursor < this.chars.length) this.chars.splice(this.cursor, 1)
  }
}
