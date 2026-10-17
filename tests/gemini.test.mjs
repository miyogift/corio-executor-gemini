import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const root = process.env.CORIO_GEMINI_TEST_ROOT ?? dirname(dirname(fileURLToPath(import.meta.url)))
const { GeminiAdapter } = await import(pathToFileURL(join(root, 'dist/executor.js')))
const { GeminiConfiguration } = await import(pathToFileURL(join(root, 'dist/configuration.js')))
const { geminiUsage } = await import(pathToFileURL(join(root, 'dist/usage.js')))
const { parseTranscript } = await import(pathToFileURL(join(root, 'dist/history.js')))
const { geminiLifecycle } = await import(pathToFileURL(join(root, 'dist/lifecycle.js')))
const fixture = fileURLToPath(new URL('./fixtures/gemini-process.mjs', import.meta.url))

function host(calls = []) {
  return {
    sdkVersion: '1.0.0',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    credentials: {
      async read() {
        return null
      },
      async write() {},
      async remove() {}
    },
    models: {
      async resolve() {
        return { baseUrl: 'https://fixture.invalid/opaque/base', protocol: 'google_generate_content', credential: { apiKey: 'fixture-secret' } }
      }
    },
    context: {
      async call() {
        throw new Error('Native text must not become a Corio action')
      }
    },
    processes: {
      async spawn(input) {
        calls.push(input)
        const child = spawn(input.command.executable, input.command.args, { cwd: input.cwd, windowsHide: true, env: { ...process.env, ...input.environment, CORIO_EXECUTION_ID: input.context?.executionId ?? '' }, stdio: ['pipe', 'pipe', 'pipe'], signal: input.signal })
        const completed = new Promise((resolve, reject) => {
          child.once('close', (exitCode, signal) => resolve({ exitCode, signal }))
          child.once('error', reject)
        })
        void completed.catch(() => {})
        return {
          completed,
          output: {
            async *[Symbol.asyncIterator]() {
              for await (const line of createInterface({ input: child.stdout })) {
                const split = Math.floor(line.length / 2)
                yield { channel: 'stdout', text: line.slice(0, split) }
                yield { channel: 'stdout', text: line.slice(split) + '\n' }
              }
            }
          },
          async write(text) {
            await new Promise((resolve, reject) => child.stdin.write(text, (error) => (error ? reject(error) : resolve())))
          },
          async endInput() {
            await new Promise((resolve) => child.stdin.end(resolve))
          },
          async terminate() {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill()
            }
            await completed.catch(() => {})
          }
        }
      }
    }
  }
}

