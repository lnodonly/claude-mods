// The contract dependents get (self-contained: no imports).
export type ModbarWidth = 'full' | 'half' | 'third' | 'fit' | 'fill'
export type ModbarAlign = 'left' | 'right'
export type ModbarText = { text: string; color?: string; bold?: boolean; dim?: boolean }
export type ModbarButton = { button: { key: string; label: string; primary?: boolean } }
export type ModbarBar = { bar: { value: number; color?: string; dim?: boolean; empty?: boolean }[] }
export type ModbarPiece = ModbarText | ModbarButton | ModbarBar
export type ModbarLine = { pieces: ModbarPiece[]; align?: ModbarAlign }
// off: not drawn until the user runs /modbar show <id>; /modbar lists it under what can be added.
// about: a few words on what the block shows, for that list.
export type ModbarBlock = { id: string; owner: string; order: number; width: ModbarWidth; align?: ModbarAlign; off?: boolean; about?: string; lines: ModbarLine[] }
export type ModbarBlocksArgs = { columns: number }
export type ModbarPressArgs = { owner: string; key: string }
// Each dependent adds this noun itself in engine.create, beneath what's there, with the same core
// as modbar's (blocks: [], press: false), so it loads without modbar: see the README.
export type Modbar = {
  blocks: (args: ModbarBlocksArgs) => Promise<ModbarBlock[]>
  press: (args: ModbarPressArgs) => Promise<boolean>
}
export type ModbarSettings = { width?: ModbarWidth; align?: ModbarAlign; hidden?: boolean }
export type ModbarConfig = { order: string[]; blocks: Record<string, ModbarSettings> }

declare module 'claude-code' {
  interface EngineInterface {
    modbar: Modbar
  }
  interface PluginState {
    modbar: {
      config: ModbarConfig
      problem: string | null
      theme: string | null
    }
  }
}
