import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AuthenticationAdapter, AuthStep, ExecutionScope, ExecutorAdapter, ExecutorEvent, ExecutorSession, ExtensionHost, InstallationResult, InstanceScope, JsonObject, ManagedProcess, OpenSessionInput, TurnInput, UsageSnapshot } from '@xcye/corio-executor-sdk'
import { GeminiConfiguration, writePrivateJson } from './configuration.js'
import { geminiHistory, nativeSessionPattern } from './history.js'
import { geminiUsage } from './usage.js'

function command(installation: InstallationResult, args: readonly string[]) {
  if (!installation.command) {
    throw new Error('Gemini installation has no executable')
  }
  return { executable: installation.command.executable, args: [...installation.command.args, ...args] }
}

async function* frames(child: ManagedProcess, diagnostic: () => void): AsyncGenerator<JsonObject> {
  let pending = ''
  const decode = (line: string): JsonObject | undefined => {
    if (line.length > 8 * 1024 * 1024) {
      throw new Error('Gemini emitted an oversized JSON event')
    }
    // 原生文件保存/启动诊断偶尔也写 stdout；只过滤非 JSON 行，损坏的 JSON 事件仍明确失败。
    if (!line.startsWith('{') && !line.startsWith('[')) {
      diagnostic()
      return undefined
    }
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Gemini emitted an invalid JSON event')
    }
    return value as JsonObject
  }
  for await (const output of child.output) {
    if (output.channel !== 'stdout') {
      continue
    }
    pending += output.text
    let newline
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) {
        const frame = decode(line)
        if (frame) {
          yield frame
        }
      }
    }
    if (pending.length > 8 * 1024 * 1024) {
      throw new Error('Gemini emitted an oversized partial JSON event')
    }
  }
  if (pending.trim()) {
    const frame = decode(pending.trim())
    if (frame) {
      yield frame
    }
  }
}

/** 扩展只管理 Gemini 原生程序；公开回复与业务动作仍由显式 Corio CLI 调用产生。 */
export class GeminiAdapter implements ExecutorAdapter {
  readonly history
  readonly usage
  readonly authentication: AuthenticationAdapter
  private readonly configuration: GeminiConfiguration
  private readonly sessions = new Set<GeminiSession>()
  private readonly attempts = new Map<string, string>()

