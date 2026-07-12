export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';

export type Find = {
  name: string;
  emoji: string;
  rarity: Rarity;
  depthCm: number;
  finder: string;
  /** Stable identity key (username or anon id) — used to filter your own events. */
  finderUid?: string;
};

export type Gear = {
  tank: boolean;
  lamp: boolean;
  magnet: boolean;
  mask: boolean;
  espresso: boolean;
};

export type InitResponse = {
  type: 'init';
  postId: string;
  username: string;
  /** Stable identity key: username, or an anon id derived from userId for logged-out players. */
  uid: string;
  holeDepthCm: number;
  yourDigsCm: number;
  diggers: number;
  grit: number;
  gear: Gear;
  bestRunCm: number;
  streak: number;
  ach: string[];
  canaryFedAtMs: number;
  dayCm: number;
  rush: boolean;
  allTimeFinds: number;
  allTimeDiggers: number;
};

export type DigResponse = {
  type: 'dig';
  holeDepthCm: number;
  yourDigsCm: number;
  finds: Find[];
  diggers: number;
  grit: number;
  canaryFedAtMs: number;
  dayCm: number;
  rush: boolean;
};

export type BuyResponse = { type: 'buy'; ok: boolean; grit: number; gear: Gear };

export type Epitaph = { user: string; msgIdx: number; depthCm: number };
export type EpitaphsResponse = { type: 'epitaphs'; epitaphs: Epitaph[] };

export type MuseumResponse = { type: 'museum'; finds: Find[]; legends: Legend[] };

export type LeaderboardEntry = { user: string; depthCm: number };
export type LeaderboardScope = 'today' | 'alltime';
export type LeaderboardResponse = {
  type: 'leaderboard';
  scope: LeaderboardScope;
  entries: LeaderboardEntry[];
  yourBestCm: number;
  yourRank: number; // 1-based; 0 = unranked
  total: number; // total ranked diggers in this scope
};

/** Permanent gear — bought with Grit between runs, kept forever. */
export const GEAR_PRICES: Record<keyof Gear, number> = {
  tank: 300,
  lamp: 500,
  magnet: 800,
  mask: 1500,
  espresso: 2500,
};
export const GEAR_INFO: Record<keyof Gear, { icon: string; name: string; desc: string }> = {
  tank: { icon: '🫁', name: 'O₂ Tank', desc: '+20 max oxygen' },
  lamp: { icon: '🔦', name: 'Headlamp', desc: 'reveals gas pockets' },
  magnet: { icon: '🧲', name: 'Gem Magnet', desc: 'gems +10 cm' },
  mask: { icon: '😷', name: 'Gas Mask', desc: 'gas hits hurt half as much' },
  espresso: { icon: '☕', name: 'Espresso', desc: 'combo stays hot longer' },
};

/** Medals — earned by run performance, kept forever, shown on the death screen. */
export const ACHIEVEMENTS: Record<string, { emoji: string; name: string; desc: string }> = {
  first_blood: { emoji: '🩹', name: 'First Blood', desc: 'black out once' },
  run25: { emoji: '🥉', name: 'Quarter Club', desc: 'a 25m run' },
  run50: { emoji: '🥈', name: 'Half Century', desc: 'a 50m run' },
  run100: { emoji: '🥇', name: 'The Hundred', desc: 'a 100m run' },
  gasproof: { emoji: '🛡️', name: 'Gasproof', desc: '20m+ without a single gas hit' },
  sprinter: { emoji: '⚡', name: 'Sprinter', desc: '10m in under 60 seconds' },
  hoarder: { emoji: '📦', name: 'Hoarder', desc: '3 chests in one run' },
  crusher: { emoji: '🪨', name: 'Crusher', desc: '3 boulders in one run' },
  the_door: { emoji: '🚪', name: 'The Door', desc: 'reach it. 60m down.' },
  lifesaver: { emoji: '🐤', name: 'Lifesaver', desc: 'revive the fainted canary' },
};

// ------------------------------------------------------------------
// PIP THE CANARY — the community's bird. Fed by digging. Any digging.
// ------------------------------------------------------------------

export type CanaryState = 'happy' | 'hungry' | 'faint';

/** Hungry after 4 quiet hours, fainted after 12. Any dig feeds the bird. */
export function canaryStateFor(hoursSinceFed: number): CanaryState {
  if (hoursSinceFed < 4) return 'happy';
  if (hoursSinceFed < 12) return 'hungry';
  return 'faint';
}

export const CANARY_NAME = 'Pip';

// ------------------------------------------------------------------
// GOLD RUSH — the daily community goal. Hit it together, everyone profits.
// ------------------------------------------------------------------

