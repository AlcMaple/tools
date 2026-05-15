// 邮件功能的本地配置 —— 存在 userData/mail_settings.json。
//
// 安全说明：QQ 邮箱的「授权码」相当于一次性密码，泄漏后可以无密码登录该邮箱
// 发件。所以走 Electron safeStorage（mac Keychain / Win DPAPI / Linux libsecret）
// 把它加密成 base64 串再落盘。
//
// 字段：
//   enabled   —— 是否开启「每次周历自动刷新后发邮件」
//   qqEmail   —— 同时作为发件人和收件人（自己发给自己）
//   authCode  —— QQ 邮箱后台开启 SMTP 服务后生成的授权码（不是登录密码）
//
// 文件结构（authCode 落盘时是密文 base64，运行时解出来用）：
//   { enabled: boolean, qqEmail: string, authCodeEnc: string }

import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export interface MailConfig {
  enabled: boolean
  qqEmail: string
  /** 解密后的明文授权码 —— 仅 in-memory 流转，不会被原样写盘。 */
  authCode: string
}

interface PersistedMailConfig {
  enabled: boolean
  qqEmail: string
  /** base64(safeStorage.encryptString(authCode))；若 safeStorage 不可用退化为明文。 */
  authCodeEnc: string
  /** 标记 authCodeEnc 是否真的是加密过的；safeStorage 不可用时为 false。 */
  encrypted: boolean
}

function configPath(): string {
  return join(app.getPath('userData'), 'mail_settings.json')
}

function encrypt(plain: string): { value: string; encrypted: boolean } {
  if (!plain) return { value: '', encrypted: false }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(plain)
      return { value: buf.toString('base64'), encrypted: true }
    }
  } catch {
    /* fall through to plaintext */
  }
  return { value: plain, encrypted: false }
}

function decrypt(value: string, encrypted: boolean): string {
  if (!value) return ''
  if (!encrypted) return value
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
  } catch {
    /* fall through */
  }
  // 加密标记为 true 但解密失败 —— 多半是换机 / 重装系统导致钥匙环不对，
  // 视为没配置过，让用户重新填一遍。
  return ''
}

export async function loadMailConfig(): Promise<MailConfig> {
  try {
    const raw = await readFile(configPath(), 'utf-8')
    const parsed = JSON.parse(raw) as PersistedMailConfig
    return {
      enabled: !!parsed.enabled,
      qqEmail: parsed.qqEmail || '',
      authCode: decrypt(parsed.authCodeEnc || '', !!parsed.encrypted),
    }
  } catch {
    return { enabled: false, qqEmail: '', authCode: '' }
  }
}

export async function saveMailConfig(cfg: MailConfig): Promise<void> {
  const { value, encrypted } = encrypt(cfg.authCode || '')
  const persisted: PersistedMailConfig = {
    enabled: !!cfg.enabled,
    qqEmail: cfg.qqEmail || '',
    authCodeEnc: value,
    encrypted,
  }
  await writeFile(configPath(), JSON.stringify(persisted, null, 2), 'utf-8')
}
