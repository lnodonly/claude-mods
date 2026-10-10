export type Item = { label: string; tokens: number }
export type Summary = { items: Item[]; saved: number }

declare module 'claude-code' {
  interface PluginState {
    'context-diet': { summary: Summary }
  }
}