  constructor(
    private readonly host: ExtensionHost,
    private readonly scope: InstanceScope,
    private readonly installation: InstallationResult
  ) {
    this.configuration = new GeminiConfiguration(scope, host)
    this.history = geminiHistory(this.configuration.nativeDirectory)
    this.usage = {
      read: async (input: { nativeSessionId: string; stateDirectory: string }) => {
        if (!nativeSessionPattern.test(input.nativeSessionId)) {
          throw new Error('Invalid Gemini native session ID')
        }
        try {
          const snapshot = JSON.parse(await readFile(this.usagePath(input.nativeSessionId), 'utf8')) as UsageSnapshot
          return { status: 'available' as const, snapshot }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { status: 'unavailable' as const, reason: 'No final native usage has been observed on this device' }
          }
          throw error
        }
      }
    }
    this.authentication = {
      getStatus: (input) => this.authStatus(input.methodId),
      beginLogin: (input) => this.beginLogin(input.methodId, input.attemptId),
      continueLogin: (input) => this.continueLogin(input.attemptId),
      cancelLogin: async (input) => {
        this.attempts.delete(input.attemptId)
      },
      logout: async (input) => {
        if (input.methodId !== 'from-device') {
          throw new Error('Remove or replace the selected provider through Agent configuration')
        }
        await rm(join(this.configuration.nativeDirectory, 'oauth_creds.json'), { force: true })
        this.attempts.clear()
      }
    }
  }

  configure(input: Parameters<ExecutorAdapter['configure']>[0]): ReturnType<ExecutorAdapter['configure']> {
    return this.configuration.configure(input)
  }

  async nativeLaunch(): Promise<Awaited<ReturnType<NonNullable<ExecutorAdapter['nativeLaunch']>>>> {
    if (!this.installation.command) {
      return { status: 'unsupported', reason: 'The extension installation has no native command' }
    }
    await this.configuration.project()
    return {
      status: 'available',
      cwd: this.scope.workspacePath,
      command: { executable: this.installation.command.executable, args: [...this.installation.command.args, ...(this.configuration.model ? ['--model', this.configuration.model.modelId] : [])] },
      environment: await this.configuration.environment()
    }
  }

  async openSession(input: OpenSessionInput): Promise<ExecutorSession> {
    input.signal.throwIfAborted()
    if (input.nativeSessionId && !nativeSessionPattern.test(input.nativeSessionId)) {
      throw new Error('Gemini native session ID must be a UUID')
    }
    await this.configuration.project()
    if (input.nativeSessionId && (await this.history.probe({ nativeSessionId: input.nativeSessionId, stateDirectory: this.scope.stateDirectory })).status !== 'available') {
      throw new Error('The exact Gemini session is unavailable; restore context before opening a new session')
    }
    const session = new GeminiSession(
      this.host,
      this.installation,
      input.scope,
      this.configuration,
      input.nativeSessionId,
      await this.configuration.environment(),
      async (sessionId, stats, model) => {
        const snapshot = geminiUsage(input.scope.executionId, sessionId, stats, model)
        if (snapshot) {
          await mkdir(join(this.scope.stateDirectory, 'usage'), { recursive: true, mode: 0o700 })
          await writePrivateJson(this.usagePath(sessionId), snapshot)
        }
        return snapshot
      },
      () => this.sessions.delete(session),
      input.signal
    )
    this.sessions.add(session)
    return session
  }

  async dispose(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions].map((session) => session.dispose()))
    this.sessions.clear()
    this.attempts.clear()
    for (const result of results) {
      if (result.status === 'rejected') {
        this.host.logger.warn('gemini.dispose.failed', { agentId: this.scope.agentId, errorType: result.reason instanceof Error ? result.reason.name : 'unknown' })
      }
    }
  }

  private usagePath(sessionId: string): string {
    return join(this.scope.stateDirectory, 'usage', sessionId + '.json')
  }

  private async authStatus(methodId: string): Promise<Awaited<ReturnType<AuthenticationAdapter['getStatus']>>> {
    if (methodId !== this.configuration.authentication.methodId) {
      return { status: 'configuration_required', reason: 'Configure this authentication method first' }
    }
    if (methodId === 'provider') {
      try {
        await this.configuration.environment()
        return { status: 'authorized', reason: 'Credential configured; the native request validates remote acceptance' }
      } catch {
        return { status: 'configuration_required', reason: 'The selected model connection or credential is unavailable' }
      }
    }
    try {
      const credential = JSON.parse(await readFile(join(this.configuration.nativeDirectory, 'oauth_creds.json'), 'utf8')) as JsonObject
      return (typeof credential.refresh_token === 'string' && credential.refresh_token) || (typeof credential.access_token === 'string' && Number(credential.expiry_date) > Date.now())
        ? { status: 'authorized', reason: 'Local OAuth credential exists; native login validates acceptance and refreshes it' }
        : { status: 'authorization_required' }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { status: 'authorization_required' } : { status: 'unknown', reason: 'The isolated Gemini OAuth credential could not be read' }
    }
  }

  private async beginLogin(methodId: string, attemptId: string): Promise<AuthStep> {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    const status = await this.authStatus(methodId)
    if (status.status === 'authorized') {
      return { type: 'completed', attemptId, expiresAt }
    }
    if (methodId !== 'from-device' || status.status === 'configuration_required') {
      return { type: 'failed', attemptId, expiresAt, code: 'CONFIGURATION_REQUIRED', message: 'Configure this authentication method first' }
    }
    this.attempts.set(attemptId, expiresAt)
    return {
      type: 'local_terminal',
      attemptId,
      expiresAt,
      instructions: 'On the Manager device, set GEMINI_CLI_HOME to ' + this.configuration.nativeHome + ', run the installed Gemini command interactively and choose Google login. Return here to check status. Command: ' + JSON.stringify(this.installation.command)
    }
  }

  private async continueLogin(attemptId: string): Promise<AuthStep> {
    const expiresAt = this.attempts.get(attemptId) ?? new Date().toISOString()
    if (!this.attempts.has(attemptId) || Date.parse(expiresAt) <= Date.now()) {
      this.attempts.delete(attemptId)
      return { type: 'failed', attemptId, expiresAt, code: 'LOGIN_EXPIRED', message: 'Start a new Gemini login attempt' }
    }
    if ((await this.authStatus('from-device')).status === 'authorized') {
      this.attempts.delete(attemptId)
      return { type: 'completed', attemptId, expiresAt }
    }
    return { type: 'waiting', attemptId, expiresAt, pollAfterSeconds: 5, instructions: 'Complete Google login in the Manager terminal before checking again' }
  }
}

class GeminiSession implements ExecutorSession {
  private child?: ManagedProcess
  private cancelled = false
  private disposed = false
  private started = false

  constructor(
    private readonly host: ExtensionHost,
    private readonly installation: InstallationResult,
    private readonly scope: ExecutionScope,
    private readonly configuration: GeminiConfiguration,
    private readonly previousSessionId: string | undefined,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly saveUsage: (sessionId: string, stats: JsonObject, model: string) => Promise<UsageSnapshot | null>,
    private readonly released: () => void,
    private readonly sessionSignal: AbortSignal
  ) {}

