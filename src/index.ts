import type { CreateExtension } from '@xcye/corio-executor-sdk'
import { GeminiAdapter } from './executor.js'
import { geminiLifecycle } from './lifecycle.js'

/** 导入只声明工厂；安装、认证和进程属于当前宿主及 Agent 实例。 */
export const createExtension: CreateExtension = (host) => ({
  lifecycle: geminiLifecycle(host),
  executors: { gemini: async (scope, installation) => new GeminiAdapter(host, scope, installation) },

  async dispose() {}
})
