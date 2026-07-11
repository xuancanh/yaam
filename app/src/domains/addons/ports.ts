// Capability port for addon package IO: the file/folder pickers, save dialog,
// text file read/write, and HTTP fetch used to install and export addon
// packages. The addons actions drive these only through this interface, so they
// never import core/native directly and can be tested with fakes. The real
// implementation wires the interface to the actual Tauri IPC.
import * as native from '../../core/native'

export interface PackageIoPort {
  /** open-file dialog; resolves to the chosen path or null if cancelled */
  pickFile: () => Promise<string | null>
  /** open-folder dialog; resolves to the chosen directory or null if cancelled */
  pickFolder: () => Promise<string | null>
  /** save-file dialog seeded with a default name; null if cancelled */
  pickSavePath: (defaultName: string) => Promise<string | null>
  /** read a text file from disk; `root` canonically confines folder-package refs */
  readTextFile: (path: string, root?: string) => Promise<string>
  /** write a text file to disk */
  writeTextFile: (path: string, contents: string) => Promise<void>
  /** fetch a remote resource as text */
  httpGetText: (url: string) => Promise<string>
}

export const realPackageIoPort: PackageIoPort = {
  pickFile: () => native.pickFile(),
  pickFolder: () => native.pickFolder(),
  pickSavePath: name => native.pickSavePath(name),
  readTextFile: (path, root) => native.readTextFile(path, root),
  writeTextFile: (path, contents) => native.writeTextFile(path, contents),
  httpGetText: url => native.httpGetText(url),
}
