/** Strips Electron's "Error invoking remote method '...': Error:" wrapper. */
export const cleanError = (e: unknown): string =>
  String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
