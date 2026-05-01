import { registerBgmIpc } from './bgm'
import { registerXifanIpc } from './xifan'
import { registerGirigiriIpc } from './girigiri'
import { registerAowuIpc } from './aowu'
import { registerLibraryIpc } from './library'
import { registerSystemIpc } from './system'
import { registerFileExplorerIpc } from './fileExplorer'
import { registerWebDavIpc } from './webdav'

export function registerAllIpc(): void {
  registerBgmIpc()
  registerXifanIpc()
  registerGirigiriIpc()
  registerAowuIpc()
  registerLibraryIpc()
  registerSystemIpc()
  registerFileExplorerIpc()
  registerWebDavIpc()
}

export { getMinimizeOnClose } from './system'
