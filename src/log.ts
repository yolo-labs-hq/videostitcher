/* Minimal console helpers — no color deps, just clear prefixes. */
export const info = (msg: string) => console.log(msg);
export const step = (msg: string) => console.log(`\n▸ ${msg}`);
export const ok = (msg: string) => console.log(`✓ ${msg}`);
export const warn = (msg: string) => console.warn(`! ${msg}`);
export const fail = (msg: string) => console.error(`✗ ${msg}`);

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
