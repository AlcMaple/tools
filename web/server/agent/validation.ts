import {
  AGENT_TOOLS, MODEL_OUTPUT_SCHEMA, TOOL_CALL_SCHEMA, toolResultSchema,
  type AgentToolName, type ContractSchema, type JsonValue,
} from '../../shared/agent-contracts'

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype

export function matchesContract(schema: ContractSchema, value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (schema.anyOf && !schema.anyOf.some(s => matchesContract(s, value, depth + 1))) return false
  if (schema.enum && !schema.enum.some(v => v === value)) return false
  switch (schema.type) {
    case 'null': return value === null
    case 'boolean': return typeof value === 'boolean'
    case 'integer':
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        && (schema.type !== 'integer' || Number.isSafeInteger(value))
        && (schema.minimum === undefined || value >= schema.minimum)
        && (schema.maximum === undefined || value <= schema.maximum)
    case 'string':
      return typeof value === 'string'
        && value.length >= (schema.minLength ?? 0) && value.length <= (schema.maxLength ?? Infinity)
        && (!schema.pattern || new RegExp(schema.pattern).test(value))
    case 'array':
      return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity)
        && value.every(v => !!schema.items && matchesContract(schema.items, v, depth + 1))
        && (!schema.uniqueItems || new Set(value.map(v => JSON.stringify(v))).size === value.length)
    case 'object': {
      if (!isObject(value) || Object.keys(value).length < (schema.minProperties ?? 0)) return false
      const properties = schema.properties ?? {}
      if ((schema.required ?? []).some(k => !Object.hasOwn(value, k))) return false
      return Object.keys(value).every(k => !['__proto__', 'prototype', 'constructor'].includes(k)
        && Object.hasOwn(properties, k) && matchesContract(properties[k], value[k], depth + 1))
    }
    default: return Boolean(schema.anyOf)
  }
}

export function parseToolRequest(value: unknown, authenticatedUid: number): { name: AgentToolName; arguments: Record<string, JsonValue> } {
  if (!Number.isSafeInteger(authenticatedUid) || authenticatedUid <= 0) throw new Error('AUTH_REQUIRED')
  if (!isObject(value) || typeof value.name !== 'string' || !Object.hasOwn(AGENT_TOOLS, value.name)) throw new Error('UNREGISTERED_TOOL')
  if (!matchesContract(TOOL_CALL_SCHEMA, value)) throw new Error('INVALID_ARGUMENT')
  const parsed = value as { name: AgentToolName; arguments: Record<string, JsonValue> }
  if (parsed.name === 'searchOfflineAnime') {
    const filters = parsed.arguments.filters as Record<string, JsonValue>
    if (typeof filters.yearFrom === 'number' && typeof filters.yearTo === 'number' && filters.yearFrom > filters.yearTo) throw new Error('INVALID_ARGUMENT')
  }
  return parsed
}

export function validateToolResult(name: AgentToolName, value: unknown): void {
  if (!matchesContract(toolResultSchema(name), value)) throw new Error('INVALID_OUTPUT')
  const result = value as Record<string, JsonValue>
  if (result.ok === true) {
    const data = result.data as Record<string, JsonValue>
    if ((Array.isArray(data.items) ? data.items.length : 1) !== result.resultCount) throw new Error('INVALID_OUTPUT')
    const sources = result.sources as Record<string, JsonValue>[]
    if (new Set(sources.map(s => s.sourceId)).size !== sources.length) throw new Error('INVALID_OUTPUT')
    if (AGENT_TOOLS[name].mode === 'read' && result.resultCount !== 0 && sources.length === 0) throw new Error('INVALID_OUTPUT')
  }
}

export function validateModelOutput(value: unknown, authenticatedUid: number, knownSourceIds: readonly string[]): void {
  if (!Number.isSafeInteger(authenticatedUid) || authenticatedUid <= 0) throw new Error('AUTH_REQUIRED')
  if (!matchesContract(MODEL_OUTPUT_SCHEMA, value)) throw new Error('INVALID_OUTPUT')
  const output = value as Record<string, JsonValue>
  if (output.kind === 'tool_calls') {
    for (const call of output.calls as JsonValue[]) parseToolRequest(call, authenticatedUid)
  } else if ((output.sourceIds as string[]).some(id => !knownSourceIds.includes(id))) {
    throw new Error('INVALID_OUTPUT')
  }
}
