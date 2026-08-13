// 邮件功能的本地配置。
//
// **安全**:邮箱授权码相当于一次性密码,泄漏后可以无密码登录该邮箱发件,所以走 Electron
// safeStorage(mac Keychain / Win DPAPI / Linux libsecret)加密成 base64 再落盘,运行时才解出来用。

import { app, safeStorage } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'

export interface MailConfig {
  enabled: boolean
  qqEmail: string
  /** 解密后的明文授权码 —— 只在内存里流转,不会被原样写盘。 */
  authCode: string
}

interface PersistedMailConfig {
  enabled: boolean
  qqEmail: string
  /** 加密并 base64 后的授权码;safeStorage 不可用时退化为明文。 */
  authCodeEnc: string
  /** 标记上面那个字段是否真的加密过。 */
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
