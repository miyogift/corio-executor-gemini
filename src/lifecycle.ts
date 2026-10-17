import { access, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { ExtensionHost, ExtensionLifecycle, InstallationInput, InstallationResult } from '@xcye/corio-executor-sdk'

export const geminiRuntimeVersion = '0.61.0'
const nativePackage = '@google/gemini-cli'

async function npmScript(): Promise<string> {
  for (const path of [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]) {
    if (
      path?.endsWith('npm-cli.js') &&
      (await access(path).then(
        () => true,
        () => false
      ))
    ) {
      return path
    }
  }
  throw new Error('npm is required to install Gemini CLI')
}

async function installed(input: InstallationInput): Promise<InstallationResult | null> {
  const packageRoot = join(input.suggestedDirectory, 'node_modules', nativePackage)
  let metadata: { version: string; bin: string | Record<string, string> }
  try {
    metadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as typeof metadata
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
  if (metadata.version !== (input.expectedRuntimeVersion ?? geminiRuntimeVersion)) {
    return null
  }
  const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.gemini
  if (!bin) {
    throw new Error('The installed Gemini CLI package has no command')
  }
  const actualRoot = await realpath(packageRoot)
  const entry = await realpath(join(actualRoot, bin))
  const location = relative(actualRoot, entry)
  if (isAbsolute(location) || location === '..' || location.startsWith('..' + sep)) {
    throw new Error('Gemini CLI command points outside its installation')
  }
  return {
    installationId: input.installationId,
    runtimeVersion: metadata.version,
    directory: input.suggestedDirectory,
    ownership: 'managed',
    command: ['.js', '.mjs', '.cjs'].includes(extname(entry)) ? { executable: process.execPath, args: [entry] } : { executable: entry, args: [] },
    metadata: { packageRoot: actualRoot, managedPrefix: input.suggestedDirectory }
  }
}

/** npm 扩展与原生版本分别登记，不修改全局 PATH；安装检查不启动模型请求。 */
export function geminiLifecycle(host: ExtensionHost): ExtensionLifecycle {
  return {
    async inspect(input) {
      const current = await installed(input)
      return current ? { status: 'available', installation: current } : { status: 'missing' }
    },
    async install(input) {
      input.signal.throwIfAborted()
      const current = await installed(input)
      if (current) {
        return current
      }
      const version = input.expectedRuntimeVersion ?? geminiRuntimeVersion
      if (!/^\d+\.\d+\.\d+(?:-[a-z\d.-]+)?$/i.test(version)) {
        throw new Error('Gemini CLI runtimeVersion must be a fixed release')
      }
      await mkdir(input.suggestedDirectory, { recursive: true, mode: 0o700 })
      host.logger.info('gemini.install.start', { installationId: input.installationId, runtimeVersion: version })
      const child = await host.processes.spawn({
        command: { executable: process.execPath, args: [await npmScript(), 'install', '--prefix', input.suggestedDirectory, '--no-audit', '--no-fund', '--no-package-lock', nativePackage + '@' + version] },
        cwd: input.suggestedDirectory,
        signal: input.signal
      })
      for await (const _ of child.output) {
        /* 消费安装输出，不作为业务事件或记录凭据。 */
      }
      const finished = await child.completed
      if (finished.exitCode !== 0) {
        throw new Error('Gemini CLI installation exited with code ' + finished.exitCode)
      }
      const result = await installed(input)
      if (!result) {
        throw new Error('Gemini CLI installation did not produce the requested release')
      }
      host.logger.info('gemini.install.complete', { installationId: input.installationId, runtimeVersion: version })
      return result
    },
    async uninstall(input) {
      const prefix = input.installation.metadata.managedPrefix
      const packageRoot = input.installation.metadata.packageRoot
      if (
        input.installation.ownership !== 'managed' ||
        typeof prefix !== 'string' ||
        !isAbsolute(prefix) ||
        prefix !== input.installation.directory ||
        !/^[a-f\d]{64}$/.test(input.installation.installationId) ||
        typeof packageRoot !== 'string' ||
        (await realpath(join(prefix, 'node_modules', nativePackage))) !== packageRoot
      ) {
        throw new Error('Only the recorded Corio-owned Gemini CLI installation can be removed')
      }
      input.signal.throwIfAborted()
      await rm(prefix, { recursive: true, force: true })
    }
  }
}
