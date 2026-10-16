export type WaiverLogEntry = { at: number; files: string[]; reason: string }

declare module 'claude-code' {
  interface PluginState {
    'rules-enforcer': {
      loadedSkills: string[]
      turnEdits: string[]
      waived: string[]
      paused: boolean
      stopBlocks: number
      /** `<agentId>|<abs>`: files each subagent changed since its last Stop went through. */
      agentEdits: string[]
      /** Subagents reminded at their Stop and not yet stopped. */
      subagentReminded: string[]
      /** Rules files whose Bash change scan stopped at its cap and that Claude has been told about. */
      scanNoted: string[]
    }
  }
}
