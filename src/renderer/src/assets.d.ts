// 静态资源模块声明。必须放在「非模块」的 .d.ts 里（本文件无顶层 import/export）——
// 一旦文件成了模块，`declare module '*.png'` 这类通配声明就不再是全局环境声明，
// 相对路径导入 .png 会报 TS2307。env.d.ts 因含顶层 import 已是模块，故拆出此文件。
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
