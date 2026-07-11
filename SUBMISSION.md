# Devpost Submission Package — DIG DIG DIG

> Copy-paste source for the Devpost form. Deadline: July 15, 2026, 6:00 PM PDT.
> Submit by July 14 for buffer.

## Project name

**DIG DIG DIG** — this community is digging one big hole. Together. Forever.

## Elevator pitch (short blurb)

Every tap deepens ONE shared, bottomless hole that belongs to the whole community —
while you race the daily leaderboard on a single tank of oxygen. Something is down there.

## Category

**Best Experience That Will Keep People Coming Back** (primary)
Also a fit for: Best Use of Retention Mechanics · Best Use of User Contributions · Phaser

## About the project (long description)

### What it is

DIG DIG DIG is a communal digging game where an entire subreddit digs one shared,
permanent hole. Every centimeter anyone has ever dug is still in there — the hole is
the community's lifetime scoreboard. On top of that permanent monument, each player
runs a tense personal descent: a fresh seeded mine every day, one tank of oxygen,
and one question — how deep can you get on one breath?

### 🐤 Pip — the community's canary

One canary per hole, fed by digging — anyone's digging. If the whole community goes
quiet, Pip gets hungry, then faints (visible right on the post's feed card: "PIP
FAINTED — dig to revive!"). The first player to dig revives the bird for grit, a medal,
and a permanent spot in the Hall of Legends. And Pip earns their keep: **a healthy
canary chirps when your row hides a gas pocket** — communal care buys personal
protection. The community keeps the bird alive; the bird keeps the community alive.

### The hook (why people come back tomorrow)

- **The Daily Mine** — everyone digs the same seeded layout each day; "today's deepest"
  is a fair race that resets at midnight.
- **🔥 Day streaks** — every run pays Grit, multiplied by consecutive days played (up to 2×).
- **🏆 The PB chase** — your live run score sits on screen chasing your all-time best;
  passing it turns the counter gold mid-run.
- **Meta-progression** — Grit buys permanent gear (O₂ Tank, Headlamp, Gem Magnet,
  Gas Mask, Espresso) that makes every future run deeper.
- **📜 The lore** — the deeper you go, the stranger the hole gets. At 60m there is a door.
  It is locked. The community is welcome to theorize.

### Dig together, profit together

- **GOLD RUSH** — a daily community goal (100m dug together) that unlocks double grit
  for *everyone* until midnight, celebrated live on every open screen.
- **Hall of Legends** — permanent monuments for door-reachers, canary-revivers, and
  legendary finders, displayed forever at the top of the Museum. Individual immortality
  inside a communal world.

### The Reddit-native layer

- **Ranks are real subreddit flair** — Worm → Mole → Badger → Excavator → Tunnel Titan →
  Core Dweller, visible on every comment you write.
- **Epitaphs** — when you black out, your last words are buried at your death depth.
  Other players dig past your grave in that day's mine.
- **The Museum** — every treasure ever found, with the finder's username, forever.
- **Post your run** — an explicit, optional button on the blackout screen posts your
  score from your own account as a reply to a single pinned score-board comment. Player
  led, never automated.
- **Live presence** — see how many are digging right now; watch the counter climb in
  realtime as strangers dig; shared milestone celebrations fire for everyone at once.

### Built with

- **Devvit Web + Phaser 4** — client in a webview, Node/Hono serverless backend, Redis state,
  Devvit realtime channels (with polling fallback).
- **Zero asset files** — every texture (clay bands, fractured rock, crystal clusters,
  latched chests, shaded boulders), every particle, and every sound (shovel crunches,
  gas hisses, treasure chimes) is generated procedurally in code at boot.
- **Fair by design** — all treasure RNG is server-side; dig batches are capped against
  honest maximums; per-user rate limits; the daily mine is deterministically seeded so
  every player faces the same earth.

### What we're proud of

- A permanent communal artifact: the hole literally never resets — it is the community's
  shared history in meters.
- The full retention stack: daily seed, streaks, PB chase, medals, gear, flair ranks,
  leaderboards — every proven mechanic, integrated, not bolted on.
- Three rounds of deep code review completed and fixed before submission (anti-cheat,
  race conditions, identity handling for logged-out players).
- Approved through Reddit's app review, fully compliant with the user-action rules
  (all commenting is explicit and player-led — the app never auto-comments).

## Links (fill in on the form)

- App listing: https://developers.reddit.com/apps/dig-dig-dig
- Demo post (permanent, v0.0.5 approved): https://www.reddit.com/r/DigDigDigGame/comments/1ut53gm/dig_dig_dig_we_are_digging_one_big_hole_tap_to/
- Test subreddit: https://www.reddit.com/r/DigDigDigGame
- Repo: (GitHub URL if made public)
- Video: (YouTube URL)

---

# Demo video script — 55 seconds, phone-recorded gameplay + captions

No voiceover needed; big captions carry it. Record vertical gameplay, then caption in
any editor (CapCut/Clipchamp). Game audio ON — the crunches sell it.

| Time | Shot | Caption |
|---|---|---|
| 0–5s | Splash card in the feed, live depth ticking | **"This subreddit is digging one big hole."** |
| 5–12s | Frenzied digging, combo flame to ×5, dirt flying | **"Every tap counts. Forever."** |
| 12–18s | Spot a gem behind rock, detour, GEM! +35cm | **"Greed or speed?"** |
| 18–24s | Pip chirps 🪶! → gas pocket hiss → panic-tap to a supply crate | **"The canary warns you — if the community keeps it fed."** |
| 24–30s | Blackout → payday screen: grit, streak, medal pops | **"Death pays. Streaks multiply."** |
| 30–36s | Bury an epitaph → cut to another player finding the grave | **"Your last words stay buried where you fell."** |
| 36–43s | Leaderboard top-10, then your rank flair on a comment; the Pip canary on the HUD | **"Daily race. Real flair. A canary the whole sub keeps alive."** |
| 43–50s | Run counter turns gold: NEW PERSONAL BEST → THE DOOR event | **"And 60 meters down… there's a door."** |
| 50–55s | Splash card again, depth higher than the opening shot | **"DIG DIG DIG — built on Devvit + Phaser."** |

Recording tips: do a few practice runs to get a ×5 combo take; capture The Door by
using a strong gear loadout; the opening/closing splash shots prove the hole grew
*during the video* — that's the thesis in one image.