async function scope(t) {
  const directory = await mkdtemp(join(tmpdir(), 'corio-gemini-extension-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { homeSpaceId: 'company', agentId: '1', executorId: 'executor', workspacePath: directory, stateDirectory: join(directory, 'state'), targetSpaceId: 'company', threadId: 'thread', executionId: 'execution-a' }
}
const installation = { installationId: 'a'.repeat(64), runtimeVersion: 'fixture', directory: null, command: { executable: process.execPath, args: [fixture] }, ownership: 'external', metadata: {} }

test('EOF submits one turn, exact native resume preserves execution identity and history queries are read-only', { timeout: 15000 }, async (t) => {
  const current = await scope(t)
  const calls = []
  const adapter = new GeminiAdapter(host(calls), current, installation)
  t.after(() => adapter.dispose())
  const first = await adapter.openSession({ scope: current, installation, signal: AbortSignal.timeout(10000) })
  const events = await Array.fromAsync(first.run({ text: 'first', attachments: [], signal: AbortSignal.timeout(10000) }))
  const sessionId = events.find((event) => event.type === 'session_started').nativeSessionId
  assert.equal(events.find((event) => event.type === 'turn_completed').status, 'succeeded')
  assert.equal(events.find((event) => event.type === 'turn_completed').nativeTurnId, undefined)
  assert.equal(events.find((event) => event.type === 'usage').snapshot.scope, 'call')
  assert.equal(events.find((event) => event.type === 'usage').snapshot.modelUsages.length, 2)
  const second = await adapter.openSession({ scope: { ...current, executionId: 'execution-b' }, installation, nativeSessionId: sessionId, signal: AbortSignal.timeout(10000) })
  await Array.fromAsync(second.run({ text: 'second', attachments: [], signal: AbortSignal.timeout(10000) }))
  assert.equal(calls[1].command.args[calls[1].command.args.indexOf('--resume') + 1], sessionId)
  const before = calls.length
  const history = await adapter.history.read({ nativeSessionId: sessionId, stateDirectory: current.stateDirectory, limit: 100 })
  assert.deepEqual(
    history.items.map((item) => item.id),
    ['execution-a', 'execution-b']
  )
  assert.equal((await adapter.history.sessionMetadata({ nativeSessionId: sessionId, stateDirectory: current.stateDirectory })).title, 'Native fixture title')
  assert.equal((await adapter.usage.read({ nativeSessionId: sessionId, stateDirectory: current.stateDirectory })).snapshot.snapshotId, 'gemini:execution-b')
  assert.equal(calls.length, before)
  assert.ok(calls.every((call) => !call.command.args.includes('first') && !call.command.args.includes('second')))
  await assert.rejects(adapter.openSession({ scope: current, installation, nativeSessionId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', signal: new AbortController().signal }), /unavailable/)
})

test('interrupt releases the native process without automatic replay; unsupported output schema does not start inference', { timeout: 10000 }, async (t) => {
  const current = await scope(t)
  const calls = []
  const adapter = new GeminiAdapter(host(calls), current, installation)
  t.after(() => adapter.dispose())
  const session = await adapter.openSession({ scope: current, installation, signal: AbortSignal.timeout(8000) })
  const events = []
  const running = (async () => {
    for await (const event of session.run({ text: 'wait-until-interrupted', attachments: [], signal: AbortSignal.timeout(8000) })) {
      events.push(event)
      if (event.type === 'input_accepted') {
        assert.equal((await session.interrupt()).status, 'interrupted')
      }
    }
  })()
  await running
  assert.equal(events.at(-1).status, 'cancelled')
  assert.equal(calls.length, 1)
  const structured = await adapter.openSession({ scope: current, installation, signal: new AbortController().signal })
  await assert.rejects(Array.fromAsync(structured.run({ text: 'unused', attachments: [], outputSchema: { type: 'object' }, signal: new AbortController().signal })), /structured output/)
  assert.equal(calls.length, 1)
})

test('provider credentials stay in environment, native settings project exact protocols and thinking controls', async (t) => {
  const current = await scope(t)
  const configuration = new GeminiConfiguration(current, host())
  await configuration.configure({
    scope: current,
    revision: '1',
    type: 'model',
    params: {
      primary: { providerId: 'fixture', modelId: 'gemini-3-flash-preview', protocol: 'google_generate_content', reasoning: { mode: 'effort', effort: 'high' } }
    }
  })
  await configuration.configure({ scope: current, revision: '2', type: 'authentication', params: { methodId: 'provider', params: {} } })
  await configuration.configure({ scope: current, revision: '3', type: 'mcp', params: [{ id: 'mcp', name: 'outline', transport: 'streamable_http', url: 'https://fixture.invalid/mcp', headers: { Authorization: 'Bearer fixture-mcp' } }] })
  const environment = await configuration.environment()
  assert.equal(environment.GOOGLE_GEMINI_BASE_URL, 'https://fixture.invalid/opaque/base')
  assert.equal(environment.GEMINI_API_KEY, 'fixture-secret')
  const settings = JSON.parse(await readFile(join(configuration.nativeDirectory, 'settings.json'), 'utf8'))
  assert.equal(settings.security.auth.selectedType, 'gemini-api-key')
  assert.equal(settings.mcpServers.outline.httpUrl, 'https://fixture.invalid/mcp')
  assert.equal(settings.modelConfigs.customOverrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, 'HIGH')
  assert.ok(!JSON.stringify(settings).includes('fixture-secret'))
  assert.equal(
    (
      await configuration.configure({
        scope: current,
        revision: '4',
        type: 'model',
        params: {
          primary: { modelId: 'any', protocol: 'anthropic_messages' }
        }
      })
    ).status,
    'unsupported'
  )
})

test('device imports only the requested OAuth file and logout cannot silently reimport it', async (t) => {
  const current = await scope(t)
  const device = join(current.workspacePath, 'device')
  await mkdir(device)
  await writeFile(join(device, 'oauth_creds.json'), JSON.stringify({ refresh_token: 'fixture-refresh' }))
  await writeFile(join(device, 'settings.json'), '{"privateMcp":"do-not-copy"}')
  const adapter = new GeminiAdapter(host(), current, installation)
  t.after(() => adapter.dispose())
  const input = { scope: current, revision: '1', type: 'authentication', params: { methodId: 'from-device', params: { credentialDirectory: device } } }
  await adapter.configure(input)
  assert.equal((await adapter.authentication.getStatus({ scope: current, methodId: 'from-device' })).status, 'authorized')
  await adapter.authentication.logout({ scope: current, methodId: 'from-device' })
  await adapter.configure({ ...input, revision: '2' })
  await assert.rejects(access(join(current.stateDirectory, 'native', '.gemini', 'oauth_creds.json')))
  assert.equal((await adapter.authentication.getStatus({ scope: current, methodId: 'from-device' })).status, 'authorization_required')
  const step = await adapter.authentication.beginLogin({ scope: current, methodId: 'from-device', params: {}, attemptId: 'login' })
  assert.equal(step.type, 'local_terminal')
  assert.equal((await adapter.authentication.continueLogin({ scope: current, attemptId: 'login', params: {} })).type, 'waiting')
})

test('native JSONL edits/rewinds replace messages and unknown prices are not invented', () => {
  const value = parseTranscript([{ sessionId: 'native', projectHash: 'project' }, { id: 'a', content: 'original' }, { id: 'b', content: 'discarded' }, { id: 'a', content: 'edited' }, { $rewindTo: 'b' }, { $set: { summary: 'Native title' } }].map(JSON.stringify).join('\n'))
  assert.deepEqual(
    value.messages.map((item) => item.content),
    ['edited']
  )
  assert.equal(value.metadata.summary, 'Native title')
  const usage = geminiUsage(
    'execution',
    'native',
    {
      models: {
        'unknown-model': { input: 10, input_tokens: 15, output_tokens: 3, cached: 5 }
      },
      total_tokens: 18
    },
    'selected-model'
  )
  assert.equal(usage.modelUsages[0].model, 'unknown-model')
  assert.equal(usage.modelUsages[0].inputTokens, '10')
  assert.equal(usage.nativeTotalCostUsd, undefined)
  assert.equal(usage.scope, 'call')
  assert.equal(geminiUsage('execution', 'native', {}, 'model'), null)
})

test('lifecycle inspects a fixed native release and does not uninstall external programs', async (t) => {
  const current = await scope(t)
  const packageRoot = join(current.workspacePath, 'node_modules/@google/gemini-cli')
  await mkdir(join(packageRoot, 'bundle'), { recursive: true })
  await writeFile(join(packageRoot, 'bundle/gemini.js'), '')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '0.61.0', bin: { gemini: 'bundle/gemini.js' } }))
  const lifecycle = geminiLifecycle(host())
  const checked = await lifecycle.inspect({ installationId: 'a'.repeat(64), suggestedDirectory: current.workspacePath, signal: new AbortController().signal, platform: process.platform, architecture: process.arch })
  assert.equal(checked.status, 'available')
  assert.equal(checked.installation.command.executable, process.execPath)
  await assert.rejects(lifecycle.uninstall({ installation: { ...checked.installation, ownership: 'external' }, signal: new AbortController().signal }), /Corio-owned/)
})
