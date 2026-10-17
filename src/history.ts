import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { ExecutorHistory, JsonObject } from '@xcye/corio-executor-sdk'

export const nativeSessionPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i

interface Transcript {
  readonly metadata: JsonObject
  readonly messages: readonly JsonObject[]
}

/** 原生 JSONL 含消息更新和回退；按记录顺序复原，不把已回退的消息继续展示。 */
export function parseTranscript(text: string): Transcript {
  let records: unknown[]
  try {
    records = [JSON.parse(text)]
  } catch {
    records = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as unknown)
  }
  let metadata: JsonObject = {}
  const messages = new Map<string, JsonObject>()
  for (const value of records) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid Gemini transcript record')
    }
    const record = value as JsonObject
    if (typeof record.$rewindTo === 'string') {
      const keys = [...messages.keys()]
      const index = keys.indexOf(record.$rewindTo)
      for (const key of keys.slice(Math.max(0, index))) {
        messages.delete(key)
      }
    } else if (typeof record.id === 'string') {
      messages.set(record.id, record)
    } else {
      const update = record.$set && typeof record.$set === 'object' && !Array.isArray(record.$set) ? (record.$set as JsonObject) : record
      const { messages: embedded, ...fields } = update
      metadata = { ...metadata, ...fields }
      if (Array.isArray(embedded)) {
        messages.clear()
        for (const item of embedded) {
          if (item && typeof item === 'object' && !Array.isArray(item) && typeof item.id === 'string') {
            messages.set(item.id, item)
          }
        }
      }
    }
  }
  return { metadata, messages: [...messages.values()] }
}

async function transcript(nativeDirectory: string, sessionId: string): Promise<Transcript | null> {
  if (!nativeSessionPattern.test(sessionId)) {
    throw new Error('Gemini native session ID must be a UUID')
  }
  const root = join(nativeDirectory, 'tmp')
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  const actualRoot = await realpath(root)
  for (const project of projects) {
    if (!project.isDirectory() || project.isSymbolicLink()) {
      continue
    }
    const directory = join(root, project.name, 'chats')
    const files = await readdir(directory, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    })
    for (const file of files) {
      if (!file.isFile() || file.isSymbolicLink() || !/^session-.*\.jsonl?$/.test(file.name) || !file.name.includes(sessionId.slice(0, 8))) {
        continue
      }
      const path = join(directory, file.name)
      const info = await lstat(path)
      const location = relative(actualRoot, await realpath(path))
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024 || isAbsolute(location) || location === '..' || location.startsWith('..' + sep)) {
        throw new Error('The Gemini transcript is not a bounded Agent-owned file')
      }
      const loaded = parseTranscript(await readFile(path, 'utf8'))
      if (loaded.metadata.sessionId === sessionId) {
        return loaded
      }
    }
  }
  return null
}

/** 只读确切会话；原生未公开稳定 turn ID，不用消息 UUID 或 Corio execution ID 代替。 */
export function geminiHistory(nativeDirectory: string): ExecutorHistory {
  return {
    async probe(input) {
      try {
        return (await transcript(nativeDirectory, input.nativeSessionId)) ? { status: 'available' } : { status: 'missing' }
      } catch {
        return { status: 'unknown', reason: 'The exact Agent-owned Gemini transcript could not be read' }
      }
    },
    async read(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100 || (input.cursor !== undefined && !/^\d{1,9}$/.test(input.cursor))) {
        throw new Error('Invalid Gemini history page')
      }
      if (input.nativeTurnId) {
        return { status: 'unsupported', reason: 'This Gemini adapter has no native turn lookup' }
      }
      const loaded = await transcript(nativeDirectory, input.nativeSessionId)
      if (!loaded) {
        return { status: 'unavailable', reason: 'The exact Gemini session is not on this device' }
      }
      const start = Number(input.cursor ?? '0')
      return { status: 'available', items: loaded.messages.slice(start, start + input.limit), nextCursor: start + input.limit < loaded.messages.length ? String(start + input.limit) : null }
    },
    async sessionMetadata(input) {
      const loaded = await transcript(nativeDirectory, input.nativeSessionId)
      if (!loaded) {
        return { status: 'unavailable', reason: 'The exact Gemini session is not on this device' }
      }
      return { status: 'available', title: typeof loaded.metadata.title === 'string' ? loaded.metadata.title : typeof loaded.metadata.summary === 'string' ? loaded.metadata.summary : null }
    }
  }
}
