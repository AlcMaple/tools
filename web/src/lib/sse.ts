// 浏览器端 SSE（Server-Sent Events）消费。点评助手的「逐字生成」和后续的智能体工作流
// （思考过程流式展示）共用这一份：服务端用 hono 的 streamSSE 往下推 `data: <json>\n\n`，
// 这里把字节流按事件切开、逐个 JSON.parse 后回调。
//
// 只认 `data:` 行，`[DONE]` 和解析失败的行直接跳过。事件之间以空行（\n\n）分隔——
// 按空行切分保证每次 parse 的都是完整 JSON，不会截断。

export async function consumeSSE<T = unknown>(
  body: ReadableStream<Uint8Array>,
  onEvent: (evt: T) => void,
): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, sep)
        buf = buf.slice(sep + 2)
        for (const line of chunk.split('\n')) {
          const s = line.trimStart()
          if (!s.startsWith('data:')) continue
          const data = s.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let parsed: T
          try {
            parsed = JSON.parse(data) as T
          } catch {
            continue
          }
          onEvent(parsed)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
