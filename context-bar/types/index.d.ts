export type Segment = { name: string; tokens: number; color: string; kind: 'used' | 'free' | 'buffer' }
export type Snapshot = { segments: Segment[]; total: number; max: number; percent: number }

declare module 'claude-code' {
  interface PluginState {
    'context-bar': { snapshot: Snapshot | null }
  }
}
