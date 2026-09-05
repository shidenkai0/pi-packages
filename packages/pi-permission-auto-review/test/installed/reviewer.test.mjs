import assert from 'node:assert/strict'
import test from 'node:test'
import { autoReviewConfigSchema, fixture, details, chain, DenyingAuthorizer, permission, local } from './helpers.mjs'

const { LocalUserAuthorizer } = await permission('authority/local-user-authorizer.ts')
const { requestPermissionDecision } = await permission('authority/permission-prompt-component.ts')
const { DEFAULT_RENDER_BUDGET } = await permission('presentation/dialog-renderer.ts')

function human(choice, observed = []) {
  return new LocalUserAuthorizer({
    mode: 'rpc',
    ui: {
      select: async (title, options) => { observed.push({ title, options }); return choice },
      input: async () => 'Please keep the prohibition in place.',
    },
    events: { emit: () => {} },
    getPromptPreferences: () => ({ doublePressToConfirm: false, budget: DEFAULT_RENDER_BUDGET }),
    requestPermissionDecision,
  })
}

for (const [key, approved] of [['y', true], ['n', false]]) {
  test(`installed TUI component shows action and accepts ${key}`, async () => {
    const f = fixture({ config: { denialAction: 'ask' } })
    const terminal = new LocalUserAuthorizer({
      mode: 'tui', events: { emit: () => {} },
      getPromptPreferences: () => ({ doublePressToConfirm: false, budget: DEFAULT_RENDER_BUDGET }),
      requestPermissionDecision,
      ui: { custom: factory => new Promise(resolve => {
        const component = factory({ requestRender: () => {} }, { fg: (_color, text) => text }, { matches: () => false }, resolve)
        assert.match(component.render(100).join('\n'), /backlog\/approval-record.md/)
        assert.match(f.notifications[0], /Task-specific authorization/)
        component.handleInput(key)
      }) },
    })
    const result = await chain(f, terminal).authorize(details())
    assert.equal(result.approved, approved)
    assert.deepEqual(result.decidedBy, { kind: 'user', via: 'dialog' })
  })
}

test('denialAction defaults to deny and accepts the human opt-in', () => {
  assert.equal(autoReviewConfigSchema.parse({}).denialAction, 'deny')
  assert.equal(autoReviewConfigSchema.parse({ denialAction: 'ask' }).denialAction, 'ask')
  assert.equal(autoReviewConfigSchema.safeParse({ denialAction: 'allow' }).success, false)
})

for (const mode of ['deny', 'ask']) {
  test(`ordinary model allow remains nonpersistent (${mode})`, async () => {
    const f = fixture({ config: { denialAction: mode }, response: () => '{"outcome":"allow"}' })
    const result = await chain(f, { authorize: () => { throw new Error('unexpected human prompt') } }).authorize(details())
    assert.equal(result.approved, true)
    assert.equal(result.state, 'approved')
    assert.equal(f.notifications.length, 0)
  })
}

test('default model deny remains terminal', async () => {
  const f = fixture()
  const result = await chain(f, { authorize: () => { throw new Error('unexpected human prompt') } }).authorize(details())
  assert.equal(result.approved, false)
  assert.match(result.denialReason, /Task-specific authorization/)
})

for (const [choice, approved] of [['Yes', true], ['No', false], ['No, provide reason', false], [undefined, false]]) {
  test(`model deny reaches installed human UI decision: ${choice ?? 'dismiss'}`, async () => {
    const f = fixture({ config: { denialAction: 'ask' } })
    const observed = []
    const result = await chain(f, human(choice, observed)).authorize(details())
    assert.equal(result.approved, approved)
    assert.equal(observed.length, 1)
    assert.match(observed[0].title, /backlog\/approval-record.md/)
    assert.match(f.notifications[0], /synthetic-request-1/)
    assert.match(f.notifications[0], /advisory/)
    assert.deepEqual(result.decidedBy, { kind: 'user', via: 'select' })
    if (choice === 'No, provide reason') assert.match(result.denialReason, /prohibition/)
    assert.equal(f.logs.find(log => log.modelOutcome === 'deny').outcome, 'defer')
    assert.doesNotMatch(JSON.stringify(f.logs), /Task-specific|SYNTHETIC_SECRET/)
  })
}

