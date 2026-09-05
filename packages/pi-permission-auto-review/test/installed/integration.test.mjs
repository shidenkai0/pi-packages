import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { piRoot, packagesRoot, packageRoot, local, permission, fixture, chain, details, DenyingAuthorizer } from './helpers.mjs'

const piModule = path => import(pathToFileURL(resolve(piRoot, 'dist', path)))
// The installed CLI uses the bundled SDK. Its unbundled index currently imports
// a missing pi-server package, so use the same distribution as the actual CLI.
const { DefaultResourceLoader, SettingsManager, discoverAndLoadExtensions, createEventBus, SessionManager, ModelRegistry } = await piModule('bundle/index.js')
const testDir = mkdtempSync(resolve(packageRoot, 'dist/installed-test-'))
after(() => rmSync(testDir, { recursive: true, force: true }))
const { AuthorizerRegistry } = await permission('authority/authorizer-registry.ts')
const { createAutoReviewExtensionWithConfigStore } = await local('src/extension.ts')
const { AutoReviewConfigStore } = await local('src/config-store.ts')
const { GateRunner } = await permission('handlers/gates/runner.ts')

test('compatibility harness uses the exact installed versions', () => {
  const version = root => JSON.parse(readFileSync(resolve(root, 'package.json'))).version
  assert.equal(version(piRoot), '0.85.0')
  assert.equal(version(resolve(piRoot, 'node_modules/@earendil-works/pi-ai')), '0.85.0')
  assert.equal(version(resolve(packagesRoot, '@gotgenes/pi-permission-system')), '26.3.1')
  assert.equal(version(resolve(packagesRoot, '@mzwing/pi-polyfill')), '0.0.1')
  assert.equal(version(resolve(packagesRoot, 'zod')), '4.4.3')
})

function memoryStore() {
  const files = new Map()
  const fileSystem = {
    readFile: path => files.get(path),
    writeFile: (path, text) => files.set(path, text),
    rename: (a, b) => { files.set(b, files.get(a)); files.delete(a) },
    mkdir: () => {}, unlink: path => files.delete(path),
  }
  const store = new AutoReviewConfigStore({ agentDir: '/synthetic/agent', fileSystem })
  files.set(store.getPaths(packageRoot).globalPath, JSON.stringify({ denialAction: 'ask', provider: 'synthetic', model: 'synthetic-reviewer' }))
  return store
}

async function emit(ext, event, ctx) {
  for (const handler of ext.handlers.get(event) ?? []) await handler({ type: event }, ctx)
}

