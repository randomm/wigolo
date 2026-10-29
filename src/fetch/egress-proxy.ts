// halo: egress-proxy-ssrf (fork-only patch; Upstream-Status: not-submitted)
/**
 * Delegate RESOLVED-IP SSRF enforcement to an operator-run egress proxy.
 *
 * Upstream (#207) resolves every hostname hop, validates the answer and pins the socket to it,
 * failing closed when the name does not resolve locally. Behind a resolving forward proxy (halo:
 * squid on an internal-only network) the container cannot resolve public names at all, so every
 * fetch fails closed. With `WIGOLO_EGRESS_PROXY_ENFORCES_SSRF=1` the fetch tiers send every hop —
 * IP literals included — through an EXPLICIT proxy dispatcher instead, and the proxy, which resolves
 * the name once and connects to what it resolved, is the resolved-IP enforcer.
 *
 * CONTRACT: only enable this in front of a proxy that denies private / loopback / link-local /
 * metadata destinations on the addresses IT resolves (halo: squid-wigolo.conf `private_dst` +
 * `deny !dst_resolved`). In front of a permissive proxy it gives up resolved-IP SSRF protection.
 * The literal-URL guard, the per-hop redirect re-guard and the local resolved-IP guard (for names
 * that DO resolve locally) keep running. Localhost / LAN / WIGOLO_FETCH_ALLOW_PRIVATE fetching is
 * impossible in this mode, because the proxy denies it.
 *
 * Coverage: every fetch tier (HTTP, TLS, PDF probe, browser pool, daemon browser) uses the one proxy.
 * Browsers go through it for HTTP(S) / WebSocket; WebRTC is held off it at launch (headless bundled
 * Chromium sends no non-proxied UDP, Firefox has RTCPeerConnection disabled, WebKit is refused),
 * because Playwright's proxy option does not cover STUN / TURN UDP and page JS could aim it at
 * loopback or wigolo-net. The Chromium switch only binds chromium-headless-shell (Playwright's
 * headless bundled launch); full Chrome / Chromium ignores it, so an installed-Chrome channel or a
 * headful browser makes delegation misconfigured.
 *
 * The knob is read from `process.env` ONLY — never config.json / `wigolo config set` / the TUI —
 * so no settings write and no agent-reachable tool can turn it on.
 */
import { Client, Pool, ProxyAgent, type Dispatcher } from 'undici';
import { getConfig, type Config } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { redactUrl } from '../util/redact-url.js';
import { playwrightProxyOption } from './proxy-credentials.js';

export const EGRESS_DELEGATION_ENV = 'WIGOLO_EGRESS_PROXY_ENFORCES_SSRF';

export type EgressMode =
  // Upstream behaviour, byte-for-byte: resolve + pin + fail closed.
  | { kind: 'strict' }
  // `display` is the redacted proxy URL (no userinfo); `proxyUrl` carries credentials and is never logged.
  | { kind: 'delegated'; proxyUrl: string; display: string }
  // Requested but unusable. Every patched tier refuses to fetch; `reason` never contains the URL.
  | { kind: 'misconfigured'; reason: string };

type Env = Record<string, string | undefined>;

/**
 * Whether delegation was REQUESTED (any value other than unset / '' / '0'), valid or not. Gates
 * the direct-egress paths, which must stay shut even when the configuration is broken.
 */
export function egressDelegationRequested(env: Env = process.env): boolean {
  const v = env[EGRESS_DELEGATION_ENV];
  return v !== undefined && v !== '' && v !== '0';
}

