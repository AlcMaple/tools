import { net } from 'electron'
import { StringDecoder } from 'string_decoder'
import { judgeLineReader } from '../../../web/shared/order-judge-lines'

export class WebRequestError extends Error {
  constructor(readonly code: string, message: string, readonly status = 0) { super(message) }
}

export function netLines(url: string, options: { headers: Record<string, string>; body?: string; signal: AbortSignal; idleMs?: number }, onLine: (value: unknown) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal.aborted) { reject(new WebRequestError('ABORTED', '请求已取消。')); return }
    const request = net.request({ url, method: options.body === undefined ? 'GET' : 'POST', redirect: 'error' })
    let ended = false, timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error): void => {
      if (ended) return
      ended = true; clearTimeout(timer); options.signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve()
    }
    const abort = (): void => { finish(new WebRequestError('ABORTED', '请求已取消。')); request.abort() }
    const arm = (ms: number): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { finish(new WebRequestError('NETWORK', '连接长时间没有返回数据。')); request.abort() }, ms)
    }
    options.signal.addEventListener('abort', abort, { once: true })
    for (const [key, value] of Object.entries(options.headers)) request.setHeader(key, value)
    request.on('response', response => {
      const status = response.statusCode ?? 0, decoder = new StringDecoder('utf8')
      const parse = judgeLineReader(onLine)
      let errorText = ''
      response.on('data', (chunk: Buffer) => {
        if (ended) return
        arm(options.idleMs ?? 45_000)
        try {
          const text = decoder.write(chunk)
          if (status !== 200) errorText = (errorText + text).slice(0, 8192)
          else parse(text)
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); request.abort() }
      })
      response.on('end', () => {
        if (ended) return
        try {
          if (status !== 200) {
            let body: { code?: string; error?: string } = {}
            try { body = JSON.parse(errorText) as typeof body } catch { /* 非 JSON 响应仍保留 HTTP 状态。 */ }
            finish(new WebRequestError(body.code ?? `HTTP_${status}`, body.error ?? `网站返回 HTTP ${status}：${errorText.slice(0, 200)}`, status))
          } else { parse(decoder.end(), true); finish() }
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      })
      response.on('error', (error: Error) => finish(new WebRequestError('NETWORK', error.message)))
      response.on('aborted', () => finish(new WebRequestError('NETWORK', '传输中断。')))
    })
    request.on('error', error => finish(new WebRequestError('NETWORK', error.message)))
    request.on('abort', () => finish(new WebRequestError('ABORTED', '请求已取消。')))
    if (options.body !== undefined) request.write(options.body)
    arm(15_000); request.end()
  })
}
