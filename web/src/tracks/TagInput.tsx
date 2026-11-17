import { useEffect, useId, useRef, useState } from 'react'
import type { Track } from '../api'
import { Popover } from '../Popover'

export function reusableUserTags(tracks: readonly Pick<Track, 'userTags'>[]): string[] {
  const counts = new Map<string, number>()
  for (const track of tracks) for (const tag of new Set(track.userTags)) {
    if (tag.trim() && tag.length <= 20) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN')).map(([tag]) => tag)
}

export function TagInput({ choices, excluded, onCommit, onCancel }: {
  choices: readonly string[]
  excluded: readonly string[]
  onCommit: (value: string) => void
  onCancel: () => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const finished = useRef(false)
  const listId = useId()
  const options = choices.filter(tag => !excluded.includes(tag) && tag.toLocaleLowerCase().includes(draft.trim().toLocaleLowerCase())).slice(0, 12)
  const active = activeTag === null ? -1 : options.indexOf(activeTag)
  // 同一次选择可能紧接失焦，合并成一次提交
  const finish = (value: string): void => {
    if (finished.current) return
    finished.current = true
    onCommit(value)
  }
  const cancel = (): void => {
    if (finished.current) return
    finished.current = true
    onCancel()
  }
  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])
  return <>
    <input ref={input} className="tagx-input tag-reuse-input" autoFocus maxLength={20} spellCheck={false}
      placeholder="新标签或搜索已有标签" aria-label="添加自定义标签" role="combobox" autoComplete="off"
      aria-autocomplete="list" aria-controls={options.length ? listId : undefined} aria-expanded={options.length > 0}
      aria-activedescendant={active >= 0 && options[active] ? `${listId}-${active}` : undefined}
      value={draft} onChange={event => { setDraft(event.target.value); setActiveTag(null) }}
      onBlur={() => finish(draft)}
      onKeyDown={event => {
        // 组合键确认属于输入法，不提交标签或触发浮层关闭
        if (event.nativeEvent.isComposing) {
          if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation()
          return
        }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
          event.preventDefault()
          setActiveTag(options[event.key === 'ArrowDown' ? (active + 1) % options.length : active <= 0 ? options.length - 1 : active - 1])
        } else if (event.key === 'Enter') {
          event.preventDefault(); finish(active >= 0 && options[active] ? options[active] : draft)
        } else if (event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); cancel()
        }
      }} />
    <Popover anchor={input} open={options.length > 0} onClose={() => finish(draft)} matchWidth maxHeight={240} className="dd tag-reuse-options">
      <div role="listbox" id={listId} aria-label="已有自定义标签">
        {options.map((tag, index) => <button key={tag} id={`${listId}-${index}`} type="button" tabIndex={-1}
          role="option" aria-selected={active === index} className={`dd-item${active === index ? ' is-active' : ''}`} title={tag}
          onMouseDown={event => event.preventDefault()} onClick={() => finish(tag)}>{tag}</button>)}
      </div>
    </Popover>
  </>
}
