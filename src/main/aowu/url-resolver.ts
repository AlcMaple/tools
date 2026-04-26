/**
 * Aowu video URL resolver.
 *
 * The play page exposes `player_aaaa.url` as a base64-of-percent-encoded string
 * (encrypt: 2 in MacCMS terms). The "plain" form is a parser-specific token
 * (e.g. a TikTok video id), not a URL. To get the actual mp4 we have to:
 *
 *   1. Decode the play page url field:  base64 → percent-decode → plain
 *   2. POST /player1/encode.php with `plain=<x>` → server returns {url, ts, sig}
 *   3. GET /player1/?url=&ts=&sig=&next=  → an iframe HTML page that has a JS-side
 *      AES-128-CBC-encrypted real URL, with the IV being the first 16 bytes of the
 *      ciphertext and the key inlined into the page.
 *   4. AES decrypt with key + iv → final mp4 URL (TikTok / Douyin CDN, supports Range).
 *
 * The resolved URL is short-lived but typically valid for hours, so we resolve once
 * per ep at download start and don't retry.
 */
import { createDecipheriv } from 'crypto'
import { BASE_URL, fetchPage, parsePlayerData, postForm } from './api'

interface EncodeResponse {
  ok: number
  url: string
  ts: number
  sig: string
}

function b64decode(s: string): string {
  return Buffer.from(s, 'base64').toString('latin1')
}

/**
 * Run the full chain for one play-page URL. Returns the final mp4 direct URL.
 *
 * `playPageUrl` is something like `https://www.aowu.tv/play/iSAAAK-1-1/`.
 */
export async function resolveAowuMp4(playPageUrl: string): Promise<string> {
  // Step 1: fetch play page, extract player_aaaa, decode .url.
  const playRes = await fetchPage(playPageUrl)
  if (playRes.status !== 200) throw new Error(`Play page fetch failed: HTTP ${playRes.status}`)
  const data = parsePlayerData(playRes.body)
  if (!data) throw new Error('player_aaaa not found on play page')

  let plain: string
  if (data.encrypt === 2) {
    // base64decode then unescape (MacCMS player.js reference logic)
    plain = decodeURIComponent(b64decode(data.url))
  } else if (data.encrypt === 1) {
    plain = decodeURIComponent(data.url)
  } else {
    plain = data.url
  }

  // Step 2: POST encode.php to get {url, ts, sig}.
  const encodeRes = await postForm(
    `${BASE_URL}/player1/encode.php`,
    `plain=${encodeURIComponent(plain)}`,
    { Referer: playPageUrl }
  )
  if (encodeRes.status !== 200) throw new Error(`encode.php failed: HTTP ${encodeRes.status}`)
  let parsed: EncodeResponse
  try { parsed = JSON.parse(encodeRes.body) as EncodeResponse } catch {
    throw new Error('encode.php returned non-JSON')
  }
  if (parsed.ok !== 1 || !parsed.url || !parsed.ts || !parsed.sig) {
    throw new Error('encode.php returned unexpected payload')
  }

  // Step 3: fetch player1 iframe page, extract encryptedUrl + sessionKey.
  const ifrUrl =
    `${BASE_URL}/player1/?url=${encodeURIComponent(parsed.url)}` +
    `&ts=${encodeURIComponent(String(parsed.ts))}` +
    `&sig=${encodeURIComponent(parsed.sig)}` +
    `&next=`
  const ifrRes = await fetchPage(ifrUrl, { Referer: playPageUrl })
  if (ifrRes.status !== 200) throw new Error(`player1 iframe failed: HTTP ${ifrRes.status}`)

  const encMatch = ifrRes.body.match(/const\s+encryptedUrl\s*=\s*"([^"]+)"/)
  const keyMatch = ifrRes.body.match(/const\s+sessionKey\s*=\s*"([^"]+)"/)
  if (!encMatch || !keyMatch) throw new Error('encryptedUrl/sessionKey not found in iframe HTML')

  // Step 4: AES-128-CBC decrypt. IV = first 16 bytes of ciphertext, key = sessionKey ASCII.
  const ct = Buffer.from(encMatch[1], 'base64')
  if (ct.length < 32) throw new Error('encryptedUrl ciphertext too short')
  const iv = ct.subarray(0, 16)
  const data2 = ct.subarray(16)
  const key = Buffer.from(keyMatch[1], 'utf-8')
  if (key.length !== 16) throw new Error(`unexpected sessionKey length ${key.length}`)

  const decipher = createDecipheriv('aes-128-cbc', key, iv)
  const plaintext = Buffer.concat([decipher.update(data2), decipher.final()]).toString('utf-8')
  if (!/^https?:\/\//.test(plaintext)) throw new Error(`decrypted result is not a URL: ${plaintext.slice(0, 80)}`)
  return plaintext
}
