import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { LongText } from '../src/lib/LongText'
import { AgentMarkdown } from '../src/agent/AgentMarkdown'

let root: Root | undefined
export function mount(host: HTMLElement, options: { optimized: boolean; count: number; text: string; markdown?: boolean; streaming?: boolean }) {
  root ??= createRoot(host)
  flushSync(() => root!.render(<>{Array.from({ length: options.count }, (_, index) => <article key={index}>
    <b>消息 {index + 1}</b>
    {options.markdown ? <AgentMarkdown text={options.text} streaming={options.streaming}/> : options.optimized
      ? <LongText className="body" text={options.text + index}/>
      : <p className="body">{options.text + index}</p>}
    <button type="button">确认</button>
  </article>)}</>))
}
export function unmount() { root?.unmount(); root = undefined }
