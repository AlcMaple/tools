import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  drawReward,
  fetchRewardSummary,
  newRewardRequestId,
  redeemReward,
  type RewardShopItem,
  type RewardSummary,
} from './api'
import { useAuth } from './auth'
import { Ic, Spinner } from './SketchIcon'
import { toast } from './Toast'

const SHOP: Array<{
  item: RewardShopItem
  title: string
  note: string
  cost: number
  accent: string
  mark: string
}> = [
  { item: 'ticket_1', title: '放映券 ×1', note: '先替你收好一张。', cost: 50, accent: 'teal', mark: '×1' },
  { item: 'ticket_5', title: '放映券 ×5', note: '多备几张，不许一下用光哦。', cost: 200, accent: 'gold', mark: '×5' },
  { item: 'priority_7d', title: '7 天免券', note: '这一周，优先候补不收券。', cost: 300, accent: 'sakura', mark: '7日' },
  { item: 'priority_30d', title: '30 天免券', note: '整整三十天，都不用交券。', cost: 900, accent: 'lav', mark: '30日' },
]

const PRIZES = [
  ['10 星光', '45%'],
  ['返还 20 星光', '25%'],
  ['放映券 ×1', '20%'],
  ['放映券 ×2', '8%'],
  ['7 天免券', '1.8%'],
  ['30 天免券', '0.2%'],
] as const

const PRIZE_LABEL: Record<string, string> = {
  points_10: '10 星光',
  points_20: '20 星光全数返还',
  ticket_1: '优先放映券 ×1',
  ticket_2: '优先放映券 ×2',
  priority_7d: '7 天免券',
  priority_30d: '30 天免券',
}

function priorityText(until: number | null): string {
  if (!until || until <= Date.now()) return '0 天'
  return `${Math.max(1, Math.ceil((until - Date.now()) / 86_400_000))} 天`
}

function priorityTitle(until: number | null): string | undefined {
  if (!until || until <= Date.now()) return undefined
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(until)) + ' 到期'
}

function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
  const box = document.createElement('textarea')
  box.value = text
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.appendChild(box)
  box.select()
  document.execCommand('copy')
  box.remove()
  return Promise.resolve()
}

