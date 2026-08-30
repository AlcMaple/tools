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
  { item: 'ticket_1', title: '优先放映券', note: '满员时自动走优先候补', cost: 50, accent: 'teal', mark: '×1' },
  { item: 'ticket_5', title: '放映券小册', note: '五张装，比单张省 50 星光', cost: 200, accent: 'gold', mark: '×5' },
  { item: 'priority_7d', title: '七日优先通行', note: '连续七天自动进入优先候补', cost: 300, accent: 'sakura', mark: '7日' },
  { item: 'priority_30d', title: '月度优先通行', note: '三十天都不用逐张消耗券', cost: 900, accent: 'lav', mark: '30日' },
]

const PRIZES = [
  ['10 星光', '45%'],
  ['返还 20 星光', '25%'],
  ['放映券 ×1', '20%'],
  ['放映券 ×2', '8%'],
  ['七日优先', '1.8%'],
  ['月度优先', '0.2%'],
] as const

const PRIZE_LABEL: Record<string, string> = {
  points_10: '10 星光',
  points_20: '20 星光全数返还',
  ticket_1: '优先放映券 ×1',
  ticket_2: '优先放映券 ×2',
  priority_7d: '七日优先通行',
  priority_30d: '月度优先通行',
}

function priorityText(until: number | null): string {
  if (!until || until <= Date.now()) return '未启用'
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(new Date(until)) + ' 到期'
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
        <p className="faint small">正在数今天收下的星光…</p>
      </div>
    )
  }
  if (!user) return <></>
  if (error || !summary) {
    return (
      <div className="empty panel reward-empty">
        <img className="mascot" src="/assets/sagiri-mascot.webp" alt="" />
        <div className="empty-say">
          <div className="bubble empty-bubble"><span>{error || '福利手册暂时翻不开'}</span></div>
          <button className="btn btn-primary" type="button" onClick={() => void load()}>再翻一次</button>
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
            <div className="bubble empty-bubble"><span>放映福利暂时收进抽屉啦，开放时这里会亮起来。</span></div>
          </div>
        </div>
      </>
    )
  }

  const redeem = async (item: RewardShopItem, title: string): Promise<void> => {
    setBusy(item)
    try {
      await redeemReward(newRewardRequestId(), item)
      toast(`${title}已经收进福利手册`)
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '兑换没有完成', { err: true })
    } finally {
      setBusy(null)
    }
  }

  const draw = async (): Promise<void> => {
    setBusy('draw')
    setDrawResult('')
    try {
      const [result] = await Promise.all([
        drawReward(newRewardRequestId()),
        new Promise((resolve) => window.setTimeout(resolve, 850)),
      ])
      const prize = String(result.prize ?? '')
      setDrawResult(PRIZE_LABEL[prize] ?? '一份神秘福利')
      await load()
    } catch (err) {
      toast(err instanceof Error ? err.message : '扭蛋没有掉出来', { err: true })
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
              <h2>星光放映手册</h2>
            </div>
            <span className="stamp st-sakura pop">福利</span>
          </div>
          <div className="reward-balances">
            <div className="reward-balance gold">
              <span>星光积分</span>
              <strong>{summary.points}</strong>
              <small>每天来看看，自动收下 5 星光</small>
            </div>
            <div className="reward-balance teal">
              <span>放映券</span>
              <strong>{summary.tickets}</strong>
              <small>满员时自动锁定并进入优先候补</small>
            </div>
            <div className="reward-balance sakura">
              <span>优先通行</span>
              <strong className="date">{priorityText(summary.priorityUntil)}</strong>
              <small>正在观看的人不会被打断</small>
            </div>
          </div>
        </section>

        <div className="reward-guide">
          <img src="/assets/sagiri-mascot.webp" alt="和泉纱雾" />
          <div className="bubble"><span>星光攒好了，就来换一张放映券吧～</span></div>
        </div>
      </div>

      <div className="reward-layout mt16">
        <section className="panel reward-invite">
          <span className="tape tr teal" />
          <div className="panel-title"><Ic name="mail" />好友招待券</div>
          {summary.inviteCode ? (
            <>
              <p className="reward-copy">新朋友从你的链接注册，你得 <b>100</b> 星光，对方得 <b>50</b> 星光。</p>
              <div className="invite-code-row">
                <span className="invite-code">{summary.inviteCode}</span>
                <button
                  className="btn btn-primary"
                  type="button"
                  onClick={() => void copyText(inviteLink).then(() => toast('邀请链接已复制'))}
                >
                  <Ic name="clip" cls="ic ic-sm" />复制邀请链接
                </button>
              </div>
            </>
          ) : (
            <div className="reward-rest">好友招待活动今天休息。</div>
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
              <span>{drawResult ? '抽到了' : '下一颗会是什么呢？'}</span>
              <strong>{drawResult || '？'}</strong>
            </div>
          </div>
          <button
            className="btn btn-sakura btn-block"
            type="button"
            disabled={!summary.lotteryEnabled || summary.points < 20 || busy !== null}
            onClick={() => void draw()}
          >
            {busy === 'draw' ? <><Spinner size={18} />正在转…</> : summary.lotteryEnabled ? '投进 20 星光' : '扭蛋机休息中'}
          </button>
          <div className="prize-grid" aria-label="奖品概率">
            {PRIZES.map(([name, rate]) => <span key={name}><b>{name}</b><small>{rate}</small></span>)}
          </div>
        </section>
      </div>

      <section className="reward-shop mt16">
        <div className="reward-section-head">
          <div>
            <span className="ribbon">积分兑换所</span>
            <p>想稳稳拿到，就在这里直接兑换。</p>
          </div>
          <span className="reward-points-left">现有 <b>{summary.points}</b> 星光</span>
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
                disabled={summary.points < item.cost || busy !== null}
                onClick={() => void redeem(item.item, item.title)}
              >
                {busy === item.item ? <><Spinner size={16} />兑换中…</> : `${item.cost} 星光兑换`}
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
          <p className="muted small mt8">攒星光、领放映券，好片开场时快一步</p>
        </div>
      </div>
    </div>
  )
}
