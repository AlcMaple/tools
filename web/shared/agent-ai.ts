import type { ContractSchema } from './agent-contracts'

export interface AgentByokAccess { source: 'byok'; uid: number; endpoint: string; model: string; key: string }
export type AgentAiAccess = { source: 'server'; uid: number } | AgentByokAccess

const uid: ContractSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }
export const AGENT_BYOK_ACCESS_SCHEMA: ContractSchema = {
  type: 'object', required: ['source', 'uid', 'endpoint', 'model', 'key'], additionalProperties: false,
  properties: {
    source: { type: 'string', enum: ['byok'] }, uid,
    endpoint: { type: 'string', minLength: 1, maxLength: 300 },
    model: { type: 'string', minLength: 1, maxLength: 100 },
    key: { type: 'string', minLength: 1, maxLength: 4096 },
  },
}
export const AGENT_AI_ACCESS_SCHEMA: ContractSchema = { anyOf: [
  { type: 'object', required: ['source', 'uid'], additionalProperties: false, properties: { source: { type: 'string', enum: ['server'] }, uid } },
  AGENT_BYOK_ACCESS_SCHEMA,
] }

export const AI_SETTINGS_MESSAGES: Readonly<Record<string, string>> = {
  AI_SETTINGS_CHANGED: 'AI 设置已变更，请核对后再试',
  BYOK_SETTINGS_REQUIRED: '请先填写你的接口地址和模型',
  BYOK_KEY_REQUIRED: '这台设备还没填你的 API Key',
  BYOK_KEY_INVALID: 'API Key 格式不正确，请检查后再试',
  ENDPOINT_NOT_ALLOWED: '这个接口或模型尚未适配纱雾助手和接单评估',
  PROVIDER_CAPABILITY: '模型未通过回复格式或工具能力检查，请检查 AI 设置',
  PROVIDER_CONNECTION_REQUIRED: 'AI 连接未就绪，请检查 AI 设置后重试',
  PROVIDER_CHANGED: 'AI 连接已变更，请核对设置后再试',
  PROVIDER_HTTP_401: '模型服务未接受这个 API Key，请检查 AI 设置',
  PROVIDER_HTTP_403: '模型服务拒绝了请求，请检查 API Key 和模型权限',
}