/** Pure decision. Reasons are structural: they never echo the proxy URL or its credentials. */
function resolveEgressMode(cfg: Config, env: Env): EgressMode {
  if (!egressDelegationRequested(env)) return { kind: 'strict' };
  const bad = (reason: string): EgressMode => ({ kind: 'misconfigured', reason });
  if (env[EGRESS_DELEGATION_ENV] !== '1') return bad(`${EGRESS_DELEGATION_ENV} must be exactly "1"`);
  if (!cfg.useProxy) return bad('USE_PROXY is not true');
  if (!cfg.proxyUrl) return bad('PROXY_URL is not set');
  let u: URL;
  try {
    u = new URL(cfg.proxyUrl);
  } catch {
    return bad('PROXY_URL is unparseable');
  }
  // undici only sends http:// targets in absolute form through an http: proxy; an https: proxy
  // would CONNECT to :80 (squid denies it) and socks5 may resolve the target on the client.
  if (u.protocol !== 'http:') return bad('PROXY_URL scheme must be http:');
  if (!u.hostname || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) {
    return bad('PROXY_URL must be http://[user:pass@]host:port');
  }
  // The browser tiers use this same option; delegation needs every tier on the one proxy.
  if (!playwrightProxyOption(cfg.proxyUrl, cfg.useProxy)) return bad('browser proxy option unavailable');
  if (cfg.proxyBypassOnChallenge) {
    return bad('WIGOLO_PROXY_BYPASS_ON_CHALLENGE is on (direct-egress path)');
  }
  // The stealth launch would run full Chrome / Chromium, which ignores the WebRTC launch switch
  // (see egressBrowserLaunchHardening) and sends STUN / TURN UDP past the proxy.
  if (cfg.browserChannel !== 'chromium') {
    return bad('WIGOLO_BROWSER_CHANNEL is not "chromium" (full Chrome ignores the WebRTC launch policy)');
  }
  if (cfg.browserHeadful) return bad('WIGOLO_BROWSER_HEADFUL is on (headful Chromium ignores the WebRTC launch policy)');
  return { kind: 'delegated', proxyUrl: cfg.proxyUrl, display: redactUrl(cfg.proxyUrl) };
}

/**
 * The egress mode for this call. Synchronous and side-effect free apart from announcing the mode
 * once per process (see {@link announceEgressMode}), so stdio MCP mode logs it on first use.
 */
export function egressMode(cfg: Config = getConfig(), env: Env = process.env): EgressMode {
  const m = resolveEgressMode(cfg, env);
  if (!announced && m.kind !== 'strict') announce(m, cfg, env, createLogger('fetch'));
  return m;
}

export function egressMisconfiguredMessage(m: { reason: string }): string {
  return `egress proxy delegation requested (${EGRESS_DELEGATION_ENV}=1) but ${m.reason}; refusing to fetch`;
}

// One shared dispatcher, used by every request. It is NEVER destroyed per request: a per-request
// teardown would abort other requests' in-flight sockets. It is only retired (see below).
interface SharedAgent { readonly key: string; readonly agent: ProxyAgent; readonly httpOrigins: number }
let shared: SharedAgent | null = null;

// undici keeps one Http1ProxyWrapper per distinct http:// origin in the agent's origin map and never
// drops it (the wrapper emits no 'disconnect'), so a long-running daemon would grow without bound.
// The wrappers share ONE Pool to the proxy (no Pool per origin), and the agent is retired once it
// has seen this many http origins.
const DEFAULT_MAX_HTTP_ORIGINS = 512;
let maxHttpOrigins = DEFAULT_MAX_HTTP_ORIGINS;
// A retired agent is closed only after this grace period, so a hop that fetched it just before the
// swap still dispatches on an open agent; close() then lets running requests finish.
const RETIRE_GRACE_MS = 30_000;

// Pending retirements, kept so the test reset can close them now instead of leaving timers behind.
const retiring = new Map<ProxyAgent, ReturnType<typeof setTimeout>>();

function retire(agent: ProxyAgent): void {
  const timer = setTimeout(() => {
    retiring.delete(agent);
    agent.close().catch(() => {});
  }, RETIRE_GRACE_MS);
  timer.unref();
  retiring.set(agent, timer);
}

