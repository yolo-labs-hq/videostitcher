/**
 * The postMessage wire contract between a YOLO App's iframe code and the host.
 *
 * This is the single source of truth for the envelope shapes the SDK sends and
 * receives. It mirrors the host's guards (`TileApp.tsx` /
 * `use-tile-app-bridge.ts` in the web app: `isBridgeCall`,
 * `isPermissionRequest`, the `bridge-reply` / `env-profile-applied` shapes).
 * Every message carries `__tileapp: true` as a coarse discriminator.
 *
 * Versioning stance (decided in the SDK design): the host owns
 * this contract and stays **additive-only FOREVER** — new optional fields / new
 * `kind`s only; existing fields are never removed, renamed, or repurposed. That
 * is the actual compatibility mechanism: a third-party app pins an SDK version
 * and runs against whatever host is deployed, so the host must keep accepting
 * what any old SDK sends and replying in the shape it expects. There is NO
 * negotiation handshake. `protocolVersion` (below) is stamped on outbound
 * messages purely as telemetry + a future escape hatch (if we are ever forced
 * to make a breaking change we can version-gate it, never the common path); the
 * host ignores it today. The protocol version is DECOUPLED from the SDK's npm
 * semver — it moves only on a breaking wire change (which we commit to avoiding).
 */
/** Stamped on outbound envelopes. Bumped ONLY on a breaking wire change (we keep
 *  the host additive-only, so in practice this stays 1). Not the SDK's npm
 *  version — see the versioning stance above. */
export const BRIDGE_PROTOCOL_VERSION = 1;
export function isDockAction(v) {
    if (!v || typeof v !== 'object')
        return false;
    const m = v;
    return m.__tileapp === true && m.kind === 'dock-action' && typeof m.actionId === 'string';
}
export function isDockPreviewRequest(v) {
    if (!v || typeof v !== 'object')
        return false;
    const m = v;
    return m.__tileapp === true && m.kind === 'dock-preview-request';
}
// ── guards (used on RECEIVED messages, which are attacker-influenceable) ─────
function isTileAppMessage(v) {
    return typeof v === 'object' && v !== null
        && v.__tileapp === true
        && typeof v.kind === 'string';
}
export function isBridgeReply(v) {
    if (!isTileAppMessage(v))
        return false;
    const m = v;
    // A correlated reply only needs the kind + id; `ok` may be absent on a
    // pre-broker host error (the client normalizes that to a failure result).
    return m.kind === 'bridge-reply' && typeof m.id === 'string';
}
export function isEnvProfileApplied(v) {
    if (!isTileAppMessage(v))
        return false;
    return v.kind === 'env-profile-applied';
}
export function isZenStateChanged(v) {
    if (!isTileAppMessage(v))
        return false;
    const m = v;
    return m.kind === 'zen-state-changed' && typeof m.active === 'boolean';
}
