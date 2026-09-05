// No installs or live Pi configuration: use explicitly supplied, already installed packages.
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const piRoot = process.env.AUTO_REVIEW_TEST_PI_ROOT
export const packagesRoot = process.env.AUTO_REVIEW_TEST_PACKAGES_ROOT
if (!piRoot || !packagesRoot) {
  throw new Error('Set AUTO_REVIEW_TEST_PI_ROOT and AUTO_REVIEW_TEST_PACKAGES_ROOT to existing installations')
}
const piRequire = createRequire(resolve(piRoot, 'package.json'))
const { createJiti } = piRequire('jiti')
export const permissionRoot = resolve(packagesRoot, '@gotgenes/pi-permission-system')
export const jiti = createJiti(import.meta.url, {
  fsCache: false,
  moduleCache: false,
  alias: {
    '@earendil-works/pi-coding-agent': resolve(piRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': resolve(piRoot, 'node_modules/@earendil-works/pi-ai/dist/compat.js'),
    '@earendil-works/pi-tui': resolve(piRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    '@gotgenes/pi-permission-system': resolve(permissionRoot, 'src/service.ts'),
    '@mzwing/pi-polyfill': resolve(packagesRoot, '@mzwing/pi-polyfill/dist/index.js'),
    zod: resolve(packagesRoot, 'zod/index.js'),
  },
})
export const local = path => jiti.import(resolve(packageRoot, path))
export const permission = path => jiti.import(resolve(permissionRoot, 'src', path))

export const { autoReviewConfigSchema } = await local('src/config.ts')
export const { createPermissionReviewer } = await local('src/reviewer.ts')
export const { DenialCircuitBreaker } = await local('src/circuit-breaker.ts')
export const { composeAuthorizerChain } = await permission('authority/authorizer-chain.ts')
export const { encloseInDelegationEnvelope } = await permission('authority/delegation-envelope.ts')
export const { DenyingAuthorizer } = await permission('authority/denying-authorizer.ts')

export function details(surface = 'bash') {
  const value = 'update backlog/approval-record.md'
  return {
    requestId: 'synthetic-request-1', source: 'tool_call', agentName: null,
    toolName: 'bash', command: value, surface, value,
    payload: {
      kind: 'bash',
      request: {
        requester: { agentName: null, forwarded: false, sessionId: null },
        surface, toolName: 'bash', invokedToolName: null, value,
        matchedPattern: '*', commandContext: null, executedUnit: null,
      },
      evidence: [{ label: 'command', text: value, detail: null }], annotations: [],
    },
  }
}

export function fixture(options = {}) {
  const notifications = [], logs = [], prompts = []
  let calls = 0
  const model = {
    id: 'synthetic-reviewer', name: 'Synthetic reviewer', provider: 'synthetic',
    api: 'openai-responses', reasoning: true, input: ['text'],
    baseUrl: 'https://synthetic.invalid', contextWindow: 128000, maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
  const provider = {
    getModels: () => [model],
    streamSimple: (_model, prompt) => {
      calls++; prompts.push(prompt)
      return { result: async () => {
        const text = await (options.response?.() ?? JSON.stringify({
          outcome: 'deny', risk_level: 'medium', user_authorization: 'low',
          rationale: 'Task-specific authorization for the approval record is unclear.',
        }))
        return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' }
      } }
    },
  }
  const runtime = {
    config: { ...autoReviewConfigSchema.parse({}), provider: 'synthetic', model: model.id, ...options.config },
    registry: {
      find: () => model, getAll: () => [model], getProvider: () => provider,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'SYNTHETIC_SECRET_DO_NOT_USE' }),
      ...options.registry,
    },
    sessionManager: { getBranch: () => [] },
    circuitBreaker: new DenialCircuitBreaker(),
    isInteractive: () => true,
    notifyHuman: text => notifications.push(text),
    ...options.runtime,
  }
  const log = { review: (event, data) => logs.push({ event, ...data }), debug: () => {} }
  const authorize = createPermissionReviewer(runtime, { sleep: async () => {}, ...options.dependencies })
  return { runtime, authorize, notifications, logs, prompts, calls: () => calls, log }
}

export function chain(f, terminal) {
  return composeAuthorizerChain([
    { name: 'auto-review', authorize: encloseInDelegationEnvelope(f.authorize) },
  ], terminal, {}, f.log)
}
