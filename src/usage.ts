import type { JsonObject, ModelUsage, UsageSnapshot } from '@xcye/corio-executor-sdk'

function count(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) {
    return value
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined
}

/** stats 是这次原生命令的累计，不是恢复后的整个会话累计；保留实际多个模型，避免重复计算总数。 */
export function geminiUsage(executionId: string, sessionId: string, stats: JsonObject, currentModel: string): UsageSnapshot | null {
  const models: ModelUsage[] = []
  if (stats.models && typeof stats.models === 'object' && !Array.isArray(stats.models)) {
    for (const [model, raw] of Object.entries(stats.models)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        continue
      }
      const tokens = raw as JsonObject
      // 原生 input 为未命中缓存的输入；缺少时不猜 prompt 总数减法。
      models.push({ model, inputTokens: count(tokens.input), outputTokens: count(tokens.output_tokens), cachedInputTokens: count(tokens.cached), raw: tokens })
    }
  }
  if (!models.length && (count(stats.input_tokens) !== undefined || count(stats.output_tokens) !== undefined)) {
    models.push({ model: currentModel, inputTokens: count(stats.input), outputTokens: count(stats.output_tokens), cachedInputTokens: count(stats.cached), raw: stats })
    return { snapshotId: 'gemini:' + executionId, revision: '1', scope: 'call', accounting: 'cumulative', baselineId: sessionId, modelUsages: models, includesChildExecutions: false, complete: false }
  }
  return models.length
    ? { snapshotId: 'gemini:' + executionId, revision: '1', scope: 'call', accounting: 'cumulative', baselineId: sessionId, modelUsages: models, includesChildExecutions: false, complete: models.every((model) => model.inputTokens !== undefined && model.outputTokens !== undefined) }
    : null
}
