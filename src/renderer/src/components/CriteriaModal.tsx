// 评判标准帮助弹窗 —— 给 ✨ 好看集 和 🌟 最爱值 提供"什么时候 +1"的参考文档。
//
// 这是给用户自己看的参考，不是规则强制——所以语气是"参考"而不是"必须满足以下"。
// 内容直接来自原 PDF 里"好看集的评判标准" / "最爱值加一的评判标准"两段。
//
// 入口：MyAnime sticky header 右上角的 help_outline 图标按钮。

import { ModalShell } from '../pages/homework/shared'

interface Props {
  onClose: () => void
}

interface Criterion {
  /** 主要文字 */
  text: string
  /** 可选附注（括号里的解释） */
  note?: string
  /** 可选「加几分」徽章 */
  weight?: string
}

const GOOD_EP_CRITERIA: ReadonlyArray<Criterion> = [
  { text: '重温有关注点', note: '突然停止快进，停下来看完那一段精彩部分' },
  { text: '追番途中重看一遍某部分的集', note: '因为推理而重看不算' },
  { text: '暂停截图' },
]

const FAVORITE_CRITERIA: ReadonlyArray<Criterion> = [
  { text: '想看下一集但因某种原因不能看', note: '新番断更的那种心痒', weight: '+1' },
  { text: '好看到停不下来', note: '一次看几集那种，自己无法主动暂停', weight: '+1' },
  {
    text: '流露感情',
    note: '想哭了；同一部番这一项只算一次，避免连续两集都哭重复加分',
    weight: '+2',
  },
]

export function CriteriaModal({ onClose }: Props): JSX.Element {
  return (
    <ModalShell onBackdrop={onClose}>
      <div className="flex flex-col max-h-[80vh]">
        {/* Header */}
        <div className="p-5 border-b border-outline-variant/20 bg-surface-container-low">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-headline font-black text-base text-on-surface">评判标准参考</h3>
              <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-1">
                Reference · 自己用的尺，不是规则
              </p>
              <p className="font-body text-xs text-on-surface-variant/70 mt-2 leading-relaxed">
                这两套标准帮你判断什么时候该给一部番打 ✨ 好看集 或者 🌟 最爱值。
                标准是"参考"——按自己的感觉来就行，不用每条都对得上才能加。
              </p>
            </div>
            <button
              onClick={onClose}
              className="text-on-surface-variant/60 hover:text-on-surface transition-colors shrink-0"
            >
              <span className="material-symbols-outlined leading-none">close</span>
            </button>
          </div>
        </div>

        {/* Body —— 两栏，窄屏自动堆叠 */}
        <div className="overflow-y-auto flex-1 p-5 grid gap-5 md:grid-cols-2">
          {/* 好看集 */}
          <section className="bg-surface-container-low border border-outline-variant/15 rounded-xl p-4">
            <header className="flex items-center gap-2 mb-3">
              <span
                className="material-symbols-outlined text-amber-500"
                style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
              >
                auto_awesome
              </span>
              <div>
                <h4 className="font-headline font-bold text-sm text-on-surface">好看集</h4>
                <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-0.5">
                  这一集精彩到值得 +1
                </p>
              </div>
            </header>
            <ul className="space-y-2.5">
              {GOOD_EP_CRITERIA.map((c, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-xs text-on-surface-variant/90 leading-relaxed"
                >
                  <span className="font-label text-[10px] text-amber-500/80 font-bold mt-0.5 shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0">
                    <span className="text-on-surface font-bold">{c.text}</span>
                    {c.note && (
                      <span className="text-on-surface-variant/55 ml-1.5">（{c.note}）</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          {/* 最爱值 */}
          <section className="bg-surface-container-low border border-outline-variant/15 rounded-xl p-4">
            <header className="flex items-center gap-2 mb-3">
              <span
                className="material-symbols-outlined text-amber-400"
                style={{ fontSize: 20, fontVariationSettings: "'FILL' 1" }}
              >
                star
              </span>
              <div>
                <h4 className="font-headline font-bold text-sm text-on-surface">最爱值（🌟 0–6）</h4>
                <p className="font-label text-[10px] text-on-surface-variant/50 uppercase tracking-widest mt-0.5">
                  整体喜爱程度的累加参考
                </p>
              </div>
            </header>
            <ul className="space-y-2.5">
              {FAVORITE_CRITERIA.map((c, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2.5 text-xs text-on-surface-variant/90 leading-relaxed"
                >
                  <span className="font-label text-[10px] text-amber-500/80 font-bold mt-0.5 shrink-0">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-on-surface font-bold">{c.text}</span>
                      {c.weight && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-500 font-label text-[10px] font-bold tracking-wider">
                          {c.weight}
                        </span>
                      )}
                    </div>
                    {c.note && (
                      <p className="text-on-surface-variant/55 mt-0.5">{c.note}</p>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 pt-3 border-t border-outline-variant/15 font-label text-[10px] text-on-surface-variant/45 leading-relaxed">
              本应用把最爱值简化成纯星级（0–6 颗），你想直接点星设级也行；上面的
              加分规则是给你"评几颗"做参考。
            </p>
          </section>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-outline-variant/15 bg-surface-container-low">
          <p className="font-label text-[10px] text-on-surface-variant/45 text-center tracking-wider">
            来源：用户原创动漫追番表的评判标准
          </p>
        </div>
      </div>
    </ModalShell>
  )
}
