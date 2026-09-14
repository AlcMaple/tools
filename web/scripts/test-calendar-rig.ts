import assert from 'node:assert/strict'
import { clampRigPosition } from '../src/CalendarPage'

let checks = 0
function check(name: string, run: () => void) {
  run()
  console.log(`PASS ${++checks} ${name}`)
}
const desktop = { left: 0, top: 0, width: 1280, height: 720 }
const sticker = { width: 260, height: 380 }
check('左上角不再受周历内容列或最大位移限制', () => {
  assert.deepEqual(clampRigPosition({ x: -10000, y: -10000 }, desktop, sticker), { x: 8, y: 8 })
})
check('右下角保留完整人物和气泡', () => {
  assert.deepEqual(clampRigPosition({ x: 10000, y: 10000 }, desktop, sticker), { x: 1012, y: 332 })
})
check('视口内任意位置保持不变', () => {
  for (const x of [8, 150, 300, 700, 1012]) for (const y of [8, 100, 250, 332]) {
    assert.deepEqual(clampRigPosition({ x, y }, desktop, sticker), { x, y })
  }
})
check('桌面切手机后夹回手机可视范围', () => {
  assert.deepEqual(clampRigPosition({ x: 1012, y: 332 }, { ...desktop, width: 390, height: 844 }, { width: 330, height: 96 }), { x: 52, y: 332 })
})
check('缩放视口偏移纳入边界', () => {
  assert.deepEqual(clampRigPosition({ x: -10, y: -10 }, { left: 120, top: 80, width: 600, height: 400 }, sticker), { x: 128, y: 88 })
})
check('极小视口不产生反向区间', () => {
  assert.deepEqual(clampRigPosition({ x: 1000, y: 1000 }, { left: 0, top: 0, width: 100, height: 100 }, sticker), { x: 8, y: 8 })
})
check('气泡变高时底部仍在视口内', () => {
  const result = clampRigPosition({ x: 20, y: 332 }, desktop, { ...sticker, height: 420 })
  assert.equal(result.y + 420, 712)
})
console.log(`RESULT ${checks} checks passed`)
