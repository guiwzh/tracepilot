export function explode(reason) {
  const detail = { reason, at: Date.now() };
  throw new Error(`exploded: ${detail.reason}`);
}

export async function loadLazy() {
  const lazy = await import('./lazy.js');
  return lazy.answer();
}
