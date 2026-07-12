import { Hono } from 'hono';
import { context, realtime, redis, reddit } from '@devvit/web/server';
import type {
  BuyResponse,
  DigResponse,
  Epitaph,
  EpitaphsResponse,
  Find,
  Gear,
  InitResponse,
  LeaderboardResponse,
  LeaderboardScope,
  Legend,
  LiveEvent,
  MuseumResponse,
  Rarity,
  RunEndResponse,
} from '../../shared/api';
import {
  ACHIEVEMENTS,
  CANARY_NAME,
  canaryStateFor,
  DAILY_GOAL_CM,
  EPITAPHS,
  GEAR_PRICES,
  liveChannel,
  MAX_BREAK_BONUS_CM,
  MAX_CHESTS_PER_MINUTE,
  MAX_CM_PER_MINUTE,
  MAX_MULT,
  MAX_TAPS_PER_BATCH,
  rankForCm,
} from '../../shared/api';

type ErrorResponse = {
  status: 'error';
  message: string;
};

export const api = new Hono();

const KEY_DEPTH = 'hole:depth';
const KEY_LB = 'lb:diggers';
const KEY_MUSEUM = 'museum';
const KEY_PRESENCE = 'presence';
const KEY_CANARY = 'canary:fedAt';
const KEY_LEGENDS = 'legends';
const dayCmKey = () => `daycm:${new Date().toISOString().slice(0, 10)}`;
const rushKey = () => `rush:${new Date().toISOString().slice(0, 10)}`;

/** Immortalize someone. Statues solve the "why should I care?" problem. */
async function carveLegend(text: string): Promise<void> {
  try {
    await redis.zAdd(KEY_LEGENDS, {
      member: JSON.stringify({ text, atMs: Date.now() }),
      score: Date.now(),
    });
  } catch (error) {
    console.error('legend carve failed:', error);
  }
}

async function rushState(): Promise<{ dayCm: number; rush: boolean }> {
  const [raw, flag] = await Promise.all([redis.get(dayCmKey()), redis.get(rushKey())]);
  return { dayCm: raw ? parseInt(raw) || 0 : 0, rush: flag === '1' };
}

/** When was the bird last fed? First reader adopts it (fedAt = now). */
async function canaryFedAt(): Promise<number> {
  const raw = await redis.get(KEY_CANARY);
  if (raw) return parseInt(raw) || Date.now();
  const now = Date.now();
  await redis.set(KEY_CANARY, String(now));
  return now;
}
const PRESENCE_WINDOW_MS = 90_000;
const userKey = (uid: string) => `user:${uid}:digs`;
const metaKey = (uid: string) => `user:${uid}:meta`;

/**
 * Who is digging? Logged-in users get their username for both identity and
 * display. Logged-out users get a stable per-user anon id (from context.userId)
 * so they never share progression, and a friendly display name.
 */
async function identity(): Promise<{ uid: string; name: string; loggedIn: boolean }> {
  const username = await reddit.getCurrentUsername();
  if (username) return { uid: username, name: username, loggedIn: true };
  const t2 = context.userId;
  if (t2) {
    // a stable, distinct display name per anon user, so leaderboards/epitaphs
    // don't collide all logged-out players into one shared row
    const short = t2.replace(/[^a-zA-Z0-9]/g, '').slice(-4) || 'anon';
    return { uid: `anon:${t2}`, name: `stranger-${short}`, loggedIn: false };
  }
  return { uid: 'anonymous', name: 'a-stranger', loggedIn: false };
}

/**
 * A display name for a leaderboard row when `lb:names` has no stored name yet
 * (e.g. an anon digger who dug before names were saved on every dig). Derives a
 * stable, distinct label from the uid so distinct diggers don't all collapse
 * into one generic "a-stranger" row.
 */
