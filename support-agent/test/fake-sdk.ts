export interface AgentRequest {
  text?: string
  contextId?: string
  requestId?: string
  sender?: { did?: string; address?: string }
}

export class P2AAgent {
  onRequest(_handler: unknown): void {}
  onConnectionRequest(_handler: unknown): void {}
  async resolve(_target: string): Promise<Record<string, unknown>> {
    return {}
  }
  async listen(): Promise<void> {}
  async send(): Promise<Record<string, unknown>> {
    return {}
  }
  async respondConnection(): Promise<Record<string, unknown>> {
    return {}
  }
}
