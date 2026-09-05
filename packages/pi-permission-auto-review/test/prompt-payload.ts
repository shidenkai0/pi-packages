import type { PromptPayload } from '@gotgenes/pi-permission-system'

export function promptPayload(): PromptPayload {
  return {
    kind: 'bash',
    request: {
      requester: { agentName: null, forwarded: false, sessionId: null },
      surface: 'bash', toolName: 'bash', invokedToolName: null,
      value: 'pnpm publish', matchedPattern: null, commandContext: null, executedUnit: null,
    },
    evidence: [],
    annotations: [],
  }
}