function fallbackName(uid: string): string {
  if (uid.startsWith('anon:')) {
    const short = uid.replace(/[^a-zA-Z0-9]/g, '').slice(-4) || 'anon';
    return `stranger-${short}`;
  }
  if (uid === 'anonymous') return 'a-stranger';
  return uid; // a username with no cached name — safe to show as-is
}

/** Mark this user as actively present and return how many are here right now. */
async function touchPresence(uid: string): Promise<number> {
  const now = Date.now();
  await redis.zAdd(KEY_PRESENCE, { member: uid, score: now });
  try {
    await redis.zRemRangeByScore(KEY_PRESENCE, 0, now - PRESENCE_WINDOW_MS);
  } catch {
    /* pruning is best-effort */
  }
  return await redis.zCard(KEY_PRESENCE);
}

async function broadcast(event: LiveEvent): Promise<void> {
  const { postId } = context;
  if (!postId) return;
  try {
    await realtime.send(liveChannel(postId), event);
  } catch (error) {
    console.error('realtime send failed:', error);
  }
}

/**
 * Per-user, per-minute allowance. Returns how much of `amount` is credited;
 * anything beyond the cap is discarded. Honest play never hits the caps.
 */
async function rateLimit(kind: string, uid: string, amount: number, cap: number): Promise<number> {
  if (amount <= 0) return 0;
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `rl:${kind}:${uid}:${bucket}`;
  const used = await redis.incrBy(key, amount);
  await redis.expire(key, 120);
  if (used <= cap) return amount;
  return Math.max(0, amount - (used - cap));
}

/** Today (UTC) unless the client pins a valid day that is today or yesterday. */
function pinnedDay(raw: unknown): string {
  const today = new Date().toISOString().slice(0, 10);
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  return raw === today || raw === yesterday ? raw : today;
}

const GRIT_BY_RARITY: Record<Rarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 40,
  epic: 150,
  legendary: 500,
};

type Meta = {
  grit: number;
  gear: Gear;
  bestRunCm: number;
  streak: number;
  lastDay: string;
  ach: string[];
};

async function getMeta(uid: string): Promise<Meta> {
  const h = await redis.hGetAll(metaKey(uid));
  return {
    grit: parseInt(h.grit ?? '0') || 0,
    gear: {
      tank: h.tank === '1',
      lamp: h.lamp === '1',
      magnet: h.magnet === '1',
      mask: h.mask === '1',
      espresso: h.espresso === '1',
    },
    bestRunCm: parseInt(h.bestRun ?? '0') || 0,
    streak: parseInt(h.streak ?? '0') || 0,
    lastDay: h.lastDay ?? '',
    ach: (h.ach ?? '').split(',').filter((a) => a in ACHIEVEMENTS),
  };
}

/**
 * The single stickied "score board" comment on a post. Per Reddit's user-action
 * rules, players comment their scores AS THEMSELVES as replies to this one comment
 * — the app never auto-comments. Created lazily by the app account and stickied.
 */
type T1 = `t1_${string}`;
async function ensureScoreThread(): Promise<T1 | undefined> {
  const { postId } = context;
  if (!postId) return undefined;
  const key = `scorethread:${postId}`;
  try {
    const existing = await redis.get(key);
    if (existing) return existing as T1;
    // gate so two simultaneous first-braggers don't both create a thread
    const gate = await redis.get(`${key}:lock`);
    if (gate) return undefined;
    await redis.set(`${key}:lock`, '1');
    await redis.expire(`${key}:lock`, 20);

    const comment = await reddit.submitComment({
      id: postId,
      text: '🏆 **DIG DIG DIG — Score Board**\n\nReached a new depth? Tap **💬 Post my run** on your blackout screen to drop your score here. Deepest runs, one breath at a time. ⛏️',
    });
    try {
      await comment.distinguish(true); // sticky it
    } catch {
      /* stickying needs mod scope; the thread still works unstickied */
    }
    await redis.set(key, comment.id);
    return comment.id;
  } catch (error) {
    console.error('score thread failed:', error);
    return undefined;
  }
}

