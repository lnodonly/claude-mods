export type Note = { kind: 'full' | 'auto'; written: string; steps: string[]; text: string }

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      note: Note | null
      worked: boolean
      writing: boolean
    }
  }
}