test('rationale controls are sanitized and the original action is not modified', async () => {
  const f = fixture({ config: { denialAction: 'ask' }, response: () => JSON.stringify({
    outcome: 'deny', rationale: 'Unclear\u001b[2J authorization\r\nPlease review.',
  }) })
  const request = details(), original = structuredClone(request)
  await chain(f, human('No')).authorize(request)
  assert.deepEqual(request, original)
  assert.doesNotMatch(f.notifications[0], /\u001b|\r/)
  assert.match(f.notifications[0], /Unclear/)
})

test('deny without model rationale still has an actionable explanation', async () => {
  const f = fixture({ config: { denialAction: 'ask' }, response: () => '{"outcome":"deny"}' })
  await chain(f, human('No')).authorize(details())
  assert.match(f.notifications[0], /without a rationale/)
  assert.match(f.notifications[0], /permission prompt/)
})

for (const mode of ['deny', 'ask']) {
  test(`three-denial circuit breaker preserves ${mode} behavior and resets next turn`, async () => {
    const f = fixture({ config: { denialAction: mode } })
    const observed = [], route = chain(f, human('No', observed))
    for (let i = 0; i < 4; i++) await route.authorize(details())
    assert.equal(f.calls(), 3)
    assert.equal(observed.length, mode === 'ask' ? 4 : 0)
    if (mode === 'ask') assert.match(f.notifications.at(-1), /has not been reviewed/)
    assert.equal(f.logs.at(-1).outcome, mode === 'ask' ? 'defer' : 'deny')
    f.runtime.circuitBreaker.resetTurn()
    await route.authorize(details())
    assert.equal(f.calls(), 4)
  })
}

test('ten nonconsecutive denials open the breaker within its fifty-review window', async () => {
  let index = 0
  const f = fixture({ config: { denialAction: 'ask' }, response: () => JSON.stringify({ outcome: index++ % 2 === 0 ? 'deny' : 'allow' }) })
  const route = chain(f, human('No'))
  for (let i = 0; i < 21; i++) await route.authorize(details())
  assert.equal(f.calls(), 19)
  assert.match(f.notifications.at(-1), /repeated model denials/)
})

const failures = {
  'provider-unresolved': { registry: { getProvider: () => undefined } },
  'model-unresolved': { registry: { find: () => undefined } },
  'auth-unresolved': { registry: { getApiKeyAndHeaders: async () => ({ ok: false }) } },
  'provider-error': { response: () => { throw new Error('SYNTHETIC_SECRET_PROVIDER_ERROR') } },
  'invalid-response': { response: () => 'SYNTHETIC_SECRET_MALFORMED_RESPONSE' },
  timeout: { response: () => new Promise(() => {}), config: { timeoutMs: 15 } },
  'internal-error': { runtime: { sessionManager: { getBranch: () => { throw new Error('synthetic internal error') } } } },
}
for (const [category, options] of Object.entries(failures)) {
  for (const approved of [false, true]) {
    test(`${category} defers, human ${approved ? 'approves' : 'denies'}`, async () => {
      const f = fixture({ ...options, config: { ...options.config, denialAction: 'ask' } })
      const result = await chain(f, human(approved ? 'Yes' : 'No')).authorize(details())
      assert.equal(result.approved, approved)
      assert.ok(f.logs.some(log => log.errorCategory === category))
      assert.doesNotMatch(JSON.stringify(f.logs), /SYNTHETIC_SECRET/)
      if (category !== 'internal-error') assert.match(f.notifications[0], new RegExp(category))
      if (category === 'provider-error') assert.equal(f.calls(), 3)
    })
  }
}

test('notification or logging failure cannot become an automatic allow', async () => {
  for (const broken of ['notify', 'log']) {
    const f = fixture({ config: { denialAction: 'ask' }, runtime: broken === 'notify' ? {
      notifyHuman: () => { throw new Error('UI unavailable') },
    } : {} })
    if (broken === 'log') f.log.review = () => { throw new Error('log unavailable') }
    assert.equal((await chain(f, new DenyingAuthorizer()).authorize(details())).approved, false)
    if (broken === 'notify') {
      for (let i = 0; i < 4; i++) await chain(f, new DenyingAuthorizer()).authorize(details())
      assert.equal(f.calls(), 3, 'an unavailable notification UI must not reset the denial breaker')
    }
  }
})