  async *run(input: TurnInput): AsyncGenerator<ExecutorEvent> {
    if (this.disposed || this.started) {
      throw new Error('A Gemini execution session accepts exactly one turn; reopen it for the next input')
    }
    if (input.outputSchema) {
      throw new Error('This Gemini extension does not implement native structured output for agent turns')
    }
    this.started = true
    const nativeId = this.previousSessionId ?? randomUUID()
    const args = ['--output-format', 'stream-json', '--skip-trust', '--approval-mode', String(this.configuration.runtime.approvalMode ?? 'yolo')]
    args.push(this.previousSessionId ? '--resume' : '--session-id', nativeId)
    if (this.configuration.model) {
      args.push('--model', this.configuration.model.modelId)
    }
    let text = input.text
    for (const attachment of input.attachments) {
      if (!attachment.path && !attachment.url) {
        throw new Error('Gemini attachments require a local file path or URL')
      }
      // 不用 @file 拼接，避免空格/换行路径改变原生命令解析；由原生工具读取明确的文件引用。
      text += '\nAttached file: ' + JSON.stringify({ name: attachment.name ?? null, mimeType: attachment.mimeType, path: attachment.path ?? null, url: attachment.url ?? null })
    }
    const signal = AbortSignal.any([this.sessionSignal, input.signal])
    signal.throwIfAborted()
    this.host.logger.info('gemini.turn.start', { executionId: this.scope.executionId, resuming: !!this.previousSessionId })
    const child = await this.host.processes.spawn({ command: command(this.installation, args), cwd: this.scope.workspacePath, environment: this.environment, context: this.scope, signal })
    this.child = child
    let sessionId: string | undefined
    let model = this.configuration.model?.modelId ?? 'unknown'
    let accepted = false
    let finalText = ''
    try {
      await child.write(text)
      await child.endInput()
      for await (const frame of frames(child, () => this.host.logger.warn('gemini.stdout.diagnostic', { executionId: this.scope.executionId }))) {
        if (frame.type === 'init') {
          if (frame.session_id !== nativeId) {
            throw new Error('Gemini announced an unexpected native session')
          }
          sessionId = nativeId
          model = typeof frame.model === 'string' ? frame.model : model
          yield { type: 'session_started', nativeSessionId: nativeId }
        } else if (frame.type === 'result') {
          if (frame.stats && typeof frame.stats === 'object' && !Array.isArray(frame.stats) && sessionId) {
            try {
              const snapshot = await this.saveUsage(sessionId, frame.stats as JsonObject, model)
              if (snapshot) {
                yield { type: 'usage', snapshot }
              }
            } catch (error) {
              this.host.logger.warn('gemini.usage.unavailable', { executionId: this.scope.executionId, errorType: error instanceof Error ? error.name : 'unknown' })
            }
          }
          yield { type: 'item', item: frame }
          const status = this.cancelled || signal.aborted ? 'cancelled' : frame.status === 'success' && sessionId && accepted ? 'succeeded' : 'failed'
          if (status === 'failed') {
            yield { type: 'error', code: 'GEMINI_TURN_FAILED', message: 'Gemini reported a failed native turn', retry: { retryable: false, reason: 'Inspect native details before replaying input', action: 'inspect_native' } }
          }
          this.host.logger.info('gemini.turn.complete', { executionId: this.scope.executionId, status })
          yield { type: 'turn_completed', status, finalText }
          return
        } else {
          if (frame.session_id && sessionId && frame.session_id !== sessionId) {
            throw new Error('Gemini emitted an event for another native session')
          }
          if (frame.type === 'message' && frame.role === 'user' && sessionId && !accepted) {
            accepted = true
            yield { type: 'input_accepted', nativeSessionId: sessionId }
          }
          if (frame.type === 'message' && frame.role === 'assistant' && typeof frame.content === 'string') {
            if (finalText.length + frame.content.length > 4 * 1024 * 1024) {
              throw new Error('Gemini final response exceeded its limit')
            }
            finalText += frame.content
          }
          const activity = frame.type === 'tool_use' ? { kind: 'tool' as const, details: ('use tool ' + String(frame.tool_name ?? '')).trim().slice(0, 200) } : frame.type === 'message' && frame.role === 'assistant' ? { kind: 'responding' as const, details: 'write reply' } : undefined
          if (activity) {
            yield { type: 'activity', activity }
          }
          yield { type: 'item', item: frame }
        }
      }
      const ended = await child.completed
      if (this.cancelled || signal.aborted) {
        yield { type: 'turn_completed', status: 'cancelled' }
      } else {
        throw new Error('Gemini exited without a final result; exitCode=' + ended.exitCode)
      }
    } finally {
      await child.terminate()
      this.child = undefined
      this.released()
    }
  }

  async interrupt(): Promise<{ status: 'interrupted' | 'already_finished' }> {
    if (!this.child) {
      return { status: 'already_finished' }
    }
    this.cancelled = true
    await this.child.terminate()
    return { status: 'interrupted' }
  }

  async dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      await this.child?.terminate()
      this.child = undefined
      this.released()
    }
  }
}