function buildShared(proxyUrl: string): SharedAgent {
  const proxyHref = new URL(proxyUrl).href;
  let proxyPool: Pool | null = null;
  let httpOrigins = 0;
  const agent = new ProxyAgent({
    uri: proxyUrl,
    proxyTunnel: false,
    // Called for each new http-origin wrapper's client to the proxy (origin === the proxy href) and
    // for each https origin's tunnel pool (undici's default for those, which DOES clean up).
    factory: (origin: string | URL, opts: object): Dispatcher => {
      const o = opts as Pool.Options & { connections?: number | null };
      if (String(origin) === proxyHref) {
        httpOrigins++;
        return (proxyPool ??= new Pool(origin, o));
      }
      return o.connections === 1 ? new Client(origin, o) : new Pool(origin, o);
    },
  });
  return {
    key: proxyUrl,
    agent,
    get httpOrigins() {
      return httpOrigins;
    },
  };
}

/**
 * The explicit proxy dispatcher. Explicit (not env / EnvHttpProxyAgent) so NO_PROXY can never send
 * a hop — loopback literals included — around the proxy. Callers fetch it per HOP, not per request,
 * because the agent behind it may be swapped between hops.
 *
 * `proxyTunnel: false` is REQUIRED: the default (true) sends http:// targets as `CONNECT host:80`,
 * which squid denies (`deny CONNECT !SSL_ports`). With false and an http: proxy, http:// targets go
 * absolute-form (`GET http://host/path`) and https:// targets still CONNECT :443.
 */
export function egressProxyDispatcher(m: Extract<EgressMode, { kind: 'delegated' }>): Dispatcher {
  if (!shared || shared.key !== m.proxyUrl || shared.httpOrigins >= maxHttpOrigins) {
    const old = shared?.agent;
    shared = buildShared(m.proxyUrl);
    if (old) retire(old);
  }
  return shared.agent;
}

/** `RequestInit` extension for global-fetch callers: the proxy dispatcher when delegated, else nothing. */
export function egressFetchInit(m: EgressMode): Record<string, unknown> {
  return m.kind === 'delegated' ? { dispatcher: egressProxyDispatcher(m) } : {};
}

/**
 * Recognise a proxy refusal so it is never returned as content, followed as a redirect or retried.
 *
 * Responses: keyed on squid's `X-Squid-Error` header (stable), and only for http:// targets — under
 * CONNECT the response bytes come from the origin through the tunnel, so a spoofing origin can only
 * fail its own fetch. Errors: keyed on undici's CONNECT / 407 messages anywhere in the `cause` chain
 * (best effort: if undici rewords them the error still propagates, just less specifically).
 */
