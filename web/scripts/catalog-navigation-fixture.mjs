import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const items = [
  { bgmId: 1001, name: '葬送的芙莉莲', nameCn: '葬送的芙莉莲', date: '2023-09-29', score: 8.5, eps: 28, tags: [], cover: '' },
  { bgmId: 1002, name: '夹具里的另一部作品', nameCn: '夹具里的另一部作品', date: '2024-01-01', score: 7, eps: 12, tags: [], cover: '' },
]
const requests = []
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' }
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const json = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
  if (url.pathname === '/__fixture/status') return json({ requests, realAiCalls: 0, productionData: false })
  if (url.pathname.startsWith('/api/')) {
    requests.push({ path: url.pathname, query: url.search, method: req.method })
    if (req.method !== 'GET') return json({ ok: true })
    if (url.pathname === '/api/auth/me') return json({ error: '请先登录' }, 401)
    if (url.pathname === '/api/feedback/context') return json({ unread: 0, admin: false })
    if (url.pathname === '/api/auth/features') return json({ email: false, google: false, github: false, linuxdo: false })
    if (url.pathname === '/api/auth/questions') return json([])
    if (url.pathname === '/api/announcements/current') return json({ announcement: null })
    if (url.pathname === '/api/calendar') return json({ data: [], updatedAt: Date.now(), fromCache: true })
    if (url.pathname === '/api/calendar/seasons') return json({ seasons: [] })
    if (url.pathname === '/api/catalog') {
      const q = (url.searchParams.get('q') ?? '').trim()
      const year = Number(url.searchParams.get('year') ?? 0)
      const found = items.filter(item => (!q || item.nameCn.includes(q)) && (!year || item.date.startsWith(String(year))))
      return json({ ready: true, total: found.length, items: found, covered: 0, admin: false })
    }
    return json({ error: '夹具未配置此接口' }, 404)
  }
  const file = resolve(dist, '.' + (url.pathname === '/' ? '/index.html' : url.pathname))
  if (!file.startsWith(resolve(dist) + sep)) return json({ error: '路径不合法' }, 400)
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('[catalog-navigation-fixture]', error)
    json({ error: '夹具文件不存在' }, 404)
  }
})
server.listen(Number(process.env.CATALOG_FIXTURE_PORT ?? 0), '127.0.0.1', () => {
  const address = server.address()
  console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}`, mode: 'isolated-catalog-navigation-fixture', productionData: false, realAiCalls: 0 }))
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections() })
