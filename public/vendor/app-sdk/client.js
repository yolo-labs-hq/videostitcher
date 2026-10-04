import { isBridgeReply, isEnvProfileApplied, isZenStateChanged, BRIDGE_PROTOCOL_VERSION } from './envelope.js';
import { isDockAction, isDockPreviewRequest } from './envelope.js';
// ── Call timeout defaults ───────────────────────────────────────────────────
//
// 🚨 CROSS-PACKAGE LOCKSTEP. The client must not give up before the SERVER does.
// A tile-app `llm.invoke` runs on the platform's clock: the broker forwards to
// the router and, when the completion comes back, SETTLES CREDITS against the
// served model. If this SDK abandons the call first, the app never sees the
// completion but the account is still debited for work the platform genuinely
// performed and paid for upstream.
//
// So the default here is deliberately LARGER than the server's ceiling. The two
// values live in different codebases (this package is published standalone and
// cannot import from the server), so the ordering is pinned by a server-side test
// that reads BOTH sources: `llm-gateway.timeout-lockstep.test.ts`.
/**
 * MIRROR of the platform's per-forward ceiling —
 * `DEFAULT_TILEAPP_LLM_TIMEOUT_MS` in the server's `credits.ts`, the
 * default for the `TILEAPP_LLM_TIMEOUT_MS` env var that the server's
 * `llm-gateway.ts` aborts on.
 *
 * Changing that constant without changing this one reopens the window where the
 * platform charges for a completion the app threw away. The lockstep test fails
 * on exactly that.
 */
const GATEWAY_LLM_TIMEOUT_MS = 60_000;
/**
 * Headroom over the server's ceiling: the host bridge hop, the broker's own
 * pre/post-forward work (reserve, settle) and message-port latency all sit
 * outside the gateway's abort timer. With this margin the server always gives up
 * first, so a timeout the app observes is a call that was never billed as
 * delivered.
 */
const CALL_TIMEOUT_MARGIN_MS = 15_000;
/** Default per-call timeout: 75s (60s gateway ceiling + 15s margin). */
const DEFAULT_CALL_TIMEOUT_MS = GATEWAY_LLM_TIMEOUT_MS + CALL_TIMEOUT_MARGIN_MS;
/** Error thrown by `requestPermissions` on a non-accept outcome. `reason` is the
 *  host's machine code (`'user-declined' | 'invalid-args' | 'timeout' | …`). */
