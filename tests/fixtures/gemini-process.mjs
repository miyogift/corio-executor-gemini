import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// 只有 EOF 后才处理提示，防止宿主误用永远打开的 JSONL 输入流。
let text = ''
for await (const chunk of process.stdin) { text += chunk }
const args = process.argv.slice(2)
const resume = args.indexOf('--resume')
const sessionId = args[resume >= 0 ? resume + 1 : args.indexOf('--session-id') + 1]
const emit = value => process.stdout.write(JSON.stringify(value) + '\n')
process.stdout.write('Rename failed; native storage is using its copy fallback.\n')
emit({ type: 'init', session_id: sessionId, model: 'fixture-model' })
emit({ type: 'message', role: 'user', content: text })
if (text === 'wait-until-interrupted') { await new Promise(() => {}) }
const directory = join(process.env.GEMINI_CLI_HOME, '.gemini', 'tmp', 'fixture-project', 'chats')
await mkdir(directory, { recursive: true })
const file = join(directory, 'session-fixture-' + sessionId.slice(0, 8) + '.jsonl')
const previous = await readFile(file, 'utf8').catch(() => '')
const metadata = JSON.stringify({ sessionId, projectHash: 'fixture-project', summary: 'Native fixture title' }) + '\n'
const message = JSON.stringify({ id: process.env.CORIO_EXECUTION_ID, type: 'user', content: text }) + '\n'
await writeFile(file, (previous || metadata) + message)
emit({ type: 'message', role: 'assistant', content: '内部执行详情', delta: true })
emit({ type: 'result', status: text === 'fail-native' ? 'error' : 'success', stats: { models: {
  'fixture-model': { input_tokens: 15, input: 10, output_tokens: 4, cached: 5 },
  'fixture-helper': { input_tokens: 3, input: 3, output_tokens: 2, cached: 0 },
} } })