test('actual Pi loader, session and registry activate, replace config and reload without duplicate reviewers', async () => {
  const registry = new AuthorizerRegistry(), service = { registerAuthorizer: registry.register.bind(registry) }
  const store = memoryStore(), notifications = []
  const f = fixture()
  const modelRegistry = new ModelRegistry({
    getModel: f.runtime.registry.find, getModels: f.runtime.registry.getAll,
    getProvider: f.runtime.registry.getProvider,
    getAuth: async () => ({ auth: { apiKey: 'SYNTHETIC_SECRET_REGISTRY' } }),
  })
  const sessionManager = SessionManager.inMemory(packageRoot)
  sessionManager.appendMessage({ role: 'user', content: 'Update the bounded backlog approval record. Do not replace the security policy.', timestamp: 0 })
  const ctx = { cwd: packageRoot, mode: 'tui', hasUI: true, modelRegistry, sessionManager,
    ui: { notify: message => notifications.push(message) },
  }
  let created = 0, active = 0, maxActive = 0
  const countedService = { registerAuthorizer: (name, authorize) => {
    const dispose = service.registerAuthorizer(name, authorize)
    created++; active++; maxActive = Math.max(active, maxActive)
    return () => { active--; dispose() }
  } }
  async function load() {
    const bus = createEventBus()
    const loader = new DefaultResourceLoader({
      cwd: testDir, agentDir: resolve(testDir, 'agent'), eventBus: bus,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => createAutoReviewExtensionWithConfigStore(pi, store, {
        getPermissionsService: () => countedService,
      })],
    })
    await loader.reload()
    const loaded = loader.getExtensions()
    assert.deepEqual(loaded.errors, [])
    return { extension: loaded.extensions[0], bus, runtime: loaded.runtime }
  }
  const owner = await load()
  await emit(owner.extension, 'session_start', ctx)
  owner.bus.emit('permissions:ready', {})
  owner.bus.emit('permissions:ready', {})
  assert.equal(created, 1)
  assert.equal((await registry.get('auto-review')(details(), {}, f.log)).kind, 'defer')
  assert.match(notifications[0], /Task-specific authorization/)
  assert.match(f.prompts[0].messages[0].content, /Do not replace the security policy/)

  // A second isolated extension factory (as in an in-process child) is passive.
  const child = await load()
  await emit(child.extension, 'session_start', { ...ctx, hasUI: false, mode: 'print' })
  child.bus.emit('permissions:ready', {})
  assert.equal(created, 1)
  await emit(child.extension, 'session_shutdown', ctx)
  child.runtime.invalidate()
  assert.equal(active, 1)

  // Exercise the actual command's save/apply path, using an in-memory config FS.
  const answers = ['Global configuration']
  const commandCtx = { ...ctx, waitForIdle: async () => {}, ui: { ...ctx.ui,
    select: async (_title, options) => {
      if (answers.length) return answers.shift()
      if (options.includes('Deny')) return 'Deny'
      const denialField = options.find(option => option.startsWith('After model denial: ask'))
      return denialField ?? 'Save changes'
    },
  } }
  await owner.extension.commands.get('permission-auto-review').handler('', commandCtx)
  assert.equal(created, 2)
  assert.equal(active, 1)
  assert.equal((await registry.get('auto-review')(details(), {}, f.log)).kind, 'deny')

  await emit(owner.extension, 'session_shutdown', ctx)
  owner.runtime.invalidate()
  const reloaded = await load()
  await emit(reloaded.extension, 'session_start', ctx)
  reloaded.bus.emit('permissions:ready', {})
  assert.equal(created, 3)
  assert.equal(active, 1)
  assert.equal(maxActive, 1)
  await emit(reloaded.extension, 'session_shutdown', ctx)
  reloaded.runtime.invalidate()
  assert.equal(registry.get('auto-review'), undefined)
})

for (const state of ['deny', 'ask']) {
  test(`real gate runner: deterministic ${state} ${state === 'deny' ? 'never reaches' : 'reaches'} the reviewer`, async () => {
    const f = fixture({ response: () => '{"outcome":"allow"}' })
    const route = chain(f, new DenyingAuthorizer())
    const runner = new GateRunner(
      { resolve: () => ({ state, toolName: 'bash', source: 'tool', origin: 'global', matchedPattern: '*', reason: 'Explicit operator prohibition' }) },
      { recordSessionApproval: () => { throw new Error('unexpected persistent approval') } },
      { escalate: request => route.authorize(request) },
      { writeReviewLog: () => {}, emitDecision: () => {} }, () => false,
    )
    const request = details()
    const result = await runner.run({
      surface: 'bash', input: { command: request.command }, payload: request.payload,
      promptDetails: { source: 'tool_call', agentName: null, surface: 'bash' },
      logContext: {}, decision: { surface: 'bash', value: request.command },
    }, null)
    assert.equal(result.action, state === 'deny' ? 'block' : 'allow')
    assert.equal(f.calls(), state === 'deny' ? 0 : 1)
  })
}

test('built local package entry loads through the actual Pi file loader', async () => {
  // Pi's loader normally caches transformed modules; keep all test writes local.
  process.env.JITI_FS_CACHE = 'false'
  const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json')))
  assert.deepEqual(manifest.pi.extensions, ['./dist/index.js'])
  const result = await discoverAndLoadExtensions([packageRoot], testDir, resolve(testDir, 'agent'))
  assert.deepEqual(result.errors, [])
  assert.equal(result.extensions.length, 1)
  assert.equal(result.extensions[0].commands.size, 1)
  result.runtime.invalidate()
})