export function proxyRefusal(x: unknown, targetUrl: string): { status: number; detail: string } | null {
  if (x instanceof Response) return squidErrorRefusal(targetUrl, x.status, x.headers.get('x-squid-error'));
  let e: unknown = x;
  for (let i = 0; e && i < 5; i++) {
    const msg = String((e as { message?: unknown }).message ?? '');
    const mm = /Proxy response \((\d{3})\) !== 200 when HTTP Tunneling/.exec(msg);
    if (mm) return { status: Number(mm[1]), detail: 'CONNECT refused' };
    if (/Proxy Authentication Required \(407\)/.test(msg)) return { status: 407, detail: 'proxy auth' };
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * The response half of {@link proxyRefusal} for callers holding a status and an `x-squid-error`
 * value instead of a fetch `Response` (the browser tiers: Playwright's main-navigation response).
 */
export function squidErrorRefusal(
  targetUrl: string,
  status: number,
  squidError: string | null | undefined,
): { status: number; detail: string } | null {
  let protocol: string;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return null;
  }
  if (protocol !== 'http:') return null;
  return squidError ? { status, detail: squidError.replace(/[\r\n]/g, '').slice(0, 64) } : null;
}

export const EGRESS_REFUSED_PREFIX = 'egress proxy refused';

/**
 * A refusal or a misconfiguration is a policy answer, not a flaky host: the router must not count
 * it toward browser escalation (the browser would get the same answer, or render squid's page).
 */
export function isEgressPolicyError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : '';
  return msg.startsWith(EGRESS_REFUSED_PREFIX) || msg.startsWith('egress proxy delegation requested');
}

/**
 * Launch options that keep a delegated browser's WebRTC off the network. Playwright's `proxy`
 * covers HTTP(S) / WebSocket only; Chromium's default WebRTC policy sends STUN / TURN UDP direct,
 * where squid never sees it. WebKit has no such switch, so it is refused. The Chromium switch is
 * honoured by chromium-headless-shell only (headless, no channel); full Chrome / Chromium reads the
 * policy from prefs and ignores it, which is why resolveEgressMode refuses a non-"chromium" browser
 * channel and headful mode.
 */
export function egressBrowserLaunchHardening(
  type: 'chromium' | 'firefox' | 'webkit',
): { args?: string[]; firefoxUserPrefs?: Record<string, string | number | boolean> } {
  if (type === 'chromium') return { args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
  if (type === 'firefox') {
    return { firefoxUserPrefs: { 'media.peerconnection.enabled': false, 'media.peerconnection.ice.proxy_only': true } };
  }
  throw new Error('webkit browser launch refused: egress proxy delegation cannot keep its WebRTC on the proxy');
}

let announced = false;

function originOf(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function announce(m: EgressMode, cfg: Config, env: Env, log: Logger): void {
  announced = true;
  if (m.kind === 'strict') return;
  if (m.kind === 'misconfigured') {
    log.error(egressMisconfiguredMessage(m));
    return;
  }
  log.info(
    `egress: resolved-IP SSRF enforcement delegated to proxy ${m.display}; literal-URL and serve-mode guards ` +
      'stay local; NO_PROXY ignored for fetch-tier hops; sockets not pinned',
  );
  // Advisory only: these do not refuse, they mark what the delegation claim does not cover.
  if (cfg.fetchAllowPrivate) {
    log.warn('egress: WIGOLO_FETCH_ALLOW_PRIVATE has no effect under delegation (the proxy denies private ranges)');
  }
  if (env.NODE_USE_ENV_PROXY !== '1') {
    log.warn('egress: NODE_USE_ENV_PROXY is not 1; global-fetch side paths do not use the egress proxy');
  }
  const want = originOf(m.proxyUrl);
  const envProxies = [env.HTTP_PROXY ?? env.http_proxy, env.HTTPS_PROXY ?? env.https_proxy];
  if (envProxies.some((p) => originOf(p) !== want)) {
    log.warn('egress: HTTP(S)_PROXY does not match PROXY_URL; global-fetch side paths may use another route');
  }
  if (cfg.cdpDirect !== 'off') {
    log.warn('egress: WIGOLO_CDP_DIRECT is on; cdp-direct browser egress is not covered by the proxy');
  }
  if (cfg.cdpUrl != null) {
    log.warn('egress: WIGOLO_CDP_URL is set; the remote browser egresses outside the proxy');
  }
  if (cfg.scrapingBrowserWss != null) {
    log.warn('egress: WIGOLO_SCRAPING_BROWSER_WSS is set; the remote browser egresses outside the proxy');
  }
}

/**
 * Log the egress mode once per process: info (+ advisory warnings) when delegated, error when
 * misconfigured, nothing in strict mode. Never logs the raw proxy URL. The daemon calls it at boot so
 * a misconfiguration shows up without waiting for the first fetch.
 */
export function announceEgressMode(log: Logger = createLogger('fetch')): void {
  if (announced) return;
  const cfg = getConfig();
  announce(resolveEgressMode(cfg, process.env), cfg, process.env, log);
}

/**
 * Test-only: close the shared agent and any agent still in its retire grace period (awaited, so no
 * close settles inside the next test), restore the origin cap and re-arm the announcement.
 */
export async function __resetEgressForTests(): Promise<void> {
  const agents = [...retiring.keys(), ...(shared ? [shared.agent] : [])];
  for (const t of retiring.values()) clearTimeout(t);
  retiring.clear();
  shared = null;
  announced = false;
  maxHttpOrigins = DEFAULT_MAX_HTTP_ORIGINS;
  await Promise.all(agents.map((a) => a.close().catch(() => {})));
}

/** Test-only: lower the http-origin cap after which the shared agent is retired. */
export function __setMaxHttpOriginsForTests(n: number): void {
  maxHttpOrigins = n;
}