/** Mirror the digger's rank as user flair in the subreddit. Best-effort. */
async function updateFlair(username: string, lifetimeCm: number): Promise<void> {
  try {
    const { subredditName } = context;
    if (!subredditName) return;
    const rank = rankForCm(lifetimeCm);
    await reddit.setUserFlair({
      subredditName,
      username,
      text: `${rank.emoji} ${rank.name} · ${(lifetimeCm / 100).toFixed(0)}m`,
    });
  } catch (error) {
    console.error('flair failed:', error);
  }
}

/** Treasure tables. Odds are per single tap, rolled server-side only. */
const TREASURE: { rarity: Rarity; oneIn: number; items: [string, string][] }[] = [
  {
    rarity: 'legendary',
    oneIn: 30000,
    items: [
      ['🐉', 'Dragon Egg'],
      ['🛸', 'The Thing We Do Not Talk About'],
      ['🕳️', 'A Smaller Hole'],
    ],
  },
  {
    rarity: 'epic',
    oneIn: 6000,
    items: [
      ['👑', 'Buried Crown'],
      ['🗿', 'Tiny Moai'],
      ['⚔️', "Knight's Blade"],
    ],
  },
  {
    rarity: 'rare',
    oneIn: 1200,
    items: [
      ['💎', 'Rough Gem'],
      ['🦷', 'Megalodon Tooth'],
      ['⚱️', 'Sealed Urn'],
      ['🧭', 'Broken Compass'],
    ],
  },
  {
    rarity: 'uncommon',
    oneIn: 250,
    items: [
      ['🦴', 'Mystery Bone'],
      ['🏺', 'Cracked Pot'],
      ['🪙', 'Ancient Coin'],
      ['🗝️', 'Strange Key'],
    ],
  },
  {
    rarity: 'common',
    oneIn: 50,
    items: [
      ['🥾', 'Old Boot'],
      ['🥫', 'Rusty Can'],
      ['🪨', 'Odd Pebble'],
      ['🧦', 'Single Sock'],
      ['🪱', 'Friendly Worm'],
    ],
  },
];

function rollFinds(taps: number, startDepthCm: number, finder: string, finderUid: string): Find[] {
  const finds: Find[] = [];
  for (let i = 0; i < taps; i++) {
    for (const tier of TREASURE) {
      if (Math.random() * tier.oneIn < 1) {
        const [emoji, name] = tier.items[Math.floor(Math.random() * tier.items.length)]!;
        finds.push({ name, emoji, rarity: tier.rarity, depthCm: startDepthCm + i, finder, finderUid });
        break; // one find max per tap, rarest tier wins
      }
    }
  }
  return finds;
}

/** Chest tiles always contain something — at least an uncommon. */
function rollChestFind(depthCm: number, finder: string, finderUid: string): Find {
  const r = Math.random();
  const tier =
    r < 1 / 500
      ? TREASURE[0]! // legendary
      : r < 1 / 100
        ? TREASURE[1]! // epic
        : r < 1 / 12
          ? TREASURE[2]! // rare
          : TREASURE[3]!; // uncommon
  const [emoji, name] = tier.items[Math.floor(Math.random() * tier.items.length)]!;
  return { name, emoji, rarity: tier.rarity, depthCm, finder, finderUid };
}

