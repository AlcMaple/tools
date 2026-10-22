export function judgeLineReader(onLine: (value: unknown) => void): (chunk: string, done?: boolean) => void {
  let buffer = ''
  return (chunk, done = false) => {
    buffer += chunk
    if (buffer.length > 2_000_000) throw new Error('JUDGE_STREAM_TOO_LARGE')
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) onLine(JSON.parse(line))
    }
    if (done && buffer.trim()) { onLine(JSON.parse(buffer)); buffer = '' }
  }
}
