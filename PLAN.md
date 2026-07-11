# ⛏️ DIG DIG DIG — Master Plan

**App slug:** `dig-dig-dig` (registered ✅) · **Display title:** DIG DIG DIG
**Hackathon:** Reddit's Games with a Hook · Deadline **July 15, 2026, 6:00 PM PDT**
**Pitch:** The whole subreddit digs one giant hole. Together. Forever. Whose hole is deepest?
**Category:** Best Experience That Will Keep People Coming Back (Grand Prize $15K)
**Also eligible:** Best Use of Phaser ($5K) · Retention Mechanics ($3K) · User Contributions ($3K)

---

## 1. Game Design

### Core loop (5 seconds)
Tap → dirt particles fly + screen shake + satisfying crunch → depth counter ticks up →
occasionally a FIND pops out (variable-ratio reward) → keep tapping.

### The three layers

**Layer 1 — Personal (instant dopamine)**
- Tap to dig. Every tap = +depth contribution, juicy feedback (particles, shake, pitch-shifted crunch sounds).
- Energy system: N digs per session, regenerates over hours (drives return visits, prevents bots/RSI).
- Shovel upgrades bought with earned Grit (currency from digging/finds): Rusty Spoon → Trowel → Shovel → Jackhammer → Drill Rig → ??? Each changes visuals + dig power.
- Personal stats: lifetime meters dug, finds collected, dig streak (days).

**Layer 2 — Community (the hook)**
- ONE shared hole per subreddit. Server-side total depth = sum of all taps ever.
- The hole's visual state = f(depth): strata change as community digs deeper:
  topsoil → clay → limestone → fossil bed → crystal caves → magma zone → obsidian →
  THE VOID (procedural weirdness; there is no bottom).
- Live "diggers online now" presence + ghost pickaxes of recent diggers (realtime channel).
- Global depth leaderboard across all subreddits running the app ("r/gaming: 8,412m vs r/soccer: 7,990m").
- Weekly "Dig War" events: 48h sprint, winner sub gets a trophy banner in their hole.

**Layer 3 — Treasure & Museum (UGC + retention)**
- Random finds at tap-time, rarity-weighted: junk (common, funny) → relics (uncommon) →
  fossils (rare) → artifacts (epic) → WONDERS (legendary, one-of-a-kind per hole).
- Finder NAMES the find (with filter) → it enters the community Museum with finder credit + comment thread.
- Museum = scrollable gallery of everything this community ever dug up. Community identity in object form.
- Depth milestones auto-post celebration comments ("r/aww just hit 1,000m 🎉").

### Retention mechanics (prize checklist)
- Daily dig streak w/ streak-saver (miss a day, spend Grit).
- Mole Rank flair ladder: Worm → Mole → Badger → Excavator → Core Dweller (auto user flair).
- Energy regen = natural comeback timer. Push at "energy full" via Devvit notifications if available.
- Leaderboards: weekly top diggers (resets = recurring chance to win), all-time, finds count.

### Anti-patterns avoided (from rules)
- Not a clone, not a platformer/shooter/trivia/storytelling app.
- No Reddit/karma/Snoo theming — community spirit is mechanical, not cosmetic.
- No visible AI anything.

## 2. Architecture (Devvit Web + Phaser)

```
src/
├── client/                 # Phaser 3
│   ├── scenes/Boot, Preloader, Hole (main), Museum, Leaderboard
│   ├── systems/ juice.ts (shake/particles/sound), energy.ts, input.ts
│   └── ui/ HUD (depth, energy, grit), FindPopup, StreakToast
├── server/                 # Node (serverless endpoints, /api/*)
│   ├── routes/ dig.ts, state.ts, museum.ts, leaderboard.ts, name-find.ts
│   ├── core/ treasure.ts (server-side RNG!), strata.ts, ranks.ts, antiCheat.ts
│   └── redis keys: hole:{sub}:depth, user:{id}:{grit,energy,streak,shovel},
│       museum:{sub} (sorted set), lb:global (sorted set), finds:{id}
└── shared/ api types, strata table, treasure table
```

Key decisions:
- **All RNG server-side** (treasure rolls in /api/dig response) — no client-side cheating.
- **Batched digs**: client sends taps in batches (e.g. every 10 taps or 2s) → respects serverless model, survives 30s request cap, feels instant locally.
- **Redis** for all state (localStorage dies on app updates — documented limitation).
- **Realtime channel** for live depth ticker + presence (falls back to polling).
- Payments (optional stretch): cosmetic shovel skins only — judges noted payments sandbox.

## 3. Schedule (July 4 → 15)

| Day | Deliverable |
|-----|-------------|
| Jul 4 (today) | Plan ✅, scaffold ✅, core dig loop start: tap→particles→depth |
| Jul 5 | Dig loop DONE + server /api/dig + Redis depth + energy system |
| Jul 6 | Strata visuals + infinite descent camera + depth counter polish |
| Jul 7 | Treasure system (server RNG, rarity table, find popup) + Grit + shovel upgrades |
| Jul 8 | Museum (naming flow, gallery) + milestones |
| Jul 9 | Streaks, Mole rank flair, leaderboards (weekly/all-time/global) |
| Jul 10 | Realtime presence + Dig War scaffolding + splash screen |
| Jul 11 | JUICE DAY: sound design, haptics-feel, particles, screen shake tuning, mobile pass |
| Jul 12 | Playtest on real subreddit w/ friends; fix everything; anti-cheat tune |
| Jul 13 | FEATURE FREEZE. Polish, README, app listing copy, screenshots |
| Jul 14 | Demo video (<1 min), Devpost submission, survey. SUBMIT. |
| Jul 15 | Buffer for disasters only |

## 4. Needed from Ujwal
1. `devvit login` (browser auth with Reddit account) — needed before playtest/upload.
2. Create app at developers.reddit.com/new OR run `devvit init` and pick a code — decides our app slug (want: `the-hole`).
3. Create public test subreddit (suggest: r/TheHoleGame) — you must be mod.
4. Phone for real-device playtesting.
5. Record/voice for demo video (or we do captions-only).

## 5. Win conditions (rubric mapping)
- **Delightful UX:** one-thumb play, zero onboarding, juice everywhere.
- **Polish:** feature freeze Jul 13 + 2 full days of tuning; mobile-first.
- **Reddity:** community-owned world, sub-vs-sub rivalry, museum of shared memories, comment integration.
- **Hook:** variable-ratio treasure + collective progress + "what's at the bottom?" + energy comeback loop + streaks.
- **Phaser:** particles, camera FX, tweens, procedural strata rendering.
