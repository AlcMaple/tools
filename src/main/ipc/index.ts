import { registerBgmIpc } from './bgm'
import { registerXifanIpc } from './xifan'
import { registerGirigiriIpc } from './girigiri'
import { registerAowuIpc } from './aowu'
import { registerLibraryIpc } from './library'
import { registerSystemIpc } from './system'

export function registerAllIpc(): void {
  registerBgmIpc()
  registerXifanIpc()
  registerGirigiriIpc()
  registerAowuIpc()
  registerLibraryIpc()
  registerSystemIpc()
}

export { getMinimizeOnClose } from './system'