for (const surface of ['path', 'external_directory', undefined]) {
  test(`installed delegation envelope caps an allow on ${surface ?? 'unknown'} surface`, async () => {
    const f = fixture({ response: () => '{"outcome":"allow"}' })
    const request = details()
    request.surface = surface
    assert.equal((await chain(f, new DenyingAuthorizer()).authorize(request)).approved, false)
    assert.equal(f.calls(), 1)
  })
}

test('authoritative access intent prevents a forged display surface from widening delegation', async () => {
  const f = fixture({ response: () => '{"outcome":"allow"}' })
  const request = { ...details(), accessIntent: { surface: 'path' } }
  assert.equal((await chain(f, new DenyingAuthorizer()).authorize(request)).approved, false)
})

for (const mode of ['deny', 'ask']) {
  test(`no UI never auto-allows, even when model would allow (${mode})`, async () => {
    for (const isInteractive of [() => false, undefined]) {
      const f = fixture({ config: { denialAction: mode }, response: () => '{"outcome":"allow"}', runtime: { isInteractive } })
      const result = await chain(f, new DenyingAuthorizer()).authorize(details())
      assert.equal(result.approved, false)
      assert.equal(result.confirmationUnavailable, true)
      assert.equal(f.calls(), 0)
    }
  })
}

test('cancellation while the model is running defers without automatic approval', async () => {
  const controller = new AbortController()
  const f = fixture({ config: { denialAction: 'ask' }, runtime: { sessionSignal: controller.signal },
    response: () => { controller.abort(); return '{"outcome":"allow"}' },
  })
  assert.equal((await chain(f, new DenyingAuthorizer()).authorize(details())).approved, false)
})

test('permission-system 26 structured payload reaches the model unchanged as untrusted evidence', async () => {
  const f = fixture({ response: () => '{"outcome":"allow"}' })
  const request = details()
  request.payload.evidence.push({ label: 'edit', text: 'SYNTHETIC_SECURITY_POLICY_REPLACEMENT', detail: null })
  await f.authorize(request, {}, f.log)
  assert.match(f.prompts[0].messages[0].content, /SYNTHETIC_SECURITY_POLICY_REPLACEMENT/)
  assert.match(f.prompts[0].systemPrompt, /explicit user prohibition remains effective/)
  assert.match(f.prompts[0].systemPrompt, /Allow low and medium risk actions regardless of authorization/)
  assert.match(f.prompts[0].systemPrompt, /Deny broad or persistent weakening/)
})

test('global/project config merging and generated schema retain the opt-in', async () => {
  const { readFileSync } = await import('node:fs')
  const { loadAutoReviewConfig, buildAutoReviewJsonSchema } = await local('src/config.ts')
  const result = loadAutoReviewConfig({ cwd: '/synthetic/project', agentDir: '/synthetic/agent', readFile: path =>
    JSON.stringify({ denialAction: path.includes('/project/') ? 'ask' : 'deny' }),
  })
  assert.equal(result.config.denialAction, 'ask')
  assert.deepEqual(buildAutoReviewJsonSchema().properties.denialAction.enum, ['deny', 'ask'])
  assert.deepEqual(JSON.parse(readFileSync(new URL('../../schemas/config.schema.json', import.meta.url))), buildAutoReviewJsonSchema())
})

test('opted-in model denial reaches human approval with its reason', async () => {
  const f = fixture({ config: { denialAction: 'ask' } })
  let humanCalls = 0
  const result = await chain(f, { authorize: async request => {
    humanCalls++
    assert.equal(request.payload.request.value, details().payload.request.value)
    assert.match(f.notifications[0], /Task-specific authorization/)
    assert.match(f.notifications[0], /risk: medium/)
    return { approved: true, state: 'approved' }
  } }).authorize(details())
  assert.equal(humanCalls, 1)
  assert.equal(result.approved, true)
})
