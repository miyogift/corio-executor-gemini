import { access, chmod, copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { AuthenticationConfiguration, ConfigureInput, ConfigureResult, ExtensionHost, InstanceScope, JsonObject, McpConnection, ModelBinding } from '@xcye/corio-executor-sdk'

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 })
  await rename(temporary, path)
}

/** GEMINI_CLI_HOME 是父目录；原生设置、OAuth 与历史在其 .gemini 中，不能复用其他 Agent。 */
export class GeminiConfiguration {
  readonly nativeHome: string
  readonly nativeDirectory: string
  model?: ModelBinding
  authentication: AuthenticationConfiguration = { methodId: 'from-device', params: {} }
  runtime: JsonObject = {}
  private mcp: readonly McpConnection[] = []

  constructor(
    readonly scope: InstanceScope,
    private readonly host: ExtensionHost
  ) {
    this.nativeHome = join(scope.stateDirectory, 'native')
    this.nativeDirectory = join(this.nativeHome, '.gemini')
  }

  async configure(input: ConfigureInput): Promise<ConfigureResult> {
    if (input.type === 'model') {
      const model = input.params.primary
      const reasoning = model?.reasoning
      if (
        Object.keys(input.params).some((key) => key !== 'primary') ||
        (model && model.protocol !== 'google_generate_content') ||
        Object.keys(model?.options ?? {}).length ||
        (reasoning?.mode === 'effort' && !['minimal', 'low', 'medium', 'high'].includes(reasoning.effort ?? '')) ||
        (reasoning?.mode === 'budget' && !/^[1-9]\d{0,8}$/.test(reasoning.budgetTokens ?? ''))
      ) {
        return { status: 'unsupported', appliedRevision: null, reason: 'Unsupported Gemini primary model or reasoning control' }
      }
      this.model = model
    } else if (input.type === 'authentication') {
      if (!['provider', 'from-device'].includes(input.params.methodId)) {
        return { status: 'unsupported', appliedRevision: null, reason: 'Unknown Gemini authentication method' }
      }
      const credential = input.params.credentialRef ? await this.host.credentials.read(this.scope, input.params.credentialRef) : null
      if (input.params.credentialRef && !credential) {
        throw new Error('The selected Gemini credential is unavailable')
      }
      this.authentication = { ...input.params, params: credential ?? input.params.params }
      await this.importDeviceCredential()
    } else if (input.type === 'mcp') {
      this.mcp = input.params
    } else if (input.type === 'runtime') {
      const turns = input.params.maxSessionTurns
      if (
        Object.keys(input.params).some((key) => !['approvalMode', 'maxSessionTurns'].includes(key)) ||
        (input.params.approvalMode !== undefined && !['yolo', 'plan'].includes(String(input.params.approvalMode))) ||
        (turns !== undefined && (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1 || turns > 1000))
      ) {
        return { status: 'unsupported', appliedRevision: null, reason: 'Unsupported non-interactive Gemini runtime setting' }
      }
      this.runtime = input.params
    } else {
      return { status: 'unsupported', appliedRevision: null, reason: 'Unknown Gemini configuration namespace' }
    }
    await this.project()
    return { status: 'applied', appliedRevision: input.revision }
  }

  async environment(): Promise<Record<string, string>> {
    const result: Record<string, string> = { GEMINI_CLI_HOME: this.nativeHome, GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(this.nativeHome, 'system-settings.json'), GEMINI_TELEMETRY_ENABLED: 'false' }
    if (this.authentication.methodId === 'provider') {
      if (!this.model?.providerId) {
        throw new Error('Gemini provider authentication requires a company model connection')
      }
      const connection = await this.host.models.resolve(this.scope, this.model)
      if (connection.protocol !== 'google_generate_content' || typeof connection.credential?.apiKey !== 'string' || !connection.credential.apiKey) {
        throw new Error('Gemini requires an authorized GenerateContent endpoint and API key')
      }
      Object.assign(result, { GEMINI_API_KEY: connection.credential.apiKey, GOOGLE_GEMINI_BASE_URL: connection.baseUrl })
    } else if (typeof this.authentication.params.cloudProjectId === 'string' && this.authentication.params.cloudProjectId) {
      result.GOOGLE_CLOUD_PROJECT = this.authentication.params.cloudProjectId
    }
    return result
  }

  async project(): Promise<void> {
    await mkdir(this.nativeDirectory, { recursive: true, mode: 0o700 })
    const servers: Record<string, unknown> = {}
    for (const connection of this.mcp) {
      if (Object.hasOwn(servers, connection.name)) {
        throw new Error('Duplicate Gemini MCP server name')
      }
      if (connection.transport === 'stdio') {
        if (!connection.command) {
          throw new Error('stdio MCP requires a command')
        }
        servers[connection.name] = { command: connection.command, args: [...(connection.args ?? [])], env: { ...(connection.environment ?? {}) } }
      } else {
        if (!connection.url) {
          throw new Error('Remote MCP requires a URL')
        }
        servers[connection.name] = { [connection.transport === 'sse' ? 'url' : 'httpUrl']: connection.url, headers: { ...(connection.headers ?? {}) } }
      }
    }
    const reasoning = this.model?.reasoning
    const thinking = reasoning?.mode === 'off' ? { thinkingBudget: 0 } : reasoning?.mode === 'budget' ? { thinkingBudget: Number(reasoning.budgetTokens) } : reasoning?.mode === 'effort' ? { thinkingLevel: reasoning.effort!.toUpperCase() } : null
    const settings = {
      security: { auth: { selectedType: this.authentication.methodId === 'provider' ? 'gemini-api-key' : 'oauth-personal' } },
      context: { fileName: ['SOUL.md', 'GEMINI.md'] },
      model: { name: this.model?.modelId, maxSessionTurns: this.runtime.maxSessionTurns ?? 100 },
      modelConfigs: thinking && this.model ? { customOverrides: [{ match: { model: this.model.modelId }, modelConfig: { generateContentConfig: { thinkingConfig: thinking } } }] } : {},
      general: { disableAutoUpdate: true },
      telemetry: { enabled: false },
      mcpServers: servers
    }
    await writePrivateJson(join(this.nativeDirectory, 'settings.json'), settings)
    await writePrivateJson(join(this.nativeHome, 'system-settings.json'), {})
  }

  private async importDeviceCredential(): Promise<void> {
    const selected = this.authentication.params.credentialDirectory
    const source = typeof selected === 'string' && selected ? selected : join(homedir(), '.gemini')
    if (this.authentication.methodId !== 'from-device' || typeof source !== 'string' || !source) {
      return
    }
    if (!isAbsolute(source)) {
      throw new Error('The selected Gemini credential directory must be absolute')
    }
    await mkdir(this.nativeDirectory, { recursive: true, mode: 0o700 })
    const marker = join(this.scope.stateDirectory, 'device-import.json')
    let previous: { source?: string } = {}
    try {
      previous = JSON.parse(await readFile(marker, 'utf8')) as typeof previous
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    const destination = join(this.nativeDirectory, 'oauth_creds.json')
    if (
      previous.source === source ||
      (await access(destination).then(
        () => true,
        () => false
      ))
    ) {
      return
    }
    if (
      !(await access(join(source, 'oauth_creds.json')).then(
        () => true,
        () => false
      )) &&
      !selected
    ) {
      return
    }
    await copyFile(join(source, 'oauth_creds.json'), destination)
    await chmod(destination, 0o600)
    await writePrivateJson(marker, { source })
  }
}
