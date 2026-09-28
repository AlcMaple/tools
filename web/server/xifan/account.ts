import { nextXifan } from './next'

export interface XifanAuthStatus { loggedIn: boolean }
export interface XifanLoginResult { success: boolean; message: string }
export async function getXifanAuthStatus(uid: number): Promise<XifanAuthStatus> {
  return { loggedIn: await nextXifan(uid).status() }
}
export async function loginXifan(uid: number, email: string, password: string, _verify: string): Promise<XifanLoginResult> {
  await nextXifan(uid).login(email, password)
  return { success: true, message: '登录成功' }
}
export async function logoutXifan(uid: number): Promise<XifanAuthStatus> {
  await nextXifan(uid).logout()
  return { loggedIn: false }
}