api.get('/init', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>(
      { status: 'error', message: 'postId is required but missing from context' },
      400
    );
  }

  try {
    const who = await identity();
    const [depth, yourDigs, diggers, meta, canaryFed, rushInfo, allFinds, allDiggers] =
      await Promise.all([
        redis.get(KEY_DEPTH),
        redis.get(userKey(who.uid)),
        touchPresence(who.uid),
        getMeta(who.uid),
        canaryFedAt(),
        rushState(),
        redis.zCard(KEY_MUSEUM).catch(() => 0),
        redis.zCard(KEY_LB).catch(() => 0),
      ]);

    return c.json<InitResponse>({
      type: 'init',
      postId,
      username: who.name,
      uid: who.uid,
      holeDepthCm: depth ? parseInt(depth) : 0,
      yourDigsCm: yourDigs ? parseInt(yourDigs) : 0,
      diggers,
      grit: meta.grit,
      gear: meta.gear,
      bestRunCm: meta.bestRunCm,
      streak: meta.streak,
      ach: meta.ach,
      canaryFedAtMs: canaryFed,
      dayCm: rushInfo.dayCm,
      rush: rushInfo.rush,
      allTimeFinds: allFinds,
      allTimeDiggers: allDiggers,
    });
  } catch (error) {
    console.error(`API Init Error for post ${postId}:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error during init';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

api.post('/dig', async (c) => {
  const { postId } = context;
  if (!postId) {
    return c.json<ErrorResponse>({ status: 'error', message: 'postId is required' }, 400);
  }

  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      taps?: unknown;
      cm?: unknown;
      breaks?: unknown;
      chests?: unknown;
    };
    const num = (v: unknown, lo: number, hi: number) =>
      typeof v === 'number' && Number.isFinite(v)
        ? Math.max(lo, Math.min(Math.floor(v), hi))
        : lo;
    const taps = num(body.taps, 0, MAX_TAPS_PER_BATCH);
    const breaks = num(body.breaks, 0, MAX_TAPS_PER_BATCH);
    // honest ceiling: every tap at max combo, every break the richest possible
    const cmCap = taps * MAX_MULT + breaks * MAX_BREAK_BONUS_CM;
    const rawCm = num(body.cm, 0, cmCap);
    const rawChests = num(body.chests, 0, 3);

    const who = await identity();

    // per-minute allowances shave scripted abuse without touching honest play
    const [cm, chests] = await Promise.all([
      rateLimit('cm', who.uid, rawCm, MAX_CM_PER_MINUTE),
      rateLimit('chest', who.uid, rawChests, MAX_CHESTS_PER_MINUTE),
    ]);

    if (cm <= 0 && chests <= 0) {
      const depth = await redis.get(KEY_DEPTH);
      const meta = await getMeta(who.uid);
      const yourDigs = await redis.get(userKey(who.uid));
      return c.json<DigResponse>({
        type: 'dig',
        holeDepthCm: depth ? parseInt(depth) : 0,
        yourDigsCm: yourDigs ? parseInt(yourDigs) : 0,
        finds: [],
        diggers: await touchPresence(who.uid),
        grit: meta.grit,
        canaryFedAtMs: await canaryFedAt(),
        ...(await rushState()),
      });
    }

    const newDepth = await redis.incrBy(KEY_DEPTH, cm);
    const finds = rollFinds(taps, newDepth - cm, who.name, who.uid);
    for (let i = 0; i < chests; i++) {
      finds.push(rollChestFind(newDepth - cm, who.name, who.uid));
    }

    // --- feed the bird: any dig feeds Pip; reviving a fainted Pip is heroism ---
    const fedAtBefore = await canaryFedAt();
    const quietHours = (Date.now() - fedAtBefore) / 3_600_000;
    const prevCanary = canaryStateFor(quietHours);
    await redis.set(KEY_CANARY, String(Date.now()));
    let reviverBonus = 0;
    // only the first digger to arrive at a fainted Pip claims the revive reward.
    // `nx` makes claim-the-gate atomic, so concurrent revivers can't double-award.
    const firstReviver =
      prevCanary === 'faint' &&
      !!(await redis.set('canary:revivegate', who.uid, {
        nx: true,
        expiration: new Date(Date.now() + 20_000),
      }));
    if (firstReviver) {
      reviverBonus = 100;
      const achRaw = (await redis.hGet(metaKey(who.uid), 'ach')) ?? '';
      const achSet = new Set(achRaw.split(',').filter((a) => a in ACHIEVEMENTS));
      achSet.add('lifesaver');
      await redis.hSet(metaKey(who.uid), { ach: [...achSet].join(',') });
      // reviving Pip is permanent history (in the in-app Hall of Legends — not an
      // auto-comment, which Reddit's user-action rules forbid)
      void carveLegend(`🐤 u/${who.name} revived ${CANARY_NAME} after ${Math.floor(quietHours)} silent hours`);
    }

    // --- GOLD RUSH: the daily community goal ---
    const dayCm = await redis.incrBy(dayCmKey(), cm);
    await redis.expire(dayCmKey(), 172_800);
    let rush = (await redis.get(rushKey())) === '1';
    let rushJustTriggered = false;
    if (!rush && dayCm >= DAILY_GOAL_CM) {
      rush = true;
      rushJustTriggered = true;
      await redis.set(rushKey(), '1');
      await redis.expire(rushKey(), 172_800);
      // announced live in-game via the goldrush event below — no auto-comment
    }

    let gritGain = Math.floor(cm / 10);
    for (const find of finds) gritGain += GRIT_BY_RARITY[find.rarity];
    if (rush) gritGain *= 2;
    gritGain += reviverBonus; // flat +100, never doubled by rush

    const [yourDigs, diggers, grit] = await Promise.all([
      redis.incrBy(userKey(who.uid), cm),
      touchPresence(who.uid),
      redis.hIncrBy(metaKey(who.uid), 'grit', gritGain),
      redis.zIncrBy(KEY_LB, who.uid, cm),
      // keep the all-time board's names fresh even for diggers who never black out
      redis.hSet('lb:names', { [who.uid]: who.name }).catch(() => 0),
      finds.length > 0
        ? redis.zAdd(
            KEY_MUSEUM,
            ...finds.map((f) => ({ member: JSON.stringify(f), score: Date.now() }))
          )
        : Promise.resolve(0),
    ]);

    const prevRank = rankForCm(yourDigs - cm);
    const newRank = rankForCm(yourDigs);
    if (newRank.name !== prevRank.name && who.loggedIn) {
      void updateFlair(who.name, yourDigs);
    }

    // --- live layer: everyone watching sees this happen ---
    const events: LiveEvent[] = [
      { kind: 'dig', user: who.name, uid: who.uid, depthCm: newDepth },
    ];
    if (prevCanary === 'faint') {
      events.push({ kind: 'canary', event: 'revived', by: who.name });
    }
    if (rushJustTriggered) {
      events.push({ kind: 'goldrush', by: who.name });
    }
    for (const find of finds) events.push({ kind: 'find', find });
    const prevDepth = newDepth - cm;
    if (Math.floor(newDepth / 1000) > Math.floor(prevDepth / 1000)) {
      const meters = Math.floor(newDepth / 1000) * 10;
      events.push({ kind: 'milestone', meters }); // celebrated in-game, not in comments
    }
    const legendary = finds.find((f) => f.rarity === 'legendary');
    if (legendary) {
      // permanent in the in-app Hall of Legends (no auto-comment)
      void carveLegend(
        `${legendary.emoji} u/${legendary.finder} unearthed ${legendary.name} at ${(legendary.depthCm / 100).toFixed(1)}m`
      );
    }
    await Promise.all(events.map((e) => broadcast(e)));

    return c.json<DigResponse>({
      type: 'dig',
      holeDepthCm: newDepth,
      yourDigsCm: yourDigs,
      finds,
      diggers,
      grit,
      canaryFedAtMs: Date.now(),
      dayCm,
      rush,
    });
  } catch (error) {
    console.error(`API Dig Error for post ${postId}:`, error);
    const message = error instanceof Error ? error.message : 'Unknown error during dig';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

/** Spend grit on permanent gear. Decrement-then-verify keeps it safe under races. */
api.post('/buy', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { item?: unknown };
    const item = body.item as keyof Gear;
    if (!(typeof item === 'string' && item in GEAR_PRICES)) {
      return c.json<ErrorResponse>({ status: 'error', message: 'unknown item' }, 400);
    }
    const who = await identity();
    const meta = await getMeta(who.uid);
    const price = GEAR_PRICES[item];
    if (meta.gear[item] || meta.grit < price) {
      return c.json<BuyResponse>({ type: 'buy', ok: false, grit: meta.grit, gear: meta.gear });
    }

    // take the money first, then verify nothing raced us; refund if it did
    const grit = await redis.hIncrBy(metaKey(who.uid), 'grit', -price);
    if (grit < 0) {
      const refunded = await redis.hIncrBy(metaKey(who.uid), 'grit', price);
      return c.json<BuyResponse>({ type: 'buy', ok: false, grit: refunded, gear: meta.gear });
    }
    const owned = await redis.hGet(metaKey(who.uid), item);
    if (owned === '1') {
      const refunded = await redis.hIncrBy(metaKey(who.uid), 'grit', price);
      const fresh = await getMeta(who.uid);
      return c.json<BuyResponse>({ type: 'buy', ok: false, grit: refunded, gear: fresh.gear });
    }
    await redis.hSet(metaKey(who.uid), { [item]: '1' });
    meta.gear[item] = true;
    return c.json<BuyResponse>({ type: 'buy', ok: true, grit, gear: meta.gear });
  } catch (error) {
    console.error('buy error:', error);
    const message = error instanceof Error ? error.message : 'buy failed';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

/**
 * The player explicitly taps "Post my run" on the blackout screen. We post the
 * score AS THE USER (runAs: 'USER') as a reply to the single stickied score
 * thread — exactly the pattern Reddit's user-action rules require. Optionally the
 * player attaches their own message, in which case a top-level comment is allowed.
 */
api.post('/brag', async (c) => {
  try {
    const { postId } = context;
    if (!postId) return c.json<ErrorResponse>({ status: 'error', message: 'no post' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as {
      depthCm?: unknown;
      note?: unknown;
    };
    const depthCm = typeof body.depthCm === 'number' ? Math.max(0, Math.floor(body.depthCm)) : 0;
    const note =
      typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
    const who = await identity();

    // light per-user cooldown against accidental double taps
    const gateKey = `brag:${who.uid}`;
    if (await redis.get(gateKey)) return c.json({ type: 'brag', ok: false });
    await redis.set(gateKey, '1');
    await redis.expire(gateKey, 60);

    const depthText = `${(depthCm / 100).toFixed(1)}m in one breath`;
    if (note) {
      // a message with real commentary → top-level comment, as the user
      await reddit.submitComment({
        id: postId,
        text: `⛏️ ${depthText} — ${note}`,
        runAs: 'USER',
      });
    } else {
      // a plain score → reply to the single stickied score thread, as the user
      const threadId = await ensureScoreThread();
      await reddit.submitComment({
        id: threadId ?? postId,
        text: `⛏️ ${depthText}. Beat that.`,
        runAs: 'USER',
      });
    }
    return c.json({ type: 'brag', ok: true });
  } catch (error) {
    console.error('brag error:', error);
    return c.json({ type: 'brag', ok: false });
  }
});

const epitaphKey = (day: string) => `epitaphs:${day}`;

/** Bury your last words at your death depth (pinned to the run's day). */
api.post('/epitaph', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      depthCm?: unknown;
      msgIdx?: unknown;
      day?: unknown;
    };
    const depthCm = typeof body.depthCm === 'number' ? Math.max(0, Math.floor(body.depthCm)) : 0;
    const msgIdx =
      typeof body.msgIdx === 'number'
        ? Math.min(Math.max(0, Math.floor(body.msgIdx)), EPITAPHS.length - 1)
        : 0;
    const day = pinnedDay(body.day);
    const who = await identity();
    const epitaph: Epitaph = { user: who.name, msgIdx, depthCm };
    await redis.zAdd(epitaphKey(day), { member: JSON.stringify(epitaph), score: depthCm });
    await redis.expire(epitaphKey(day), 60 * 60 * 48);
    return c.json({ type: 'epitaph', ok: true });
  } catch (error) {
    console.error('epitaph error:', error);
    const message = error instanceof Error ? error.message : 'epitaph failed';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});

/** Graves for a given day's mine, shallowest first. */
api.get('/epitaphs', async (c) => {
  try {
    const day = pinnedDay(c.req.query('day'));
    const rows = await redis.zRange(epitaphKey(day), 0, 79, { by: 'rank' });
    const epitaphs: Epitaph[] = [];
    for (const row of rows) {
      try {
        epitaphs.push(JSON.parse(row.member) as Epitaph);
      } catch {
        /* skip corrupt */
      }
    }
    return c.json<EpitaphsResponse>({ type: 'epitaphs', epitaphs });
  } catch {
    return c.json<EpitaphsResponse>({ type: 'epitaphs', epitaphs: [] });
  }
});

/**
 * The leaderboard. Two scopes share one endpoint:
 *   today   → deepest single run in today's seeded mine (a fair daily race)
 *   alltime → deepest lifetime digger ever (the community's forever ladder)
 * Both are keyed by uid so distinct players never collide, with names resolved
 * from the `lb:names` hash. `yourRank` comes from the whole set, not just the
 * visible top, so everyone has a standing even outside the top rows.
 */
const LB_TOP = 15;
api.get('/leaderboard', async (c) => {
  const scope: LeaderboardScope = c.req.query('scope') === 'alltime' ? 'alltime' : 'today';
  try {
    const day = pinnedDay(c.req.query('day'));
    const who = await identity();
    const key = scope === 'alltime' ? KEY_LB : `lb:run:${day}`;
    const top = await redis.zRange(key, 0, LB_TOP - 1, { by: 'rank', reverse: true });
    // members are uids; resolve to display names
    const names = await Promise.all(
      top.map((r) => redis.hGet('lb:names', r.member).catch(() => undefined))
    );
    const entries = top.map((r, i) => ({ user: names[i] ?? fallbackName(r.member), depthCm: r.score }));
    const [yourScore, ascRank, total] = await Promise.all([
      redis.zScore(key, who.uid).catch(() => undefined),
      redis.zRank(key, who.uid).catch(() => undefined),
      redis.zCard(key).catch(() => 0),
    ]);
    return c.json<LeaderboardResponse>({
      type: 'leaderboard',
      scope,
      entries,
      yourBestCm: yourScore ?? 0,
      yourRank: ascRank !== undefined ? total - ascRank : 0,
      total,
    });
  } catch {
    return c.json<LeaderboardResponse>({
      type: 'leaderboard',
      scope,
      entries: [],
      yourBestCm: 0,
      yourRank: 0,
      total: 0,
    });
  }
});

/** The museum: latest treasures + the Hall of Legends. */
api.get('/museum', async (c) => {
  try {
    const [rows, legendRows] = await Promise.all([
      redis.zRange(KEY_MUSEUM, 0, 29, { by: 'rank', reverse: true }),
      redis.zRange(KEY_LEGENDS, 0, 9, { by: 'rank', reverse: true }),
    ]);
    const finds: Find[] = [];
    for (const row of rows) {
      try {
        finds.push(JSON.parse(row.member) as Find);
      } catch {
        /* skip corrupt */
      }
    }
    const legends: Legend[] = [];
    for (const row of legendRows) {
      try {
        legends.push(JSON.parse(row.member) as Legend);
      } catch {
        /* skip corrupt */
      }
    }
    return c.json<MuseumResponse>({ type: 'museum', finds, legends });
  } catch {
    return c.json<MuseumResponse>({ type: 'museum', finds: [], legends: [] });
  }
});

/** A blackout ends a run: leaderboard, streak, payday, medals. */
api.post('/run-end', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      depthCm?: unknown;
      day?: unknown;
      ach?: unknown;
    };
    // cap at a generous ceiling far above any real O₂-limited run (anti-farm)
    const depthCm =
      typeof body.depthCm === 'number' ? Math.max(0, Math.min(Math.floor(body.depthCm), 50_000)) : 0;
    const day = pinnedDay(body.day);
    const who = await identity();
    const meta = await getMeta(who.uid);
    const key = `lb:run:${day}`;

    // daily leaderboard (keyed by uid so distinct players never collide)
    const prev = await redis.zScore(key, who.uid);
    if (prev === undefined || depthCm > prev) {
      await redis.zAdd(key, { member: who.uid, score: depthCm });
      await redis.hSet('lb:names', { [who.uid]: who.name });
    }
    const yourBest = Math.max(prev ?? 0, depthCm);
    const top = await redis.zRange(key, 0, 0, { by: 'rank', reverse: true });
    const topName = top[0] ? ((await redis.hGet('lb:names', top[0].member)) ?? who.name) : who.name;
    // your standing on today's board (whole field, not just the visible top)
    const [ascRank, total] = await Promise.all([
      redis.zRank(key, who.uid).catch(() => undefined),
      redis.zCard(key).catch(() => 0),
    ]);
    const yourRank = ascRank !== undefined ? total - ascRank : 0;

    // day streak: consecutive days with at least one run
    let streak = meta.streak;
    if (meta.lastDay !== day) {
      const yesterday = new Date(new Date(`${day}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);
      streak = meta.lastDay === yesterday ? meta.streak + 1 : 1;
    }

    // personal best
    const isPB = depthCm > meta.bestRunCm && depthCm > 0;
    const bestRunCm = Math.max(meta.bestRunCm, depthCm);

    // medals: client-detected but SERVER-validated. Depth-based medals must be
    // backed by the (capped) submitted depth; 'lifesaver' is awarded only by /dig.
    const DEPTH_REQ: Record<string, number> = {
      the_door: 6000,
      run100: 10_000,
      run50: 5_000,
      run25: 2_500,
    };
    const claimed = (Array.isArray(body.ach) ? body.ach : []).filter(
      (a): a is string =>
        typeof a === 'string' &&
        a in ACHIEVEMENTS &&
        a !== 'lifesaver' &&
        (!(a in DEPTH_REQ) || depthCm >= DEPTH_REQ[a]!)
    );
    const ach = [...new Set([...meta.ach, ...claimed])];

    // payday: grit per meter × streak bonus (+10%/day up to +100%), +50 on a PB,
    // then rate-limited so /run-end can't be spammed into a grit farm.
    const base = Math.floor(depthCm / 50);
    const streakMult = 1 + 0.1 * Math.min(Math.max(streak - 1, 0), 10);
    const gritRaw = Math.round(base * streakMult) + (isPB ? 50 : 0);
    const gritEarned = await rateLimit('rungrit', who.uid, gritRaw, 4000);

    const [grit] = await Promise.all([
      redis.hIncrBy(metaKey(who.uid), 'grit', gritEarned),
      redis.hSet(metaKey(who.uid), {
        bestRun: String(bestRunCm),
        streak: String(streak),
        lastDay: day,
        ach: ach.join(','),
      }),
    ]);

    // reaching The Door is permanent history (in-app Hall of Legends, not a comment)
    if (claimed.includes('the_door') && !meta.ach.includes('the_door')) {
      void carveLegend(`🚪 u/${who.name} reached The Door — 60m in one breath`);
    }

    return c.json<RunEndResponse>({
      type: 'runEnd',
      yourBestCm: yourBest,
      todayBestUser: topName,
      todayBestCm: top[0]?.score ?? yourBest,
      gritEarned,
      grit,
      streak,
      isPB,
      bestRunCm,
      yourRank,
      total,
      ach,
    });
  } catch (error) {
    console.error('run-end error:', error);
    const message = error instanceof Error ? error.message : 'run-end failed';
    return c.json<ErrorResponse>({ status: 'error', message }, 400);
  }
});
