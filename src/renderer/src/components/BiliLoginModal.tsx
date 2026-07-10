// B 站扫码登录弹窗 —— 设置页「B 站账号」和播放页提示条共用这一个。
//
// 二维码走 TV 端接口(web 端扫码被 B 站风控挡了,手机确认弹「API校验密匙错误」),
// 生成/轮询/写 cookie 全在主进程,这里只负责显示和节奏。
//
// 轮询说明:每 2s 问一次「扫了没」是 B 站扫码协议本身的形态(不是 AI_GUIDELINES
// 里禁的「失败后自动重试/周期性探测」)——只在弹窗开着、二维码有效时问,弹窗一关
// 立刻停;任何一次请求真的失败(网络/接口异常)就停下来报错,交给用户点重试。
import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalShell, ModalButton } from '../pages/homework/shared'
import ErrorPanel from './ErrorPanel'

const POLL_INTERVAL_MS = 2000

type Phase =
  | { kind: 'creating' }
  | { kind: 'waiting'; qrDataUrl: string; scanned: boolean }
  | { kind: 'expired'; qrDataUrl: string }
  | { kind: 'error'; err: unknown }

export default function BiliLoginModal({
  onClose, onLoggedIn,
}: {
  onClose: () => void
  /** 扫码成功(cookie 已落进 persist:bili 分区)后回调,调用方刷新自己的登录态。 */
  onLoggedIn: () => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'creating' })
  // 弹窗卸载后所有在途的定时器 / 回包一律作废,避免关掉弹窗还在轮询
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const start = useCallback(async (): Promise<void> => {
    setPhase({ kind: 'creating' })
    let authCode: string
    let qrDataUrl: string
    try {
      const qr = await window.biliApi.createQr()
      if (!aliveRef.current) return
      authCode = qr.authCode
      qrDataUrl = qr.qrDataUrl
      setPhase({ kind: 'waiting', qrDataUrl, scanned: false })
    } catch (err) {
      if (aliveRef.current) setPhase({ kind: 'error', err })
      return
    }

    const tick = async (): Promise<void> => {
      if (!aliveRef.current) return
      try {
        const { state } = await window.biliApi.pollQr(authCode)
        if (!aliveRef.current) return
        if (state === 'ok') { onLoggedIn(); onClose(); return }
        if (state === 'expired') { setPhase({ kind: 'expired', qrDataUrl }); return }
        setPhase({ kind: 'waiting', qrDataUrl, scanned: state === 'scanned' })
        setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
      } catch (err) {
        // 轮询本身失败(断网/接口变了):停下来报错,不自己重试
        if (aliveRef.current) setPhase({ kind: 'error', err })
      }
    }
    setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
  }, [onClose, onLoggedIn])

  useEffect(() => { void start() }, [start])

  return (
    <ModalShell onBackdrop={onClose}>
      <div className="p-6 flex flex-col items-center gap-4">
        <div className="flex items-center gap-2 self-start text-on-surface">
          <span className="material-symbols-outlined text-primary leading-none" style={{ fontSize: 20 }}>qr_code_2</span>
          <h3 className="font-headline text-base font-bold">扫码登录 B 站</h3>
        </div>

        {phase.kind === 'error' ? (
          <div className="w-full py-2">
            <ErrorPanel error={phase.err} compact onRetry={() => { void start() }} />
          </div>
        ) : (
          <>
            {/* 二维码。白边已烤进 PNG,深色主题下也扫得出来 */}
            <div className="relative h-[232px] w-[232px] overflow-hidden rounded-xl bg-surface-container flex items-center justify-center">
              {phase.kind === 'creating' ? (
                <span className="material-symbols-outlined animate-spin text-on-surface-variant/50" style={{ fontSize: 32 }}>
                  progress_activity
                </span>
              ) : (
                <img src={phase.qrDataUrl} alt="B 站登录二维码" className="h-full w-full" />
              )}
              {phase.kind === 'expired' && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70">
                  <span className="font-label text-xs text-on-surface">二维码已失效</span>
                  <ModalButton variant="primary" icon="refresh" onClick={() => { void start() }}>
                    刷新
                  </ModalButton>
                </div>
              )}
            </div>

            <p className="font-label text-xs text-on-surface-variant/70 text-center">
              {phase.kind === 'waiting' && phase.scanned
                ? '已扫码,请在手机上点「确认」'
                : '用哔哩哔哩手机客户端扫码'}
            </p>
            <p className="font-label text-[10px] text-on-surface-variant/40 text-center leading-relaxed">
              登录态只保存在本机,用来向 B 站请求高画质播放地址。
            </p>
          </>
        )}

        <div className="w-full flex justify-end pt-1">
          <ModalButton variant="cancel" onClick={onClose}>关闭</ModalButton>
        </div>
      </div>
    </ModalShell>
  )
}
