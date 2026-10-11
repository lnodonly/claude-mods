export type Note = { kind: 'full' | 'auto'; written: string; steps: string[]; text: string }

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      note: Note | null
      worked: boolean
      writing: boolean
      // The folder the session started in, kept across hot reloads; '' until kept.
      folder: string
    }
  }
}