/** Community must dig this much (cm) in a day to trigger the Gold Rush. */
export const DAILY_GOAL_CM = 10_000; // 100 m together

export type Legend = { text: string; atMs: number };

/** Last words, chosen on blackout, buried at your death depth for others to find. */
export const EPITAPHS: string[] = [
  'almost had it.',
  'the gas… the gas…',
  'worth it.',
  'one more run.',
  'do NOT trust the worms.',
  'I heard the knocking.',
];

/** Rank ladder by lifetime cm dug — mirrored as subreddit flair. */
export const RANKS: { cm: number; name: string; emoji: string }[] = [
  { cm: 0, name: 'Worm', emoji: '🪱' },
  { cm: 1_000, name: 'Mole', emoji: '🦔' },
  { cm: 5_000, name: 'Badger', emoji: '🦡' },
  { cm: 15_000, name: 'Excavator', emoji: '⛏️' },
  { cm: 40_000, name: 'Tunnel Titan', emoji: '🪨' },
  { cm: 100_000, name: 'Core Dweller', emoji: '🌋' },
];

export function rankForCm(cm: number): { cm: number; name: string; emoji: string } {
  let rank = RANKS[0]!;
  for (const r of RANKS) if (cm >= r.cm) rank = r;
  return rank;
}

export type RunEndResponse = {
  type: 'runEnd';
  yourBestCm: number;
  todayBestUser: string;
  todayBestCm: number;
  /** The payday: grit earned for this run (depth × streak bonus × PB bonus). */
  gritEarned: number;
  grit: number;
  streak: number;
  isPB: boolean;
  bestRunCm: number;
  ach: string[];
};

/** Broadcast to everyone watching the post, as it happens. */
export type LiveEvent =
  | { kind: 'dig'; user: string; uid: string; depthCm: number }
  | { kind: 'find'; find: Find }
  | { kind: 'milestone'; meters: number }
  | { kind: 'canary'; event: 'revived'; by: string }
  | { kind: 'goldrush'; by: string };

/** One realtime channel per post. Channel names must be simple tokens. */
export function liveChannel(postId: string): string {
  return `hole_${postId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

/** Max taps the server accepts in one batch (anti-cheat + payload sanity). */
export const MAX_TAPS_PER_BATCH = 30;
/** Highest combo multiplier — the most cm a plain tap can be worth. */
export const MAX_MULT = 5;
/** Biggest possible break payout: row descent (20) + boulder bonus (50). */
export const MAX_BREAK_BONUS_CM = 70;
/** Honest players can't exceed this much credited cm per minute (rate limit). */
export const MAX_CM_PER_MINUTE = 6000;
/** Chest opens credited per minute (rate limit). */
export const MAX_CHESTS_PER_MINUTE = 15;

/** UTC day number → ISO date string, so a run stays pinned to the day it started. */
export function isoDay(dayNum: number): string {
  return new Date(dayNum * 86_400_000).toISOString().slice(0, 10);
}
export function currentDayNum(): number {
  return Math.floor(Date.now() / 86_400_000);
}

/** Strata bands, one every 25 m. The hole never ends; the last band repeats. */
export type Stratum = { name: string; color: number; textColor: string };
export const STRATA: Stratum[] = [
  { name: 'TOPSOIL', color: 0x5d4128, textColor: '#d8b98a' },
  { name: 'CLAY', color: 0x7a4a2b, textColor: '#f0c9a0' },
  { name: 'LIMESTONE', color: 0x6e6a5e, textColor: '#e8e4d8' },
  { name: 'FOSSIL BED', color: 0x54483a, textColor: '#d4c3a3' },
  { name: 'CRYSTAL CAVES', color: 0x3d2f5e, textColor: '#c9b8f0' },
  { name: 'MAGMA ZONE', color: 0x4a1f14, textColor: '#ff9d76' },
  { name: 'OBSIDIAN', color: 0x1c1a24, textColor: '#a99fc4' },
  { name: 'THE VOID', color: 0x0a0a14, textColor: '#7f9cf5' },
];
export const STRATUM_HEIGHT_CM = 2500; // 25 m per band

export function stratumForDepth(depthCm: number): Stratum {
  const idx = Math.min(Math.floor(depthCm / STRATUM_HEIGHT_CM), STRATA.length - 1);
  return STRATA[idx]!;
}

export const RARITY_COLORS: Record<Rarity, string> = {
  common: '#b8b8b8',
  uncommon: '#5dd35d',
  rare: '#4da6ff',
  epic: '#c76bff',
  legendary: '#ffb44d',
};