export class PermissionRequestError extends Error {
    reason;
    constructor(message, reason) {
        super(message);
        this.name = 'PermissionRequestError';
        this.reason = reason;
    }
}
// The host holds ONE pending permission request per tile (iframe), so the
// single-flight lock must be shared across ALL clients in this iframe — a
// per-client flag wouldn't stop two clients from both prompting and orphaning
// the first. One module instance == one iframe, so module scope is iframe scope.
let modulePermissionInFlight = false;
export function createTileApp(options = {}) {
    const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const permissionTimeoutMs = options.permissionTimeoutMs ?? 600_000;
    // The pinned host origin: explicit option → the parent's origin via
    // ancestorOrigins (Chromium/WebKit; authoritative + navigation-independent) →
    // document.referrer (fallback; only correct on the FIRST page load — after an
    // in-iframe navigation the referrer is the app's own prior page, not the host,
    // so originFromReferrer ignores same-app referrers). null ⇒ still unknown, in
    // which case we can RECEIVE (adopting the first parent-sourced message's
    // origin) but can't safely send until the host is identified.
    let hostOrigin = options.hostOrigin ?? originFromAncestor() ?? originFromReferrer();
    const pending = new Map();
    const eventHandlers = new Map();
    const zenStateHandlers = new Set();
    const dockActionHandlers = new Set();
    let dockPreview = null;
    let titleBarStatus = null;
    let destroyed = false;
    function settle(id, fn) {
        const p = pending.get(id);
        if (!p)
            return;
        clearTimeout(p.timer);
        pending.delete(id);
        fn(p);
    }
    function onMessage(e) {
        if (destroyed)
            return;
        // The host is our PARENT window and nothing else. Drop anything from a
        // nested/sibling frame even if it's tileapp-shaped — otherwise such a frame
        // could poison the trust-on-first-use origin pin (when there's no referrer)
        // or get processed once it learns the pinned origin. Mirrors the host-side
        // `e.source === iframe.contentWindow` check.
        if (typeof window !== 'undefined' && e.source !== window.parent)
            return;
        const data = e.data;
        const isOurs = isBridgeReply(data) || isEnvProfileApplied(data) || isZenStateChanged(data) || isDockAction(data) || isDockPreviewRequest(data);
        if (!isOurs)
            return;
        // Origin pinning — the load-bearing check. If we already know the host
        // origin, drop anything from elsewhere; otherwise adopt this (parent-sourced,
        // tile-app-shaped) sender as the host.
        if (hostOrigin === null) {
            hostOrigin = e.origin;
        }
        else if (e.origin !== hostOrigin) {
            return;
        }
        if (isDockPreviewRequest(data)) {
            post({ __tileapp: true, kind: 'title-bar-status', id: newId(), text: titleBarStatus });
            post({ __tileapp: true, kind: 'dock-preview', id: newId(), preview: dockPreview });
        }
        else if (isDockAction(data)) {
            for (const handler of dockActionHandlers) {
                try {
                    handler(data.actionId);
                }
                catch { /* isolate handlers */ }
            }
        }
        else if (isBridgeReply(data)) {
            settle(data.id, (p) => p.resolve(data));
        }
        else if (isEnvProfileApplied(data)) {
            const hs = eventHandlers.get('env-profile-applied');
            if (hs)
                for (const h of hs) {
                    try {
                        h(data);
                    }
                    catch { /* a handler throwing must not break the bus */ }
                }
        }
        else if (isZenStateChanged(data)) {
            for (const handler of zenStateHandlers) {
                try {
                    handler(data.active);
                }
                catch { /* isolate app handlers */ }
            }
        }
    }
    window.addEventListener('message', onMessage);
    function post(env) {
        const parent = typeof window !== 'undefined' ? window.parent : undefined;
        if (!parent || parent === window) {
            throw new Error('@yolo-labs/app-sdk: no host window — not running inside a YOLO tile');
        }
        if (hostOrigin === null) {
            throw new Error('@yolo-labs/app-sdk: host origin unknown — cannot target a message safely (no document.referrer and no host message yet; pass { hostOrigin })');
        }
        // Pinned origin, never '*'.
        parent.postMessage(env, hostOrigin);
    }
    function send(env, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (destroyed) {
                reject(new Error('@yolo-labs/app-sdk: client destroyed'));
                return;
            }
            const timer = setTimeout(() => {
                settle(env.id, (p) => p.reject(new TimeoutError(env.kind, timeoutMs)));
            }, timeoutMs);
            pending.set(env.id, { resolve, reject, timer });
            try {
                post(env);
            }
            catch (err) {
                settle(env.id, (p) => p.reject(err instanceof Error ? err : new Error(String(err))));
            }
        });
    }
    // Context is immutable for the life of the iframe (workspace/tile/app identity
    // never changes without a remount; theme is host-static today), so one
    // successful reply is cached for the client's lifetime.
    let cachedContext = null;
    // One implementation, shared by `call` and the typed `llm*` helpers below —
    // those are the SAME broker call with a payload type attached, so they must
    // not be a second code path that can drift from it.
    async function callCapability(capability, method, args, opts) {
        const reply = await send({ __tileapp: true, kind: 'bridge-call', id: newId(), capability, method, args, protocolVersion: BRIDGE_PROTOCOL_VERSION }, opts?.timeoutMs ?? defaultTimeoutMs);
        // Normalize: a non-`true` ok (incl. a pre-broker error reply with no `ok`,
        // only `error`) is a failure. Surface the host's error text as `message`.
        return {
            ok: reply.ok === true,
            payload: reply.payload,
            reason: reply.reason,
            message: reply.message ?? (typeof reply.error === 'string' ? reply.error : undefined),
        };
    }
    async function requestZen(action, opts) {
        const reply = await send({ __tileapp: true, kind: 'zen-request', id: newId(), action, protocolVersion: BRIDGE_PROTOCOL_VERSION }, opts?.timeoutMs ?? defaultTimeoutMs);
        return { ok: reply.ok === true, payload: reply.payload, reason: reply.reason, message: reply.message };
    }
    return {
        zen: {
            enter: (opts) => requestZen('enter', opts),
            exit: (opts) => requestZen('exit', opts),
            status: (opts) => requestZen('status', opts),
            onChange: (handler) => { zenStateHandlers.add(handler); return () => zenStateHandlers.delete(handler); },
        },
        titleBar: {
            setStatus: async (text, opts) => {
                titleBarStatus = text;
                const reply = await send({ __tileapp: true, kind: 'title-bar-status', id: newId(), text }, opts?.timeoutMs ?? defaultTimeoutMs);
                return { ok: reply.ok === true, reason: reply.reason, message: reply.message };
            },
        },
        dock: {
            pulse: async (opts) => {
                const reply = await send({ __tileapp: true, kind: 'dock-pulse', id: newId() }, opts?.timeoutMs ?? defaultTimeoutMs);
                return { ok: reply.ok === true, payload: reply.payload, reason: reply.reason, message: reply.message };
            },
            setPreview: async (preview, opts) => {
                dockPreview = preview;
                const reply = await send({ __tileapp: true, kind: 'dock-preview', id: newId(), preview }, opts?.timeoutMs ?? defaultTimeoutMs);
                return { ok: reply.ok === true, reason: reply.reason, message: reply.message };
            },
            onAction: handler => { dockActionHandlers.add(handler); return () => { dockActionHandlers.delete(handler); }; },
        },
        call: callCapability,
        async llmInvoke(args, opts) {
            return (await callCapability('llm', 'invoke', args, opts));
        },
        async llmDiscover(args, opts) {
            return (await callCapability('llm', 'discover', args ?? {}, opts));
        },
        async sendNotification(args, opts) {
            return (await callCapability('notifications', 'send', args, opts));
        },
        async getContext(opts) {
            if (cachedContext)
                return cachedContext;
            const reply = await send({ __tileapp: true, kind: 'context-request', id: newId(), protocolVersion: BRIDGE_PROTOCOL_VERSION }, opts?.timeoutMs ?? defaultTimeoutMs);
            if (reply.ok !== true) {
                throw new Error(`@yolo-labs/app-sdk: context request failed: ${reply.message ?? reply.reason ?? reply.error ?? 'unknown'}`);
            }
            const p = (reply.payload ?? {});
            cachedContext = {
                workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : '',
                tileId: typeof p.tileId === 'string' ? p.tileId : '',
                appId: typeof p.appId === 'string' ? p.appId : null,
                theme: typeof p.theme === 'string' ? p.theme : 'dark',
            };
            return cachedContext;
        },
        async requestPermissions(permissions) {
            if (modulePermissionInFlight) {
                throw new PermissionRequestError('a permission request is already pending — await it before starting another', 'busy');
            }
            modulePermissionInFlight = true;
            let reply;
            try {
                reply = await send({ __tileapp: true, kind: 'request-permissions', id: newId(), permissions, protocolVersion: BRIDGE_PROTOCOL_VERSION }, permissionTimeoutMs);
            }
            catch (err) {
                if (err instanceof TimeoutError)
                    throw new PermissionRequestError(err.message, 'timeout');
                throw err;
            }
            finally {
                modulePermissionInFlight = false;
            }
            if (reply.ok !== true) {
                throw new PermissionRequestError(reply.message || reply.reason || reply.error || 'permission request denied', reply.reason);
            }
            const payload = (reply.payload ?? {});
            return {
                grantedPermissions: Array.isArray(payload.grantedPermissions) ? payload.grantedPermissions : [],
                newlyGranted: Array.isArray(payload.newlyGranted) ? payload.newlyGranted : [],
            };
        },
        on(kind, handler) {
            let set = eventHandlers.get(kind);
            if (!set) {
                set = new Set();
                eventHandlers.set(kind, set);
            }
            set.add(handler);
            return () => { eventHandlers.get(kind)?.delete(handler); };
        },
        destroy() {
            if (destroyed)
                return;
            destroyed = true;
            window.removeEventListener('message', onMessage);
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error('@yolo-labs/app-sdk: client destroyed'));
            }
            pending.clear();
            eventHandlers.clear();
            zenStateHandlers.clear();
            dockActionHandlers.clear();
        },
    };
}
class TimeoutError extends Error {
    constructor(kind, timeoutMs) {
        super(`@yolo-labs/app-sdk: ${kind} timed out after ${timeoutMs}ms`);
        this.name = 'TimeoutError';
    }
}
function originFromReferrer() {
    try {
        if (typeof document === 'undefined' || !document.referrer)
            return null;
        const origin = new URL(document.referrer).origin;
        // After an in-iframe navigation the referrer is the app's OWN prior page,
        // not the host — never pin our own origin as the host.
        if (typeof window !== 'undefined' && origin === window.location.origin)
            return null;
        return origin;
    }
    catch {
        return null;
    }
}
function originFromAncestor() {
    try {
        // ancestorOrigins is a Chromium/WebKit API (absent in Firefox); [0] is the
        // immediate parent frame's origin — a referrer-independent host-origin
        // source. The tile-app runs in Chromium, so this is normally available.
        const ao = typeof window !== 'undefined' ? window.location.ancestorOrigins : undefined;
        const first = ao && ao.length > 0 ? ao[0] : null;
        return first && first !== 'null' ? first : null;
    }
    catch {
        return null;
    }
}
function newId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    }
    catch {
        /* fall through */
    }
    return 'tac-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