export function RewardsPage(): JSX.Element {
  const { user, ready } = useAuth()
  const [summary, setSummary] = useState<RewardSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [drawResult, setDrawResult] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setError('')
    try {
      setSummary(await fetchRewardSummary())
    } catch (err) {
      setError(err instanceof Error ? err.message : '福利手册暂时翻不开')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (user) void load()
  }, [load, user])

  const inviteLink = useMemo(() => {
    if (!summary?.inviteCode) return ''
    const url = new URL(window.location.origin + window.location.pathname)
    url.searchParams.set('invite', summary.inviteCode)
    return url.toString()
  }, [summary?.inviteCode])

  if (!ready || loading) {
    return (
      <div className="page-state reward-loading">
        <Spinner size={38} />
        <p className="faint small">等等，我还在数星光…</p>
      </div>
    )
  }
  if (!user) return <></>
  if (error || !summary) {
    return (
      <div className="empty panel reward-empty">
        <img className="mascot" src="/assets/sagiri-mascot.webp" alt="" />
        <div className="empty-say">
          <div className="bubble empty-bubble"><span>{error || '这页卡住了…'}</span></div>
          <button className="btn btn-primary" type="button" onClick={() => void load()}>再试一次</button>
        </div>
      </div>
    )
  }

  if (!summary.enabled) {
    return (
      <>
        <PageTitle />
        <div className="empty panel reward-empty mt16">
          <img className="mascot" src="/assets/sagiri-mascot.webp" alt="" />
          <div className="empty-say">
            <div className="bubble empty-bubble"><span>这页今天先不给你看。开放的时候我会说的。</span></div>
          </div>
        </div>
      </>
    )
  }

  const redeem = async (item: RewardShopItem, title: string): Promise<void> => {
    setBusy(item)
    try {
      await redeemReward(newRewardRequestId(), item)
      toast(`给你收好了：${title}`)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '兑换没有完成', { err: true })
    } finally {
      setBusy(null)
    }
  }

  const draw = async (): Promise<void> => {
    if (!summary.lotteryEnabled) {
      toast('扭蛋机今天不转。')
      return
    }
    if (summary.points < 20) {
      toast(`还差 ${20 - summary.points} 星光，再攒一点嘛。`)
      return
    }
    setBusy('draw')
    setDrawResult('')
    try {
      const [result] = await Promise.all([
        drawReward(newRewardRequestId()),
        new Promise((resolve) => window.setTimeout(resolve, 850)),
      ])
      const prize = String(result.prize ?? '')
      setDrawResult(PRIZE_LABEL[prize] ?? '一份藏起来的福利')
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '唔，扭蛋卡住了。', { err: true })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="reward-page">
      <PageTitle />

      <div className="reward-hero mt16">
        <section className="reward-wallet panel">
          <span className="tape tl lav" />
          <div className="reward-wallet-head">
            <div>
              <span className="font-hand faint small">MY SCREENING WALLET</span>
              <h2>星光口袋</h2>
            </div>
            <span className="stamp st-sakura pop">福利</span>
          </div>
          <div className="reward-balances">
            <div className="reward-balance gold">
              <span>星光</span>
              <strong>{summary.points}</strong>
            </div>
            <div className="reward-balance teal">
              <span>放映券</span>
              <strong>{summary.tickets}</strong>
            </div>
            <div className="reward-balance sakura">
              <span>免券剩余</span>
              <strong className="date" title={priorityTitle(summary.priorityUntil)}>{priorityText(summary.priorityUntil)}</strong>
            </div>
          </div>
        </section>

        <div className="reward-guide">
          <img src="/assets/sagiri-mascot.webp" alt="和泉纱雾" />
          <div className="bubble"><span>想要哪张券？先说好，不许一次全花掉。</span></div>
        </div>
      </div>

      <div className="reward-layout mt16">
        <section className="panel reward-invite">
          <span className="tape tr teal" />
          <div className="panel-title"><Ic name="mail" />邀请有礼</div>
          {summary.inviteCode ? (
            <>
              <p className="reward-copy">叫一位新朋友来，我就给你 <b>100</b> 星光。</p>
              <div className="invite-code-row">
                <span className="invite-code">{summary.inviteCode}</span>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void copyText(inviteLink).then(() => toast('链接抄好啦，快叫人来。'))}
                >
                  <Ic name="clip" cls="ic ic-sm" />复制邀请链接
                </button>
              </div>
            </>
          ) : (
            <div className="reward-rest">今天不招待新朋友。</div>
          )}
        </section>

        <section className="panel reward-gacha">
          <span className="tape tr sakura" />
          <div className="panel-title"><Ic name="gift" />幸运扭蛋 <span className="reward-cost">20 星光 / 次</span></div>
          <div className="gacha-stage">
            <div className={`gacha-capsule${busy === 'draw' ? ' rolling' : ''}`} aria-hidden="true">
              <span className="capsule-top" />
              <span className="capsule-star">✦</span>
              <span className="capsule-bottom" />
            </div>
            <div className={`gacha-result${drawResult ? ' show' : ''}`} aria-live="polite">
              <span>{drawResult ? '给你这个' : '哼，才不会先告诉你。'}</span>
              <strong>{drawResult || '？'}</strong>
            </div>
          </div>
          <button
            className="btn btn-sakura btn-block"
            type="button"
            disabled={!summary.lotteryEnabled || busy !== null}
            onClick={() => void draw()}
          >
            {busy === 'draw' ? <><Spinner size={18} />等、等一下…</> : summary.lotteryEnabled ? '20 星光 · 转一次' : '今天不转'}
          </button>
          <div className="prize-grid" aria-label="奖品概率">
            {PRIZES.map(([name, rate]) => <span key={name}><b>{name}</b><small>{rate}</small></span>)}
          </div>
        </section>
      </div>

      <section className="reward-shop mt16">
        <div className="reward-section-head">
          <div>
            <span className="ribbon">星光兑换所</span>
          </div>
          <span className="reward-points-left">还剩 <b>{summary.points}</b> 星光</span>
        </div>
        <div className="reward-shop-grid">
          {SHOP.map((item) => (
            <article className={`reward-shop-card ${item.accent}`} key={item.item}>
              <div className="shop-card-top">
                <span className={`stamp small st-${item.accent === 'gold' ? 'gold' : item.accent}`}>{item.mark}</span>
                <Ic name={item.item.startsWith('ticket') ? 'ticket' : 'star'} />
              </div>
              <h3>{item.title}</h3>
              <p>{item.note}</p>
              <button
                className="btn btn-sm btn-block"
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  if (summary.points < item.cost) {
                    toast(`还差 ${item.cost - summary.points} 星光，再攒一点嘛。`)
                    return
                  }
                  void redeem(item.item, item.title)
                }}
              >
                {busy === item.item ? <><Spinner size={16} />收进来…</> : `${item.cost} 星光 · 收下`}
              </button>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}

function PageTitle(): JSX.Element {
  return (
    <div className="page-head reward-title">
      <div className="row">
        <span className="head-ico"><Ic name="gift" /></span>
        <div>
          <h1 className="title-sketch" style={{ fontSize: 34 }}>放映福利</h1>
          <p className="muted small mt8">今天的星光，也替你收好啦。</p>
        </div>
      </div>
    </div>
  )
}
