// The server-corrected clock (no native imports, so it can be used and tested anywhere). time.ts keeps it in sync.
let offset = 0;
let synced = false;
export const serverNow = () => Date.now() + offset;
export const clockOffsetMs = () => offset;
export const isClockSynced = () => synced;
export const isDeviceClockOff = (limitMs = 2 * 60 * 1000) => synced && Math.abs(offset) > limitMs;
export function setClock(newOffsetMs: number) { offset = newOffsetMs; synced = true; }
