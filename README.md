# DIG DIG DIG

This community is digging one big hole. Together. Forever. And something is down there.

DIG DIG DIG is a communal digging game built on Reddit's Developer Platform
(Devvit Web + Phaser). Every tap from every redditor deepens ONE shared, bottomless
hole that belongs to the whole community. On top of that permanent hole, each player
runs their own high-stakes descent through today's mine on a single tank of oxygen.

---

## Install (for moderators)

1. Open the app page: developers.reddit.com/apps/dig-dig-dig
2. Choose "Add to community" and pick a subreddit you moderate.
3. In that subreddit, open the moderator menu (the "..." menu) and choose
   "Start a new hole (DIG DIG DIG)". This creates the game post.
4. Open the post and start digging. That is the whole setup.

The game runs entirely inside the post. There is nothing to configure.

---

## How to play

1. Tap a tile in the highlighted row to dig. Break any tile in the row and you
   drop down one level. One choice per row: the gem behind hard rock, or the fast
   soft dirt?
2. Watch your oxygen (top right). Every swing burns air. Gas pockets look exactly
   like dirt and drain air fast. Supply crates refill it.
3. Tap in rhythm to build a combo (up to 5x dig power). Stop and it cools down.
4. When your oxygen hits zero you black out. The run ends: you see your depth,
   the day's deepest digger, your grit payout, and any medals earned. Then you
   dig again.
5. Every centimeter you ever dig is added to the community hole forever. Your run
   resets. The hole never does.

### Tiles

| Tile        | Hits | Effect                              |
| ----------- | ---- | ----------------------------------- |
| Dirt        | 1    | The fast lane                       |
| Clay        | 2    | Speed bump                          |
| Rock        | 3    | Slow but sometimes worth it         |
| Gem         | 2    | Bonus depth (more with the Magnet)  |
| Chest       | 2    | A guaranteed treasure for the Museum|
| Supply crate| 1    | Refills oxygen                      |
| Gas pocket  | 1    | Drains oxygen, breaks your combo    |
| Boulder     | 5    | Big depth bonus, big explosion      |

---

## What makes it a community game

- One shared hole. The depth on screen is the sum of every tap the community has
  ever made. It is the community's lifetime score, and it is permanent.
- The daily mine. Everyone digs the same seeded layout each day, so "today's
  deepest run" is a fair race. It resets at midnight UTC.
- Gold Rush. If the community digs 100m together in a day, everyone earns double
  grit until midnight.
- Pip the canary. Every hole has one canary, fed by anyone digging. Go quiet too
  long and Pip faints (you can see this on the post's feed card). The next person
  to dig revives it. A healthy Pip warns you when your row hides a gas pocket, so
  keeping the bird alive helps the whole community dig safer.
- The Museum and the Hall of Legends. Every treasure ever found is on display with
  its finder's name. Deep milestones, canary revivals, and the deepest runs are
  recorded permanently.
- Ranks as flair. As your lifetime depth grows your subreddit user flair updates:
  Worm, Mole, Badger, Excavator, Tunnel Titan, Core Dweller.
- Epitaphs. When you black out you can leave a short message buried at your death
  depth. Other players find it as they dig past that point in today's mine.
- Post your run. On the blackout screen you can tap to post your score as a comment.
  It is posted from your own account as a reply to a single pinned score-board
  comment, so the thread stays tidy. This is always optional.

---

## Progression

- Live run score chasing your personal best; beat it and the counter turns gold.
- A grit payout on every run, multiplied by your daily play streak.
- Eight permanent medals (First Blood, The Hundred, Gasproof, Sprinter, and more).
- A leaderboard with two tabs: TODAY (deepest run in today's mine) and ALL-TIME
  (deepest lifetime diggers ever), each showing the top 15 plus your own rank out
  of everyone.
- Five permanent upgrades bought with grit: bigger oxygen tank, a headlamp that
  reveals gas, a gem magnet, a gas mask, and an espresso that lengthens your combo.

---

## Tech

- Client: Phaser 4 in a Devvit Web webview. Every texture, particle, and sound is
  generated procedurally in code. The game ships zero art or audio asset files.
- Server: Node and Hono on Devvit serverless endpoints.
- State: Redis (community depth, per-user progression, leaderboards, museum,
  epitaphs, presence).
- Realtime: Devvit realtime channels for the live layer, with a polling fallback.
- Fairness: all treasure rolls happen on the server, dig batches are server-capped,
  and the daily mine is deterministically seeded so every player faces the same earth.

### Develop

```bash
npm install
npm run dev     # playtest on your test subreddit
npm run deploy  # type-check, lint, upload
npm run launch  # deploy + publish for review
```

---

Built for Reddit's Games with a Hook Hackathon 2026 with Devvit Web and Phaser.
