// Worker entry — HTTP router (replaces google.script.run RPC) + cron (replaces GAS triggers).
// Client POSTs {fn, args:[...]}; we dispatch to REGISTRY and return {ok,data}|{ok,error}.
import * as auth from './auth.js';
import * as pools from './pools.js';
import * as social from './social.js';
import { refreshOdds, dailyImport } from './odds.js';
import { settleMatches, applyNoShowPenalty } from './settle.js';
import * as admin from './admin.js';

// fn name -> handler(env, ...args). Grows one phase at a time; unlisted fn -> clear error.
const REGISTRY = {
  // Phase 1 — auth
  register:    (env, u, p, n) => auth.register(env, u, p, n),
  login:       (env, u, p)    => auth.login(env, u, p),
  resume:      (env, t)       => auth.resume(env, t),
  setNickname: (env, t, n)    => auth.setNickname(env, t, n),
  changePassword: (env, t, o, np) => auth.changePassword(env, t, o, np),
  // Phase 2 — pools + bets
  getPools:    (env, t)                   => pools.getPools(env, t),
  joinPool:    (env, t, id, pw)           => pools.joinPool(env, t, id, pw),
  getMatches:  (env, t, id)               => pools.getMatches(env, t, id),
  getPoolView: (env, t, id)               => pools.getPoolView(env, t, id),
  placeBet:    (env, t, id, fx, mt, o, s) => pools.placeBet(env, t, id, fx, mt, o, s),
  // Phase 3 — leaderboard + badges + history + crowd
  getLeaderboard: (env, t, id)     => social.getLeaderboard(env, t, id),
  setPinnedBadges:(env, t, id, cs) => social.setPinnedBadges(env, t, id, cs),
  getHistory:     (env, t, id)     => social.getHistory(env, t, id),
  getCrowd:       (env, t, id, fx) => social.getCrowd(env, t, id, fx),
  getSeasons:     (env, t, id)     => social.getSeasons(env, t, id),
  // Phase 5 — admin (all gated by requireAdmin inside each)
  adminAddMarket:      (env, t, id, fx, n, o)   => admin.adminAddMarket(env, t, id, fx, n, o),
  adminListClonableMarkets: (env, t, id, fx)    => admin.adminListClonableMarkets(env, t, id, fx),
  adminCloneMarkets:   (env, t, id, fx, srcs)   => admin.adminCloneMarkets(env, t, id, fx, srcs),
  adminEditMarket:     (env, t, id, fx, c, n, o)=> admin.adminEditMarket(env, t, id, fx, c, n, o),
  adminDeleteMarket:   (env, t, id, fx, c)      => admin.adminDeleteMarket(env, t, id, fx, c),
  adminSettleMarket:   (env, t, id, fx, c, w)   => admin.adminSettleMarket(env, t, id, fx, c, w),
  adminFinalizeMarket: (env, t, id, fx, c)      => admin.adminFinalizeMarket(env, t, id, fx, c),
  adminSettleStdMarket:(env, t, id, fx, mt, w)  => admin.adminSettleStdMarket(env, t, id, fx, mt, w),
  adminListPools:      (env, t)                 => admin.adminListPools(env, t),
  adminTournaments:    (env, t, f)              => admin.adminTournaments(env, t, f),
  adminCreatePool:     (env, t, o)              => admin.adminCreatePool(env, t, o),
  adminUpdatePool:     (env, t, id, o)          => admin.adminUpdatePool(env, t, id, o),
  adminSetStatus:      (env, t, id, s)          => admin.adminSetStatus(env, t, id, s),
  adminResetPool:      (env, t, id)             => admin.adminResetPool(env, t, id),
  adminDeletePool:     (env, t, id)             => admin.adminDeletePool(env, t, id),
  adminRefreshOdds:    (env, t)                 => admin.adminRefreshOdds(env, t),
  adminReloadMatches:  (env, t)                 => admin.adminReloadMatches(env, t),
  adminImport:         (env, t, id)             => admin.adminImport(env, t, id),
  adminListMatches:    (env, t, id)             => admin.adminListMatches(env, t, id),
  adminToggleMatch:    (env, t, id, fx, inc)    => admin.adminToggleMatch(env, t, id, fx, inc),
  adminListMembers:    (env, t, id)             => admin.adminListMembers(env, t, id),
  adminBlockMember:    (env, t, id, u, b)       => admin.adminBlockMember(env, t, id, u, b),
  adminResetPassword:  (env, t, u, np)          => auth.adminResetPassword(env, t, u, np),
  adminEndSeason:      (env, t, id, n)          => admin.adminEndSeason(env, t, id, n),
};

function cors(env){
  return {
    'Access-Control-Allow-Origin': env.ALLOW_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}
const json = (env, body, status=200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(env), 'Content-Type': 'application/json' } });

export default {
  async fetch(request, env){
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });
    if (request.method !== 'POST') return json(env, { ok:false, error:'POST only' }, 405);
    let fn, args;
    try { ({ fn, args = [] } = await request.json()); }
    catch { return json(env, { ok:false, error:'Bad JSON' }, 400); }
    const handler = REGISTRY[fn];
    if (!handler) return json(env, { ok:false, error:'Unknown fn: ' + fn }, 404);
    try {
      const data = await handler(env, ...args);
      return json(env, { ok:true, data });
    } catch (e) {
      // Business errors carry Vietnamese messages the UI shows verbatim.
      return json(env, { ok:false, error: e.message || String(e) });
    }
  },

  // Cron — replaces GAS tick()/settleTick()/dailyImport() triggers.
  async scheduled(event, env){
    const run = async (name, fn) => { try { await fn(); } catch (e) { console.error(name + ': ' + (e && e.message || e)); } };
    if (event.cron === '*/5 * * * *') {          // settleTick — clear results fast
      await run('settleMatches', () => settleMatches(env));
    } else if (event.cron === '*/15 * * * *') {  // tick — odds + no-show
      await run('refreshOdds', () => refreshOdds(env));
      await run('applyNoShowPenalty', () => applyNoShowPenalty(env));
    } else if (event.cron === '0 */6 * * *') {   // dailyImport
      await run('dailyImport', () => dailyImport(env));
    }
  },
};
