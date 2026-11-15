// Lightweight decoupled trigger so any component (e.g. the sidebar search button)
// can open the global command palette without prop-drilling or shared context.

export const OPEN_COMMAND_PALETTE = 'open-command-palette'

export function openCommandPalette() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))
  }
}
