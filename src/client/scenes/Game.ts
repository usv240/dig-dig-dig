import { Scene } from 'phaser';
import * as Phaser from 'phaser';
import { connectRealtime } from '@devvit/web/client';
import type {
  BuyResponse,
  DigResponse,
  Epitaph,
  EpitaphsResponse,
  Find,
  Gear,
  InitResponse,
  LeaderboardResponse,
  LiveEvent,
  MuseumResponse,
  RunEndResponse,
} from '../../shared/api';
import {
  ACHIEVEMENTS,
  CANARY_NAME,
  canaryStateFor,
  currentDayNum,
  DAILY_GOAL_CM,
  EPITAPHS,
  GEAR_INFO,
  GEAR_PRICES,
  isoDay,
  liveChannel,
  MAX_BREAK_BONUS_CM,
  MAX_MULT,
  MAX_TAPS_PER_BATCH,
  rankForCm,
  RARITY_COLORS,
  STRATA,
} from '../../shared/api';

const FLUSH_MS = 1200;
const SYNC_MS = 20000; // realtime is the primary signal; this is just a fallback
const PX_PER_CM = 2.2;
const COMBO_WINDOW_MS = 750;

// --- tunnel world ---
const COLS = 4;
const ROW_CM = 20; // descending one row is worth this much depth
const GEM_BONUS_CM = 25;
const BOULDER_BONUS_CM = 50;

type TileType = 'dirt' | 'clay' | 'rock' | 'gem' | 'chest' | 'boulder' | 'gas' | 'supply';

const TILE_DEF: Record<
  TileType,
  { hp: number; shade: number; icon: string; bonusCm: number }
> = {
  dirt: { hp: 1, shade: 1.0, icon: '', bonusCm: 0 },
  clay: { hp: 2, shade: 0.8, icon: '', bonusCm: 0 },
  rock: { hp: 3, shade: 0.52, icon: '', bonusCm: 0 },
  gem: { hp: 2, shade: 0.9, icon: '💎', bonusCm: GEM_BONUS_CM },
  chest: { hp: 2, shade: 0.9, icon: '📦', bonusCm: 0 },
  boulder: { hp: 5, shade: 0.6, icon: '🪨', bonusCm: BOULDER_BONUS_CM },
  gas: { hp: 1, shade: 0.75, icon: '', bonusCm: 0 }, // invisible danger — unless you own the Headlamp
  supply: { hp: 1, shade: 0.95, icon: '🧰', bonusCm: 0 },
};

// --- oxygen economy ---
const O2_MAX = 100;
const O2_PER_TAP = 0.32; // ~2.5x longer runs
const O2_GAS_HIT = 15;
const O2_SUPPLY = 40;

/** Rows per level; each level digs gassier, rockier, and richer. */
const ROWS_PER_LEVEL = 22;
/**
 * Supersample factor for procedural textures. Phaser's RESIZE canvas renders at
 * CSS pixels, so on a high-DPI phone the whole scene is upscaled and softened.
 * Drawing textures at the device's real pixel density (capped at 3×) keeps the
 * art crisp without touching the CSS-pixel layout math.
 */
const TEX_SS = Math.min(3, Math.max(2, Math.round(window.devicePixelRatio || 1)));

/** Whispered as your run passes these depths. The hole gets less normal. */
const LORE: [number, string][] = [
  [200, 'an old boot. just one. always one.'],
  [500, 'the worms here do not wiggle. they watch.'],
  [900, 'someone carved "keep going" into the clay.'],
  [1400, 'the dirt is warm here.'],
  [2000, 'you no longer hear the surface.'],
  [2700, 'the pebbles are arranged in a spiral. naturally, surely.'],
  [3500, 'you hear knocking. from below.'],
  [4500, 'the knocking has stopped. that is worse.'],
  [6000, 'a wooden door, buried sideways. it is locked.'],
  [8000, 'the dirt whispers back now. keep digging.'],
];

type Tile = {
  type: TileType;
  hp: number;
  maxHp: number;
  broken: boolean;
  row: number;
  col: number;
  container: Phaser.GameObjects.Container;
  img: Phaser.GameObjects.Image;
  icon?: Phaser.GameObjects.Text;
  dots?: Phaser.GameObjects.Text;
  overlay?: Phaser.GameObjects.Image;
};

/** Deterministic per-row RNG so every player digs through the same earth. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game extends Scene {
  // state
  holeDepthCm = 0;
  displayedDepthCm = 0;
  yourDigsCm = 0;
  username = 'anonymous';
  uid = 'anonymous';
  /** The run is pinned to the day it started, even across UTC midnight. */
  runDayNum = currentDayNum();
  pendingTaps = 0;
  pendingCm = 0;
  pendingBreaks = 0;
  pendingChests = 0;
  depthTween: Phaser.Tweens.Tween | null = null;
  flushTimer?: Phaser.Time.TimerEvent;
  findQueue: Find[] = [];
  showingFind = false;
  hasDug = false;

  // combo
  comboCount = 0;
  lastTapMs = 0;
  multiplier = 1;

  // live layer
  diggers = 1;
  lastPeerToastMs = 0;
  diggersText!: Phaser.GameObjects.Text;

  // the descent (per-run state)
  o2 = O2_MAX;
  running = true;
  runDepthCm = 0;
  runFinds = 0;
  loreIndex = 0;
  runLevel = 0;
  o2BarBg!: Phaser.GameObjects.Rectangle;
  o2BarFill!: Phaser.GameObjects.Rectangle;
  o2Label!: Phaser.GameObjects.Text;
  blackoutGroup: Phaser.GameObjects.GameObject[] = [];

  // meta-progression
  grit = 0;
  gear: Gear = { tank: false, lamp: false, magnet: false, mask: false, espresso: false };
  gritText!: Phaser.GameObjects.Text;

  // the score chase
  bestRunCm = 0;
  streak = 0;
  achievements: string[] = [];
  newMedals: string[] = [];
  gasHits = 0;
  chestsThisRun = 0;
  bouldersThisRun = 0;
  runStartMs = 0;
  pbAnnounced = false;
  runMilestone = 0;
  doorSeen = false;
  muted = false;
  canaryFedAtMs = Date.now();
  dayCm = 0;
  rush = false;
  allTimeFinds = 0;
  allTimeDiggers = 0;
  canaryC!: Phaser.GameObjects.Container;
  canaryImg!: Phaser.GameObjects.Image;
  canaryTween: Phaser.Tweens.Tween | null = null;
  lastCanaryState = '';
  runText!: Phaser.GameObjects.Text;
  muteBtn!: Phaser.GameObjects.Text;

  /** 60 meters down, the hole keeps its promise. */
  theDoorEvent() {
    const { width, height } = this.scale;
    this.cameras.main.shake(600, 0.006);
    this.thud();
    // interactive so taps don't dig through the cutscene; sized generously so a
    // mid-event resize still covers the frame
    const dim = this.add
      .rectangle(-width, -height, width * 3, height * 3, 0x000000, 0)
      .setOrigin(0)
      .setInteractive();
    this.tweens.add({ targets: dim, fillAlpha: 0.75, duration: 700 });
    const door = this.add
      .text(width / 2, height * 0.42, '🚪', { fontSize: 110 })
      .setOrigin(0.5)
      .setScale(0);
    const words = this.add
      .text(width / 2, height * 0.58, 'a wooden door, buried sideways.\nit is locked.\n\n— for now —', {
        fontFamily: 'Georgia, serif',
        fontSize: 20,
        color: '#e8e0c8',
        align: 'center',
        stroke: '#000000',
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setAlpha(0);
    this.tweens.add({ targets: door, scale: 1, duration: 900, ease: 'Back.easeOut', delay: 400 });
    this.tweens.add({ targets: words, alpha: 1, duration: 900, delay: 1100 });
    this.time.delayedCall(3600, () => {
      this.tweens.add({
        targets: [dim, door, words],
        alpha: 0,
        fillAlpha: 0,
        duration: 600,
        onComplete: () => {
          dim.destroy();
          door.destroy();
          words.destroy();
        },
      });
    });
  }

  comboWindow(): number {
    return COMBO_WINDOW_MS + (this.gear.espresso ? 150 : 0);
  }
  museumBtn!: Phaser.GameObjects.Text;
  shopBtn!: Phaser.GameObjects.Text;
  shopGroup: Phaser.GameObjects.GameObject[] = [];
  fsBtn!: Phaser.GameObjects.Text;
  lbBtn!: Phaser.GameObjects.Text;
  lbGroup: Phaser.GameObjects.GameObject[] = [];
  helpBtn!: Phaser.GameObjects.Text;
  helpGroup: Phaser.GameObjects.GameObject[] = [];
  coachGroup: Phaser.GameObjects.GameObject[] = [];
  hudPanel!: Phaser.GameObjects.Graphics;
  lastPanelW = 0;

  /** Glass panel sized to the depth block; redrawn only when the width shifts. */
  drawHudPanel() {
    const { width, height } = this.scale;
    const pw =
      Math.max(this.depthText.displayWidth, this.stratumText.displayWidth + 20, 160) + 44;
    if (Math.abs(pw - this.lastPanelW) < 4) return;
    this.lastPanelW = pw;
    this.hudPanel.clear();
    this.hudPanel.fillStyle(0x000000, 0.32);
    this.hudPanel.lineStyle(2, 0xffffff, 0.08);
    this.hudPanel.fillRoundedRect(width / 2 - pw / 2, height * 0.012, pw, height * 0.185, 14);
    this.hudPanel.strokeRoundedRect(width / 2 - pw / 2, height * 0.012, pw, height * 0.185, 14);
  }
  dust: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  onboardGroup: Phaser.GameObjects.GameObject[] = [];
  lastRunEnd: RunEndResponse | null = null;
  epitaphBuried = false;
  deathBestText: Phaser.GameObjects.Text | null = null;

  // epitaphs (today's graves) & museum
  epitaphs: Epitaph[] = [];
  epIndex = 0;
  museumGroup: Phaser.GameObjects.GameObject[] = [];

  maxO2(): number {
    return O2_MAX + (this.gear.tank ? 20 : 0);
  }

  // tunnel world
  worldC!: Phaser.GameObjects.Container;
  rows = new Map<number, Tile[]>();
  activeRow = 0;
  tileSize = 96;
  anchorY = 300;
  gridX = 0;
  rowFrame!: Phaser.GameObjects.Rectangle;
  hudScale = 1;

  /** Fit the tile grid to any screen: phones get full width, desktops a centered column. */
  computeGrid(width: number, height: number) {
    this.tileSize = Math.max(56, Math.floor(Math.min(width / COLS, height * 0.16)));
    this.anchorY = Math.floor(height * 0.3); // action high on screen, more rows visible below
    this.gridX = Math.floor((width - COLS * this.tileSize) / 2);
  }

  /** The world is seeded, so tearing it down and respawning at a new size is lossless. */
  rebuildWorld() {
    for (const tiles of this.rows.values()) {
      for (const t of tiles) t.container.destroy();
    }
    this.rows.clear();
    this.ensureRows();
    this.worldC.setPosition(this.gridX, this.anchorY - this.activeRow * this.tileSize);
  }

  // display objects
  wall!: Phaser.GameObjects.TileSprite;
  vignette!: Phaser.GameObjects.Image;
  depthText!: Phaser.GameObjects.Text;
  depthLabel!: Phaser.GameObjects.Text;
  stratumText!: Phaser.GameObjects.Text;
  yourText!: Phaser.GameObjects.Text;
  hintText!: Phaser.GameObjects.Text;
  comboText!: Phaser.GameObjects.Text;
  dirtEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  rulerMarks: { line: Phaser.GameObjects.Rectangle; label: Phaser.GameObjects.Text }[] = [];
  pickaxePool: Phaser.GameObjects.Text[] = [];

  // audio
  audioCtx?: AudioContext;

  constructor() {
    super('Game');
  }

  // ------------------------------------------------------------------
  // TEXTURES (all procedural — zero asset files)
  // ------------------------------------------------------------------

  makeWallTexture() {
    if (this.textures.exists('wall')) return;
    const size = 256;
    const canvas = this.textures.createCanvas('wall', size, size);
    if (!canvas) return;
    const ctx = canvas.getContext();
    ctx.fillStyle = '#8a8a8a';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 1400; i++) {
      const v = 96 + Math.floor(Math.random() * 96);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      const s = 1 + Math.random() * 3;
      ctx.fillRect(Math.random() * size, Math.random() * size, s, s);
    }
    for (let i = 0; i < 26; i++) {
      const v = 60 + Math.floor(Math.random() * 60);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      ctx.beginPath();
      ctx.ellipse(
        Math.random() * size,
        Math.random() * size,
        2 + Math.random() * 6,
        2 + Math.random() * 4,
        Math.random() * Math.PI,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    canvas.refresh();
  }

  makeVignetteTexture() {
    if (this.textures.exists('vignette')) return;
    const size = 512;
    const canvas = this.textures.createCanvas('vignette', size, size);
    if (!canvas) return;
    const ctx = canvas.getContext();
    const grad = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.18,
      size / 2,
      size / 2,
      size * 0.62
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    canvas.refresh();
  }

  makeDirtParticleTexture() {
    if (this.textures.exists('dirtpx')) return;
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 7, 7);
    g.generateTexture('dirtpx', 7, 7);
    g.destroy();
  }

  // ------------------------------------------------------------------
  // TILE ART — every material hand-drawn in grayscale, tinted per stratum
  // ------------------------------------------------------------------

  makeTileArt() {
    const size = 96;
    // stratum-tinted bases (grayscale)
    for (const type of ['dirt', 'clay', 'rock'] as const) {
      const key = `tile_${type}`;
      if (this.textures.exists(key)) continue;
      const canvas = this.textures.createCanvas(key, size * TEX_SS, size * TEX_SS);
      if (!canvas) continue;
      const ctx = canvas.getContext();
      ctx.scale(TEX_SS, TEX_SS);
      this.paintTileBase(ctx, size);
      this.paintTileDetail(ctx, size, type);
      this.paintTileBevel(ctx, size);
      canvas.refresh();
    }
    // full-color overlays for the good stuff — these ignore the stratum tint
    const overlays: [string, (ctx: CanvasRenderingContext2D, s: number) => void][] = [
      ['ov_gem', (ctx, s) => this.paintGemOverlay(ctx, s)],
      ['ov_chest', (ctx, s) => this.paintChestOverlay(ctx, s)],
      ['ov_supply', (ctx, s) => this.paintSupplyOverlay(ctx, s)],
      ['ov_boulder', (ctx, s) => this.paintBoulderOverlay(ctx, s)],
    ];
    for (const [key, draw] of overlays) {
      if (this.textures.exists(key)) continue;
      const canvas = this.textures.createCanvas(key, size * TEX_SS, size * TEX_SS);
      if (!canvas) continue;
      const ctx = canvas.getContext();
      ctx.scale(TEX_SS, TEX_SS);
      ctx.clearRect(0, 0, size, size);
      draw(ctx, size);
      canvas.refresh();
    }
  }

  paintGemOverlay(ctx: CanvasRenderingContext2D, s: number) {
    const c = s / 2;
    const glow = ctx.createRadialGradient(c, c, 4, c, c, 42);
    glow.addColorStop(0, 'rgba(120,220,255,0.55)');
    glow.addColorStop(1, 'rgba(120,220,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, s, s);
    const crystal = (cx: number, cy: number, r: number) => {
      // body
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.66, cy - r * 0.15);
      ctx.lineTo(cx + r * 0.4, cy + r);
      ctx.lineTo(cx - r * 0.4, cy + r);
      ctx.lineTo(cx - r * 0.66, cy - r * 0.15);
      ctx.closePath();
      ctx.fillStyle = '#3fbcf2';
      ctx.fill();
      ctx.strokeStyle = '#0e5e86';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      // facets
      ctx.beginPath();
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx, cy + r * 0.2);
      ctx.lineTo(cx - r * 0.4, cy + r);
      ctx.moveTo(cx, cy + r * 0.2);
      ctx.lineTo(cx + r * 0.4, cy + r);
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // shine
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.beginPath();
      ctx.ellipse(cx - r * 0.28, cy - r * 0.35, r * 0.14, r * 0.24, -0.5, 0, Math.PI * 2);
      ctx.fill();
    };
    crystal(c, c - 2, 26);
    crystal(c - 24, c + 16, 11);
    crystal(c + 24, c + 14, 9);
  }

  paintChestOverlay(ctx: CanvasRenderingContext2D, s: number) {
    const x = 16;
    const y = 22;
    const w = s - 32;
    const h = s - 42;
    // body
    ctx.fillStyle = '#8a5a2b';
    ctx.fillRect(x, y, w, h);
    // lid
    ctx.fillStyle = '#a06a34';
    ctx.fillRect(x, y, w, h * 0.38);
    ctx.strokeStyle = '#4a2e12';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.38);
    ctx.lineTo(x + w, y + h * 0.38);
    ctx.stroke();
    // planks
    ctx.strokeStyle = 'rgba(74,46,18,0.6)';
    ctx.lineWidth = 2;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x + (w / 3) * i, y + h * 0.38);
      ctx.lineTo(x + (w / 3) * i, y + h);
      ctx.stroke();
    }
    // golden latch
    ctx.fillStyle = '#ffd75e';
    ctx.fillRect(s / 2 - 8, y + h * 0.28, 16, 20);
    ctx.strokeStyle = '#8a6400';
    ctx.lineWidth = 2;
    ctx.strokeRect(s / 2 - 8, y + h * 0.28, 16, 20);
    ctx.fillStyle = '#8a6400';
    ctx.beginPath();
    ctx.arc(s / 2, y + h * 0.28 + 8, 3, 0, Math.PI * 2);
    ctx.fill();
    // top shine
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.fillRect(x + 3, y + 3, w - 6, 5);
  }

  paintSupplyOverlay(ctx: CanvasRenderingContext2D, s: number) {
    const x = 18;
    const y = 22;
    const w = s - 36;
    const h = s - 42;
    ctx.fillStyle = '#f2f2ee';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#7a7a72';
    ctx.lineWidth = 3;
    ctx.strokeRect(x, y, w, h);
    // red cross
    ctx.fillStyle = '#e04a42';
    ctx.fillRect(s / 2 - 7, y + 8, 14, h - 16);
    ctx.fillRect(x + 8, y + h / 2 - 7, w - 16, 14);
    // shine
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillRect(x + 3, y + 3, w - 6, 4);
  }

  paintBoulderOverlay(ctx: CanvasRenderingContext2D, s: number) {
    const c = s / 2;
    const grad = ctx.createRadialGradient(c - 12, c - 14, 6, c, c, 40);
    grad.addColorStop(0, '#c9c4bc');
    grad.addColorStop(0.65, '#8d877e');
    grad.addColorStop(1, '#4e4a44');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(c, c + 2, 37, 34, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2e2b27';
    ctx.lineWidth = 3.5;
    ctx.stroke();
    // scars
    ctx.strokeStyle = 'rgba(40,36,32,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(c - 15, c - 10);
    ctx.lineTo(c + 1, c + 1);
    ctx.lineTo(c - 5, c + 17);
    ctx.moveTo(c + 12, c - 16);
    ctx.lineTo(c + 18, c - 4);
    ctx.stroke();
  }

  paintTileBase(ctx: CanvasRenderingContext2D, s: number) {
    ctx.fillStyle = '#8f8f8f';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 260; i++) {
      const v = 100 + Math.floor(Math.random() * 90);
      ctx.fillStyle = `rgb(${v},${v},${v})`;
      const d = 1 + Math.random() * 2.6;
      ctx.fillRect(Math.random() * s, Math.random() * s, d, d);
    }
  }

  paintTileDetail(ctx: CanvasRenderingContext2D, s: number, type: TileType) {
    if (type === 'dirt') {
      // a couple of embedded pebbles
      for (let i = 0; i < 3; i++) {
        const v = 60 + Math.random() * 50;
        ctx.fillStyle = `rgba(${v},${v},${v},0.9)`;
        ctx.beginPath();
        ctx.ellipse(
          12 + Math.random() * (s - 24),
          12 + Math.random() * (s - 24),
          3 + Math.random() * 5,
          2 + Math.random() * 4,
          Math.random() * Math.PI,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    } else if (type === 'clay') {
      // wavy sediment bands
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 7;
      for (let b = 0; b < 3; b++) {
        const y0 = 18 + b * 28 + Math.random() * 6;
        ctx.beginPath();
        ctx.moveTo(-4, y0);
        for (let x = 0; x <= s + 8; x += 12) {
          ctx.lineTo(x, y0 + Math.sin(x / 14 + b * 2) * 4);
        }
        ctx.stroke();
      }
    } else if (type === 'rock') {
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.fillRect(0, 0, s, s);
      // facet cracks with highlights
      for (let i = 0; i < 4; i++) {
        const x1 = Math.random() * s;
        const y1 = Math.random() * s;
        const x2 = Math.random() * s;
        const y2 = Math.random() * s;
        ctx.strokeStyle = 'rgba(0,0,0,0.45)';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo((x1 + x2) / 2 + 8, (y1 + y2) / 2);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x1 + 2, y1 + 2);
        ctx.lineTo((x1 + x2) / 2 + 10, (y1 + y2) / 2 + 2);
        ctx.stroke();
      }
    }
  }

  /** Cinematic grade via Phaser's ColorMatrix filter — richer, warmer, punchier. */
  applyCameraGrade() {
    try {
      const filters = this.cameras.main.filters;
      if (!filters) return;
      const cm = filters.internal.addColorMatrix();
      cm.colorMatrix.saturate(0.16, true);
      cm.colorMatrix.contrast(0.08, true);
    } catch (error) {
      console.error('camera filters unavailable (harmless):', error);
    }
  }

  makeCanaryTexture() {
    if (this.textures.exists('canary')) return;
    const s = 64;
    const canvas = this.textures.createCanvas('canary', s * TEX_SS, s * TEX_SS);
    if (!canvas) return;
    const ctx = canvas.getContext();
    ctx.scale(TEX_SS, TEX_SS);
    ctx.clearRect(0, 0, s, s);
    // tail feathers
    ctx.fillStyle = '#e8a72c';
    ctx.beginPath();
    ctx.moveTo(44, 34);
    ctx.lineTo(58, 26);
    ctx.lineTo(58, 36);
    ctx.closePath();
    ctx.fill();
    // body
    ctx.fillStyle = '#ffd94a';
    ctx.beginPath();
    ctx.ellipse(34, 38, 16, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    // belly highlight
    ctx.fillStyle = '#ffe98c';
    ctx.beginPath();
    ctx.ellipse(30, 42, 9, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    // wing
    ctx.fillStyle = '#f2b636';
    ctx.beginPath();
    ctx.ellipse(39, 36, 9, 6, -0.5, 0, Math.PI * 2);
    ctx.fill();
    // head
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.arc(20, 26, 11, 0, Math.PI * 2);
    ctx.fill();
    // beak
    ctx.fillStyle = '#f28c28';
    ctx.beginPath();
    ctx.moveTo(10, 25);
    ctx.lineTo(2, 28);
    ctx.lineTo(10, 31);
    ctx.closePath();
    ctx.fill();
    // eye
    ctx.fillStyle = '#2b2b2b';
    ctx.beginPath();
    ctx.arc(16, 24, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(16.8, 23.2, 0.9, 0, Math.PI * 2);
    ctx.fill();
    // legs
    ctx.strokeStyle = '#c47a1e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(30, 50);
    ctx.lineTo(30, 58);
    ctx.moveTo(38, 50);
    ctx.lineTo(38, 58);
    ctx.stroke();
    canvas.refresh();
  }

  paintTileBevel(ctx: CanvasRenderingContext2D, s: number) {
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(1.5, s - 1.5);
    ctx.lineTo(1.5, 1.5);
    ctx.lineTo(s - 1.5, 1.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.38)';
    ctx.beginPath();
    ctx.moveTo(s - 1.5, 1.5);
    ctx.lineTo(s - 1.5, s - 1.5);
    ctx.lineTo(1.5, s - 1.5);
    ctx.stroke();
  }

  // ------------------------------------------------------------------
  // CREATE
  // ------------------------------------------------------------------

  create() {
    const { width, height } = this.scale;

    // Crisp text on HiDPI phones: Phaser renders Text at CSS-pixel resolution by
    // default, so the browser upscales and blurs it. Wrap the text factory once so
    // every Text (HUD, overlays, popups) renders at the device's real pixel density.
    const textRes = Math.min(3, Math.max(2, Math.round(window.devicePixelRatio || 1)));
    const factory = this.add;
    const makeText = factory.text.bind(factory);
    factory.text = (
      x: number,
      y: number,
      text?: string | string[],
      style?: Phaser.Types.GameObjects.Text.TextStyle
    ): Phaser.GameObjects.Text => makeText(x, y, text ?? '', style).setResolution(textRes);

    this.makeWallTexture();
    this.makeVignetteTexture();
    this.makeDirtParticleTexture();
    this.makeTileArt();
    this.makeCanaryTexture();
    this.applyCameraGrade();

    this.wall = this.add.tileSprite(0, 0, width, height, 'wall').setOrigin(0).setAlpha(0.55);

    // tunnel world
    this.computeGrid(width, height);
    this.worldC = this.add.container(this.gridX, this.anchorY);
    this.ensureRows();

    this.vignette = this.add.image(width / 2, height / 2, 'vignette').setAlpha(0.7);

    // the "you dig HERE" frame around the active row
    this.rowFrame = this.add
      .rectangle(0, 0, 10, 10)
      .setOrigin(0)
      .setFillStyle(0x000000, 0)
      .setStrokeStyle(3, 0xffffff, 0.9);

    // 🐤 Pip, the community's canary, perched above the action
    const perch = this.add.rectangle(0, 12, 34, 3, 0x5a4632).setOrigin(0.5);
    this.canaryImg = this.add.image(0, -14, 'canary').setScale(0.72);
    this.canaryC = this.add.container(0, 0, [perch, this.canaryImg]);
    this.canaryC.setSize(44, 52);
    this.canaryC.setInteractive(
      new Phaser.Geom.Rectangle(-22, -32, 44, 52),
      Phaser.Geom.Rectangle.Contains
    );
    this.canaryC.on('pointerdown', () => this.canaryStatusToast());
    this.applyCanaryState(true);

    // idle life: hops, pecks, occasional soft chirps — mascots must breathe
    this.time.addEvent({
      delay: 5200,
      loop: true,
      callback: () => {
        if (this.canaryState() !== 'happy' || Math.random() > 0.6) return;
        if (Math.random() < 0.5) {
          // little hop
          this.tweens.add({
            targets: this.canaryImg,
            y: '-=7',
            yoyo: true,
            duration: 140,
            ease: 'Quad.easeOut',
          });
        } else {
          // peck-peck
          this.tweens.add({
            targets: this.canaryImg,
            angle: 24,
            yoyo: true,
            repeat: 1,
            duration: 110,
            ease: 'Quad.easeIn',
          });
        }
        if (Math.random() < 0.18) this.softChirp();
      },
    });
    this.tweens.add({
      targets: this.rowFrame,
      alpha: { from: 0.9, to: 0.35 },
      yoyo: true,
      repeat: -1,
      duration: 700,
      ease: 'Sine.easeInOut',
    });

    this.dirtEmitter = this.add.particles(0, 0, 'dirtpx', {
      speed: { min: 130, max: 450 },
      angle: { min: 200, max: 340 },
      gravityY: 1000,
      lifespan: { min: 350, max: 750 },
      scale: { start: 1.5, end: 0.2 },
      rotate: { min: 0, max: 360 },
      emitting: false,
    });

    for (let i = 0; i < 14; i++) {
      const line = this.add.rectangle(0, -100, 26, 3, 0xffffff, 0.55).setOrigin(0, 0.5);
      const label = this.add
        .text(0, -100, '', {
          fontFamily: 'Arial Black',
          fontSize: 17,
          color: '#ffffff',
          stroke: '#000000',
          strokeThickness: 3,
        })
        .setOrigin(0, 0.5)
        .setAlpha(0.72);
      this.rulerMarks.push({ line, label });
    }

    // --- HUD ---
    this.hudPanel = this.add.graphics();
    this.depthLabel = this.add
      .text(0, 0, 'OUR HOLE IS', { fontFamily: 'Arial Black', fontSize: 20, color: '#ffffff' })
      .setOrigin(0.5)
      .setAlpha(0.8)
      .setShadow(0, 2, '#000000', 6);

    this.depthText = this.add
      .text(0, 0, '0.00 m', {
        fontFamily: 'Arial Black',
        fontSize: 62,
        color: '#ffd700',
        stroke: '#000000',
        strokeThickness: 9,
      })
      .setOrigin(0.5);

    this.stratumText = this.add
      .text(0, 0, 'TOPSOIL', {
        fontFamily: 'Arial Black',
        fontSize: 19,
        color: '#d8b98a',
        letterSpacing: 8,
      })
      .setOrigin(0.5)
      .setAlpha(0.95)
      .setShadow(0, 2, '#000000', 6);

    this.comboText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black',
        fontSize: 32,
        color: '#ff7b1c',
        stroke: '#000000',
        strokeThickness: 7,
      })
      .setOrigin(0.5)
      .setAlpha(0);

    this.yourText = this.add
      .text(0, 0, 'you dug: 0 cm', { fontFamily: 'Arial', fontSize: 19, color: '#ffffff' })
      .setOrigin(0.5)
      .setAlpha(0.85)
      .setShadow(0, 2, '#000000', 4);

    // THE score: this run's depth, chasing your personal best
    this.runText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setShadow(0, 2, '#000000', 5);

    this.diggersText = this.add
      .text(0, 0, '', {
        fontFamily: 'Arial Black',
        fontSize: 17,
        color: '#7dffa0',
      })
      .setOrigin(0, 0.5)
      .setAlpha(0.95)
      .setShadow(0, 2, '#000000', 4);

    // oxygen gauge (top right)
    this.o2BarBg = this.add.rectangle(0, 0, 134, 16, 0x000000, 0.55).setOrigin(0, 0.5);
    this.o2BarFill = this.add.rectangle(0, 0, 130, 12, 0x54d16a).setOrigin(0, 0.5);
    this.o2Label = this.add
      .text(0, 0, `O₂ ${O2_MAX}`, { fontFamily: 'Arial Black', fontSize: 14, color: '#ffffff' })
      .setOrigin(1, 0.5)
      .setShadow(0, 2, '#000000', 4);

    // grit purse + museum door
    this.gritText = this.add
      .text(0, 0, '🪙 0', { fontFamily: 'Arial Black', fontSize: 17, color: '#ffd700' })
      .setOrigin(0, 0.5)
      .setShadow(0, 2, '#000000', 4);
    this.museumBtn = this.add
      .text(0, 0, '🏛️', { fontSize: 30 })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openMuseum());
    this.shopBtn = this.add
      .text(0, 0, '🛒', { fontSize: 30 })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openShop());
    this.fsBtn = this.add
      .text(0, 0, '⛶', { fontSize: 30, color: '#ffffff' })
      .setOrigin(1, 0.5)
      .setAlpha(0.75)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        try {
          if (this.scale.isFullscreen) this.scale.stopFullscreen();
          else this.scale.startFullscreen();
        } catch {
          /* not permitted in this webview — harmless */
        }
      });
    this.lbBtn = this.add
      .text(0, 0, '🏆', { fontSize: 30 })
      .setOrigin(1, 0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openLeaderboard());
    this.muteBtn = this.add
      .text(0, 0, '🔊', { fontSize: 28 })
      .setOrigin(1, 0.5)
      .setAlpha(0.75)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        this.muted = !this.muted;
        this.muteBtn.setText(this.muted ? '🔇' : '🔊');
      });
    this.helpBtn = this.add
      .text(0, 0, '❔', { fontSize: 28 })
      .setOrigin(1, 0.5)
      .setAlpha(0.9)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openHelp());

    this.hintText = this.add
      .text(0, 0, '👇 TAP A TILE TO DIG', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    // pulse alpha, never scale — scale belongs to the responsive layout
    this.tweens.add({
      targets: this.hintText,
      alpha: { from: 1, to: 0.55 },
      yoyo: true,
      repeat: -1,
      duration: 550,
      ease: 'Sine.easeInOut',
    });

    // ONE global tap router: any tap that doesn't hit a button digs the active
    // row in the column nearest the finger — no dead zones, ever.
    this.input.on(
      'pointerdown',
      (pointer: Phaser.Input.Pointer, currentlyOver: Phaser.GameObjects.GameObject[]) => {
        if (currentlyOver.length > 0) return; // HUD buttons & overlays own their taps
        this.routeTap(pointer);
      }
    );

    void (async () => {
      try {
        const response = await fetch('/api/init');
        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = (await response.json()) as InitResponse;
        this.username = data.username;
        this.uid = data.uid;
        this.holeDepthCm = data.holeDepthCm;
        this.displayedDepthCm = data.holeDepthCm;
        this.yourDigsCm = data.yourDigsCm;
        this.diggers = data.diggers;
        this.grit = data.grit;
        this.gear = data.gear;
        this.bestRunCm = data.bestRunCm;
        this.streak = data.streak;
        this.achievements = data.ach;
        this.canaryFedAtMs = data.canaryFedAtMs;
        this.dayCm = data.dayCm;
        this.rush = data.rush;
        this.allTimeFinds = data.allTimeFinds;
        this.allTimeDiggers = data.allTimeDiggers;
        this.applyCanaryState();
        this.setO2(this.maxO2());
        this.refreshHud();
        this.connectLive(data.postId);
        void this.loadEpitaphs();
        if (data.yourDigsCm === 0) this.showCoach();
        this.time.delayedCall(600, () => this.warnRowGas());
      } catch (error) {
        console.error('Failed to fetch initial state:', error);
      }
    })();

    this.time.addEvent({ delay: SYNC_MS, loop: true, callback: () => void this.sync() });
    this.runStartMs = this.time.now;

    // gems in the live row glint — the eye finds treasure before the brain does
    this.time.addEvent({
      delay: 1300,
      loop: true,
      callback: () => {
        if (!this.running) return;
        const tiles = this.rows.get(this.activeRow);
        if (!tiles) return;
        for (const tile of tiles) {
          if (tile.broken || (tile.type !== 'gem' && tile.type !== 'chest')) continue;
          this.dirtEmitter.setParticleTint(0xffffff);
          this.dirtEmitter.explode(
            2,
            this.worldC.x + tile.container.x + Phaser.Math.Between(-14, 14),
            this.worldC.y + tile.container.y + Phaser.Math.Between(-14, 14)
          );
        }
      },
    });

    this.updateLayout(width, height);
    this.scale.on('resize', (gameSize: Phaser.Structs.Size) => {
      this.updateLayout(gameSize.width, gameSize.height);
    });
  }

  override update(time: number) {
    if (this.comboCount > 0 && time - this.lastTapMs > this.comboWindow() + 250) {
      this.comboCount = 0;
      this.multiplier = 1;
      this.tweens.add({ targets: this.comboText, alpha: 0, duration: 200 });
    }
  }

  // ------------------------------------------------------------------
  // TUNNEL WORLD
  // ------------------------------------------------------------------

  ensureRows() {
    for (let r = this.activeRow; r <= this.activeRow + 8; r++) {
      if (!this.rows.has(r)) this.spawnRow(r);
    }
    // cull rows far above the screen
    for (const [r, tiles] of this.rows) {
      if (r < this.activeRow - 5) {
        for (const t of tiles) t.container.destroy();
        this.rows.delete(r);
      }
    }
  }

  spawnRow(row: number) {
    const rand = mulberry32(row * 2654435761 + this.runDayNum * 7919);
    const level = Math.min(6, Math.floor(row / ROWS_PER_LEVEL));
    const tiles: Tile[] = [];
    // deeper levels: more danger, more reward, less easy dirt
    const wClay = 0.16;
    const wRock = 0.06 + level * 0.015;
    const wGas = 0.06 + level * 0.022;
    const wGem = 0.06 + level * 0.012;
    const wChest = 0.04 + level * 0.006;
    const wSupply = 0.045;
    const wBoulder = 0.02 + level * 0.006;
    for (let col = 0; col < COLS; col++) {
      const roll = rand();
      let type: TileType;
      let acc = 1 - (wClay + wRock + wGas + wGem + wChest + wSupply + wBoulder); // dirt share
      if (row < 2) {
        type = 'dirt';
      } else if (roll < acc) {
        type = 'dirt';
      } else if (roll < (acc += wClay)) {
        type = 'clay';
      } else if (roll < (acc += wRock)) {
        type = 'rock';
      } else if (roll < (acc += wGas)) {
        type = 'gas';
      } else if (roll < (acc += wGem)) {
        type = 'gem';
      } else if (roll < (acc += wChest)) {
        type = 'chest';
      } else if (roll < acc + wSupply) {
        type = 'supply';
      } else {
        type = 'boulder';
      }
      tiles.push(this.makeTile(row, col, type));
    }
    this.rows.set(row, tiles);
  }

  makeTile(row: number, col: number, type: TileType): Tile {
    const def = TILE_DEF[type];
    const t = this.tileSize;
    const x = col * t + t / 2;
    const y = row * t + t / 2;

    // gas looks EXACTLY like dirt — the danger is the point
    const baseKey =
      type === 'clay' ? 'tile_clay' : type === 'rock' || type === 'boulder' ? 'tile_rock' : 'tile_dirt';
    const img = this.add.image(0, 0, baseKey).setDisplaySize(t - 3, t - 3);
    const container = this.add.container(x, y, [img]);
    // the good stuff is full-color and ignores the stratum tint
    let overlay: Phaser.GameObjects.Image | undefined;
    if (type === 'gem' || type === 'chest' || type === 'supply' || type === 'boulder') {
      overlay = this.add.image(0, 0, `ov_${type}`).setDisplaySize(t * 0.86, t * 0.86);
      container.add(overlay);
    }
    let icon: Phaser.GameObjects.Text | undefined;
    // the Headlamp reveals gas pockets that others can't see
    if (type === 'gas' && this.gear.lamp) {
      icon = this.add.text(0, 0, '☁️', { fontSize: Math.floor(t * 0.4) }).setOrigin(0.5);
      container.add(icon);
      this.tweens.add({
        targets: icon,
        scale: { from: 1, to: 1.15 },
        yoyo: true,
        repeat: -1,
        duration: 600,
        ease: 'Sine.easeInOut',
      });
    }
    container.setSize(t, t);
    // tiles are NOT individually interactive — taps are routed by column so the
    // 200ms descent scroll never creates a dead window for fast tappers

    const tile: Tile = { type, hp: def.hp, maxHp: def.hp, broken: false, row, col, container, img };
    if (icon) tile.icon = icon;
    if (overlay) tile.overlay = overlay;
    // hit-point pips: show how many swings a tough tile still needs
    if (def.hp > 1) {
      const dots = this.add
        .text(0, t * 0.3, '●'.repeat(def.hp), {
          fontSize: Math.max(10, Math.floor(t * 0.13)),
          color: '#ffffff',
        })
        .setOrigin(0.5)
        .setAlpha(0.85)
        .setShadow(0, 1, '#000000', 3);
      container.add(dots);
      tile.dots = dots;
    }
    this.worldC.add(container);
    this.paintTile(tile);
    return tile;
  }

  /**
   * Visuals follow YOUR run's level, not the community total — otherwise a deep
   * communal hole would tint every tile void-black forever, for everyone.
   */
  currentStratum() {
    const idx = Math.min(Math.floor(this.activeRow / ROWS_PER_LEVEL), STRATA.length - 1);
    return STRATA[idx]!;
  }

  paintTile(tile: Tile) {
    if (tile.broken) {
      tile.img.setTint(0x0d0d0d);
      tile.dots?.setVisible(false);
      tile.overlay?.setVisible(false);
      return;
    }
    // color overlays don't tint — they dim by row state instead
    tile.overlay?.setAlpha(
      tile.row === this.activeRow ? 1 : tile.row > this.activeRow ? 0.72 : 0.2
    );
    const def = TILE_DEF[tile.type];
    const stratum = this.currentStratum();
    const damage = 1 - tile.hp / tile.maxHp;
    let shade = def.shade * (1 - damage * 0.45);
    // make the "one choice per row" rule visible:
    if (tile.row > this.activeRow) {
      shade *= 0.55; // not yet reachable — dimmed
    } else if (tile.row < this.activeRow) {
      shade *= 0.22; // abandoned — you chose a different path
      tile.icon?.setAlpha(0.3);
    }
    tile.dots?.setText('●'.repeat(Math.max(0, tile.hp))).setVisible(tile.row === this.activeRow);
    let tint = this.shadeColor(this.brighten(stratum.color), shade);
    if (tile.type === 'gas') {
      // a faint sickly-green cast — the only warning without a Headlamp
      const r = (tint >> 16) & 0xff;
      const g = Math.min(255, ((tint >> 8) & 0xff) * 1.22);
      const b = tint & 0xff;
      tint = (r << 16) | (Math.floor(g) << 8) | b;
    }
    tile.img.setTint(tint);
  }

  shadeColor(color: number, factor: number): number {
    const r = Math.min(255, ((color >> 16) & 0xff) * factor);
    const g = Math.min(255, ((color >> 8) & 0xff) * factor);
    const b = Math.min(255, (color & 0xff) * factor);
    return (r << 16) | (g << 8) | b;
  }

  // ------------------------------------------------------------------
  // DIG (tap a tile)
  // ------------------------------------------------------------------

  /** Map a raw tap to the live tile it should hit, regardless of scroll state. */
  routeTap(pointer: Phaser.Input.Pointer) {
    if (!this.running) return;
    if (
      this.shopGroup.length > 0 ||
      this.museumGroup.length > 0 ||
      this.lbGroup.length > 0 ||
      this.helpGroup.length > 0 ||
      this.coachGroup.length > 0
    )
      return;
    const col = Phaser.Math.Clamp(
      Math.floor((pointer.x - this.gridX) / this.tileSize),
      0,
      COLS - 1
    );
    const tile = this.rows.get(this.activeRow)?.[col];
    if (!tile || tile.broken) return;
    this.tapTile(tile, pointer);
  }

  tapTile(tile: Tile, pointer: Phaser.Input.Pointer) {
    if (!this.running || tile.broken) return;
    if (tile.row !== this.activeRow) {
      // too deep — you must dig through the current row first
      this.tweens.add({
        targets: tile.container,
        x: tile.container.x + 5,
        yoyo: true,
        repeat: 1,
        duration: 40,
      });
      return;
    }

    // combo
    const now = this.time.now;
    this.comboCount = now - this.lastTapMs <= this.comboWindow() ? this.comboCount + 1 : 1;
    this.lastTapMs = now;
    this.multiplier = 1 + Math.min(4, Math.floor(this.comboCount / 15));
    this.updateComboText();

    // your tap owns the depth counter now — stop any peer-sync animation
    if (this.depthTween) {
      this.depthTween.stop();
      this.depthTween = null;
    }

    // damage
    tile.hp -= 1;
    const cmGain = this.multiplier;
    this.holeDepthCm += cmGain;
    this.displayedDepthCm = this.holeDepthCm;
    this.yourDigsCm += cmGain;
    this.runDepthCm += cmGain;
    this.pendingTaps += 1;
    this.pendingCm += cmGain;

    // every swing burns air
    this.setO2(this.o2 - O2_PER_TAP);

    // juice
    const hard = tile.type === 'rock' || tile.type === 'boulder';
    this.dirtEmitter.setParticleTint(hard ? 0x9a9a9a : this.brighten(this.currentStratum().color));
    this.dirtEmitter.explode(Phaser.Math.Between(8, 13) + this.multiplier * 2, pointer.x, pointer.y);
    this.cameras.main.shake(60, 0.0045 + this.multiplier * 0.0005);
    if (hard) this.thud();
    else this.crunch();
    this.swingPickaxe(pointer.x, pointer.y);
    this.impactRing(pointer.x, pointer.y);
    this.tweens.add({
      targets: tile.container,
      scale: { from: 0.94, to: 1 },
      angle: { from: Phaser.Math.Between(-4, 4), to: 0 },
      duration: 90,
    });
    if (!this.hasDug) {
      this.hasDug = true;
      this.runStartMs = this.time.now; // sprinter medal is timed from the first dig
      this.tweens.add({ targets: this.hintText, alpha: 0, duration: 250 });
      this.clearOnboarding();
    }
    this.tweens.add({
      targets: this.depthText,
      scale: { from: this.hudScale * 1.07, to: this.hudScale },
      duration: 100,
      ease: 'Quad.easeOut',
    });

    if (tile.hp <= 0) {
      this.breakTile(tile, pointer);
    } else {
      this.paintTile(tile);
    }
    this.refreshHud();

    if (this.pendingTaps >= MAX_TAPS_PER_BATCH) {
      void this.flush();
    } else {
      this.flushTimer?.remove();
      this.flushTimer = this.time.delayedCall(FLUSH_MS, () => void this.flush());
    }

    // the tap (and any tile it broke) is fully accounted for — NOW check for death
    if (this.o2 <= 0 && this.running) {
      this.blackout();
    }
  }

  breakTile(tile: Tile, pointer: Phaser.Input.Pointer) {
    tile.broken = true;
    const def = TILE_DEF[tile.type];

    // burst matching the tile
    this.dirtEmitter.setParticleTint(
      tile.type === 'gem' ? 0x7de3ff : tile.type === 'chest' ? 0xffd700 : 0xbdbdbd
    );
    this.dirtEmitter.explode(tile.type === 'dirt' ? 18 : 34, pointer.x, pointer.y);

    // bonuses & hazards
    const gemBonus = GEM_BONUS_CM + (this.gear.magnet ? 10 : 0);
    let bonus = def.bonusCm + ROW_CM;
    if (tile.type === 'gem') {
      bonus = gemBonus + ROW_CM;
      this.runFinds += 1;
      this.cameras.main.flash(150, 120, 220, 255);
      this.floatText(pointer.x, pointer.y - 50, `GEM! +${gemBonus} cm`, '#7de3ff', 26);
      this.chime('rare');
    } else if (tile.type === 'chest') {
      this.pendingChests += 1;
      this.runFinds += 1;
      this.chestsThisRun += 1;
      this.floatText(pointer.x, pointer.y - 50, 'CHEST! opening…', '#ffd700', 24);
      this.chime('uncommon');
    } else if (tile.type === 'boulder') {
      this.bouldersThisRun += 1;
      this.cameras.main.flash(200, 255, 255, 255);
      this.cameras.main.shake(220, 0.012);
      // impact zoom punch
      this.cameras.main.zoom = 1.05;
      this.tweens.add({
        targets: this.cameras.main,
        zoom: 1,
        duration: 260,
        ease: 'Quad.easeOut',
      });
      this.floatText(pointer.x, pointer.y - 55, `CRUSHED! +${BOULDER_BONUS_CM} cm`, '#ffffff', 28);
      this.chime('epic');
    } else if (tile.type === 'gas') {
      const hit = this.gear.mask ? Math.ceil(O2_GAS_HIT / 2) : O2_GAS_HIT;
      this.gasHits += 1;
      this.setO2(this.o2 - hit);
      this.cameras.main.flash(220, 90, 200, 90);
      this.cameras.main.shake(180, 0.01);
      this.floatText(
        pointer.x,
        pointer.y - 50,
        this.gear.mask ? `GAS! 😷 -${hit} O₂` : `GAS POCKET! -${hit} O₂`,
        '#7dff7d',
        26
      );
      this.hiss();
      this.comboCount = 0;
      this.multiplier = 1;
      this.tweens.add({ targets: this.comboText, alpha: 0, duration: 150 });
    } else if (tile.type === 'supply') {
      this.setO2(this.o2 + O2_SUPPLY);
      this.floatText(pointer.x, pointer.y - 50, `SUPPLY CRATE! +${O2_SUPPLY} O₂`, '#7dffa0', 26);
      this.chime('uncommon');
    } else {
      this.floatText(pointer.x, pointer.y - 40, `+${ROW_CM} cm`, '#ffffff', 20);
    }

    this.holeDepthCm += bonus;
    this.displayedDepthCm = this.holeDepthCm;
    this.yourDigsCm += bonus;
    this.runDepthCm += bonus;
    this.pendingCm += bonus;
    this.pendingBreaks += 1;
    this.maybeLore();
    this.checkGraves();

    // --- score beats: run milestones + the PB moment ---
    const { width: w, height: h } = this.scale;
    const mile = Math.floor(this.runDepthCm / 1000);
    if (mile > this.runMilestone) {
      this.runMilestone = mile;
      this.floatText(w / 2, h * 0.4, `🎯 ${mile * 10}m RUN!`, '#7dffa0', 30);
      this.chime('uncommon');
    }
    if (!this.pbAnnounced && this.bestRunCm > 0 && this.runDepthCm > this.bestRunCm) {
      this.pbAnnounced = true;
      this.cameras.main.flash(300, 255, 215, 0);
      this.floatText(w / 2, h * 0.45, '🏆 NEW PERSONAL BEST! 🏆', '#ffd700', 34);
      this.chime('legendary');
    }

    // 60m: the lore keeps its promise
    if (!this.doorSeen && this.runDepthCm >= 6000) {
      this.doorSeen = true;
      this.theDoorEvent();
    }

    // fade the icon, darken the hole you carved
    if (tile.icon) {
      this.tweens.add({ targets: tile.icon, alpha: 0, scale: 1.6, duration: 250 });
    }
    this.paintTile(tile);

    // descend!
    this.activeRow += 1;
    this.ensureRows();
    // repaint neighbors so abandoned/dimmed/active states read instantly
    for (let r = this.activeRow - 1; r <= this.activeRow + 1; r++) {
      const rowTiles = this.rows.get(r);
      if (rowTiles) for (const rt of rowTiles) this.paintTile(rt);
    }
    this.tweens.add({
      targets: this.worldC,
      y: this.anchorY - this.activeRow * this.tileSize,
      duration: 200,
      ease: 'Quad.easeOut',
    });

    // the bird checks the new row for gas once the scroll settles
    this.time.delayedCall(260, () => this.warnRowGas());

    // level up?
    const level = Math.floor(this.activeRow / ROWS_PER_LEVEL);
    if (level > this.runLevel) {
      this.runLevel = level;
      const { width, height } = this.scale;
      this.cameras.main.flash(250, 255, 255, 255);
      this.chime('epic');
      this.floatText(width / 2, height * 0.45, `⬇️ LEVEL ${level + 1} ⬇️`, '#ffd700', 38);
      this.floatText(width / 2, height * 0.52, 'deeper. richer. gassier.', '#ffffff', 18);
    }
  }

  updateComboText() {
    if (this.multiplier > 1) {
      this.comboText.setText(`🔥 x${this.multiplier}`);
      this.comboText.setAlpha(1);
      this.tweens.add({
        targets: this.comboText,
        scale: { from: this.hudScale * 1.25, to: this.hudScale },
        duration: 120,
        ease: 'Quad.easeOut',
      });
    } else if (this.comboCount === 1) {
      this.comboText.setAlpha(0);
    }
  }

  // ------------------------------------------------------------------
  // THE DESCENT — oxygen, blackouts, and what lives below
  // ------------------------------------------------------------------

  setO2(value: number) {
    this.o2 = Phaser.Math.Clamp(value, 0, this.maxO2());
    const w = 130 * (this.o2 / this.maxO2());
    this.o2BarFill.setSize(Math.max(1, w), 12);
    this.o2BarFill.fillColor = this.o2 > 50 ? 0x54d16a : this.o2 > 25 ? 0xffb44d : 0xff5f52;
    this.o2Label.setText(`O₂ ${Math.ceil(this.o2)}`);
    if (this.o2 <= 25 && this.running) {
      this.o2Label.setColor('#ff5f52');
    } else {
      this.o2Label.setColor('#ffffff');
    }
    // note: death is NOT triggered here — tapTile checks o2 after the tap fully
    // resolves, so blackout never fires mid-handler with work still queued.
  }

  blackout() {
    this.running = false;
    void this.flush();
    this.epitaphBuried = false;
    this.lastRunEnd = null;
    this.thud();

    // medals earned this run (server validates & persists)
    const earned: string[] = [];
    const has = (id: string) => this.achievements.includes(id) || earned.includes(id);
    const consider = (id: string, cond: boolean) => {
      if (cond && !has(id)) earned.push(id);
    };
    consider('first_blood', true);
    consider('run25', this.runDepthCm >= 2500);
    consider('run50', this.runDepthCm >= 5000);
    consider('run100', this.runDepthCm >= 10000);
    consider('gasproof', this.runDepthCm >= 2000 && this.gasHits === 0);
    consider('sprinter', this.runDepthCm >= 1000 && this.time.now - this.runStartMs < 60000);
    consider('hoarder', this.chestsThisRun >= 3);
    consider('crusher', this.bouldersThisRun >= 3);
    consider('the_door', this.runDepthCm >= 6000);
    this.newMedals = earned;

    this.deathUI(false);

    void (async () => {
      try {
        const response = await fetch('/api/run-end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            depthCm: this.runDepthCm,
            day: isoDay(this.runDayNum),
            ach: earned,
          }),
        });
        if (!response.ok) return;
        const data = (await response.json()) as RunEndResponse;
        this.lastRunEnd = data;
        this.grit = data.grit;
        this.streak = data.streak;
        this.bestRunCm = data.bestRunCm;
        this.achievements = data.ach;
        this.refreshHud();
        this.deathBestText?.setText(this.deathSummary());
        if (data.isPB || earned.length > 0) this.chime('epic');
      } catch {
        /* leaderboard is optional */
      }
    })();
  }

  /** The payday block on the death screen. */
  deathSummary(): string {
    const d = this.lastRunEnd;
    if (!d) return '';
    const lines = [
      `👑 today: u/${d.todayBestUser} · ${(d.todayBestCm / 100).toFixed(1)}m`,
      `your best: ${(d.bestRunCm / 100).toFixed(1)}m${d.isPB ? '  🏆 NEW PB!' : ''}`,
      `💰 +${d.gritEarned} grit${d.streak > 1 ? `  ·  🔥 ${d.streak}-day streak` : ''}`,
    ];
    if (this.newMedals.length > 0) {
      lines.push(
        `🏅 ${this.newMedals.map((id) => `${ACHIEVEMENTS[id]?.emoji} ${ACHIEVEMENTS[id]?.name}`).join('   ')}`
      );
    } else if (this.achievements.length > 0) {
      lines.push(this.achievements.map((id) => ACHIEVEMENTS[id]?.emoji ?? '').join(' '));
    }
    return lines.join('\n');
  }

  /** Build (or rebuild, on resize) the death screen from current state. */
  deathUI(instant: boolean) {
    const { width, height } = this.scale;
    const dim = this.add.rectangle(0, 0, width, height, 0x000000, instant ? 0.88 : 0).setOrigin(0);
    if (!instant) {
      this.tweens.add({ targets: dim, fillAlpha: 0.88, duration: 900, ease: 'Quad.easeIn' });
    }
    this.blackoutGroup = [dim];

    const runM = (this.runDepthCm / 100).toFixed(2);
    const rank = rankForCm(this.yourDigsCm);
    const put = (obj: Phaser.GameObjects.GameObject) => {
      this.blackoutGroup.push(obj);
      return obj;
    };

    // everything scales to the actual frame width so nothing ever clips
    const s = Math.min(width / 640, 1);

    const title = this.add
      .text(width / 2, height * 0.18, 'YOU BLACKED OUT', {
        fontFamily: 'Arial Black',
        fontSize: 34,
        color: '#ff5f52',
        stroke: '#000000',
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    put(title);
    const stats = this.add
      .text(width / 2, height * 0.28, `⛏️ ${runM} m  ·  ${this.runFinds} finds  ·  ${rank.emoji} ${rank.name}`, {
        fontFamily: 'Arial',
        fontSize: 19,
        color: '#ffffff',
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    put(stats);
    const best = this.add
      .text(width / 2, height * 0.365, this.deathSummary(), {
        fontFamily: 'Arial Black',
        fontSize: 17,
        color: '#ffd700',
        align: 'center',
        lineSpacing: 4,
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    put(best);
    this.deathBestText = best;

    // one small optional act: last words (tap to bury, or ignore)
    const epLabel = this.add
      .text(
        width / 2,
        height * 0.46,
        this.epitaphBuried ? '🪦 buried. someone will find it.' : '🪦 last words? (optional)',
        {
          fontFamily: 'Arial',
          fontSize: 15,
          color: '#9a9a9a',
        }
      )
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    put(epLabel);
    const epButtons: Phaser.GameObjects.Text[] = [];
    if (!this.epitaphBuried) {
      const picks = Phaser.Utils.Array.Shuffle([...EPITAPHS.keys()]).slice(0, 2);
      picks.forEach((msgIdx, i) => {
        const btn = this.add
          .text(width / 2, height * (0.52 + i * 0.065), `“${EPITAPHS[msgIdx]}”`, {
            fontFamily: 'Georgia, serif',
            fontSize: 16,
            color: '#e8e0c8',
            backgroundColor: '#26201a',
            padding: { x: 14, y: 6 },
          })
          .setOrigin(0.5)
          .setScale(s)
          .setAlpha(0)
          .setInteractive({ useHandCursor: true })
          .once('pointerdown', () => {
            for (const b of epButtons) b.disableInteractive().setAlpha(0.2);
            btn.setAlpha(1).setColor('#ffd700');
            epLabel.setText('🪦 buried. someone will find it.');
            this.epitaphBuried = true;
            void fetch('/api/epitaph', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                depthCm: this.runDepthCm,
                msgIdx,
                day: isoDay(this.runDayNum),
              }),
            });
          });
        epButtons.push(btn);
        put(btn);
      });
    }

    // shop is one tap away, never a wall of text here
    const shopHint = this.add
      .text(width / 2, height * 0.70, `🛒 supply shack  ·  you have 🪙 ${this.grit}`, {
        fontFamily: 'Arial',
        fontSize: 16,
        color: '#7dffa0',
        backgroundColor: '#14241a',
        padding: { x: 14, y: 6 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openShop());
    put(shopHint);

    // a good run deserves an audience — posts a comment AS YOU (explicit tap)
    const bragWorthy = this.runDepthCm >= 500;
    const brag = this.add
      .text(width / 2, height * 0.765, '💬 Post my run as a comment', {
        fontFamily: 'Arial',
        fontSize: 15,
        color: bragWorthy ? '#ffb44d' : '#555555',
        backgroundColor: '#241a10',
        padding: { x: 12, y: 5 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    if (bragWorthy) {
      brag.setInteractive({ useHandCursor: true }).once('pointerdown', () => {
        brag.setText('💬 posted to the score board!').disableInteractive();
        void fetch('/api/brag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ depthCm: this.runDepthCm }),
        });
      });
    }
    put(brag);

    const again = this.add
      .text(width / 2, height * 0.84, '⛏️ DIG AGAIN', {
        fontFamily: 'Arial Black',
        fontSize: 30,
        color: '#111111',
        backgroundColor: '#ffd700',
        padding: { x: 28, y: 10 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setAlpha(0);
    put(again);
    const fadeIns = [title, stats, best, epLabel, shopHint, brag, again, ...epButtons];
    if (instant) {
      for (const t of fadeIns) t.setAlpha(1);
      again.setInteractive({ useHandCursor: true }).once('pointerdown', () => this.restartRun());
    } else {
      this.tweens.add({ targets: fadeIns, alpha: 1, duration: 500, delay: 700 });
      this.time.delayedCall(1400, () => {
        // a resize may have rebuilt the death screen and destroyed this button
        if (!again.active) return;
        again.setInteractive({ useHandCursor: true }).once('pointerdown', () => this.restartRun());
      });
    }
    this.tweens.add({
      targets: again,
      scale: { from: s, to: s * 1.06 },
      yoyo: true,
      repeat: -1,
      duration: 550,
    });
  }

  restartRun() {
    for (const obj of this.blackoutGroup) obj.destroy();
    this.blackoutGroup = [];
    this.deathBestText = null;
    this.lastRunEnd = null;
    this.o2 = O2_MAX;
    this.runDepthCm = 0;
    this.runFinds = 0;
    this.loreIndex = 0;
    this.runLevel = 0;
    this.comboCount = 0;
    this.multiplier = 1;

    // a new run belongs to the current day — re-pin BEFORE the world respawns
    this.runDayNum = currentDayNum();

    // fresh descent into today's mine, from the top
    for (const tiles of this.rows.values()) {
      for (const t of tiles) t.container.destroy();
    }
    this.rows.clear();
    this.activeRow = 0;
    this.worldC.setPosition(this.gridX, this.anchorY);
    this.ensureRows();

    this.epIndex = 0;
    this.gasHits = 0;
    this.chestsThisRun = 0;
    this.bouldersThisRun = 0;
    this.runStartMs = this.time.now; // re-anchored to the first dig in tapTile
    this.pbAnnounced = false;
    this.runMilestone = 0;
    this.doorSeen = false;
    this.newMedals = [];
    this.hasDug = false;
    this.hintText.setVisible(true).setAlpha(0.9);
    this.running = true;
    this.setO2(this.maxO2());
    this.cameras.main.flash(250, 255, 255, 255);
    void this.loadEpitaphs();
    this.time.delayedCall(500, () => this.warnRowGas());
  }

  async loadEpitaphs() {
    try {
      const response = await fetch(`/api/epitaphs?day=${isoDay(this.runDayNum)}`);
      if (!response.ok) return;
      const data = (await response.json()) as EpitaphsResponse;
      this.epitaphs = data.epitaphs
        .filter((e) => e.user !== this.username)
        .sort((a, b) => a.depthCm - b.depthCm);
      this.epIndex = 0;
    } catch {
      /* graves are optional */
    }
  }

  /** Surface any graves we just dug past. */
  checkGraves() {
    while (this.epIndex < this.epitaphs.length) {
      const grave = this.epitaphs[this.epIndex]!;
      if (grave.depthCm > this.runDepthCm) break;
      this.epIndex += 1;
      this.peerToast(
        `🪦 u/${grave.user} blacked out here (${(grave.depthCm / 100).toFixed(1)}m): “${EPITAPHS[grave.msgIdx] ?? '…'}”`,
        '#e8e0c8'
      );
      this.thud();
    }
  }

  // ------------------------------------------------------------------
  // SUPPLY SHACK — permanent gear, its own quiet overlay
  // ------------------------------------------------------------------

  openShop() {
    if (this.shopGroup.length > 0) return;
    const { width, height } = this.scale;
    const s = Math.min(width / 640, 1);
    const dim = this.add
      .rectangle(0, 0, width, height, 0x000000, 0.92)
      .setOrigin(0)
      .setInteractive();
    const title = this.add
      .text(width / 2, height * 0.12, '🛒 SUPPLY SHACK', {
        fontFamily: 'Arial Black',
        fontSize: 28,
        color: '#7dffa0',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(s);
    const purse = this.add
      .text(width / 2, height * 0.20, `🪙 ${this.grit}`, {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffd700',
      })
      .setOrigin(0.5)
      .setScale(s);
    this.shopGroup = [dim, title, purse];

    // lay the gear cards out to always fit between the purse and CLOSE
    const items = Object.keys(GEAR_INFO) as (keyof typeof GEAR_INFO)[];
    const top = 0.28;
    const bottom = 0.8;
    const step = items.length > 1 ? (bottom - top) / (items.length - 1) : 0;
    items.forEach((item, i) => {
      const info = GEAR_INFO[item];
      const price = GEAR_PRICES[item];
      const owned = this.gear[item];
      const affordable = this.grit >= price;
      const btn = this.add
        .text(
          width / 2,
          height * (top + i * step),
          owned
            ? `${info.icon} ${info.name}  ·  ✅ OWNED`
            : `${info.icon} ${info.name} — 🪙 ${price}  ·  ${info.desc}`,
          {
            fontFamily: 'Arial',
            fontSize: 15,
            align: 'center',
            color: owned ? '#7dffa0' : affordable ? '#ffffff' : '#777777',
            backgroundColor: '#1a2026',
            padding: { x: 16, y: 8 },
          }
        )
        .setOrigin(0.5)
        .setScale(Math.min(s, (width * 0.94) / 360));
      if (!owned && affordable) {
        btn.setInteractive({ useHandCursor: true }).once('pointerdown', () => {
          void (async () => {
            try {
              const response = await fetch('/api/buy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ item }),
              });
              if (!response.ok) return;
              const data = (await response.json()) as BuyResponse;
              if (data.ok) {
                this.grit = data.grit;
                this.gear = data.gear;
                btn.setText(`${info.icon} ${info.name}  ·  ✅ OWNED`).setColor('#7dffa0');
                purse.setText(`🪙 ${this.grit}`);
                this.chime('epic');
                this.cameras.main.flash(150, 125, 255, 160);
                this.refreshHud();
              }
            } catch {
              /* ignore */
            }
          })();
        });
      }
      this.shopGroup.push(btn);
    });

    const close = this.add
      .text(width / 2, height * 0.92, '✕ CLOSE', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        backgroundColor: '#333333',
        padding: { x: 18, y: 8 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setInteractive({ useHandCursor: true })
      .once('pointerdown', () => {
        for (const obj of this.shopGroup) obj.destroy();
        this.shopGroup = [];
      });
    this.shopGroup.push(close);
  }

  // ------------------------------------------------------------------
  // 🐤 PIP — fed by community digging; warns of gas while healthy
  // ------------------------------------------------------------------

  canaryState() {
    return canaryStateFor((Date.now() - this.canaryFedAtMs) / 3_600_000);
  }

  applyCanaryState(force = false) {
    const state = this.canaryState();
    if (!force && state === this.lastCanaryState) return;
    this.lastCanaryState = state;
    this.canaryTween?.stop();
    this.canaryImg.setAngle(0).setY(-14);
    if (state === 'happy') {
      this.canaryImg.clearTint();
      this.canaryTween = this.tweens.add({
        targets: this.canaryImg,
        y: -18,
        yoyo: true,
        repeat: -1,
        duration: 550,
        ease: 'Sine.easeInOut',
      });
    } else if (state === 'hungry') {
      this.canaryImg.setTint(0xd9c894);
      this.canaryTween = this.tweens.add({
        targets: this.canaryImg,
        y: -16,
        angle: -8,
        yoyo: true,
        repeat: -1,
        duration: 1300,
        ease: 'Sine.easeInOut',
      });
    } else {
      // fainted: lying on the perch, gray
      this.canaryImg.setTint(0x9a9a9a).setAngle(95).setY(-6);
      this.canaryTween = null;
    }
  }

  canaryStatusToast() {
    const state = this.canaryState();
    const hours = Math.floor((Date.now() - this.canaryFedAtMs) / 3_600_000);
    if (state === 'happy') {
      this.peerToast(`🐤 ${CANARY_NAME} is chirping — the mine is alive. (a fed ${CANARY_NAME} warns of gas!)`, '#ffe066');
    } else if (state === 'hungry') {
      this.peerToast(`🐤 ${CANARY_NAME} is hungry — ${hours}h since anyone dug. Digging feeds the bird.`, '#ffb44d');
    } else {
      this.peerToast(`🚨 ${CANARY_NAME} FAINTED after ${hours} silent hours. DIG to revive! (+100 grit, 🐤 medal)`, '#ff5f52');
    }
  }

  /** A healthy bird smells the gas: warns (but doesn't locate) danger in your row. */
  warnRowGas() {
    if (!this.running || this.canaryState() === 'faint') return;
    const tiles = this.rows.get(this.activeRow);
    if (!tiles || !tiles.some((t) => !t.broken && t.type === 'gas')) return;
    this.chirpChirp();
    this.tweens.add({
      targets: this.canaryImg,
      y: '-=10',
      yoyo: true,
      duration: 130,
      repeat: 2,
      ease: 'Quad.easeOut',
    });
    this.floatText(this.canaryC.x + 8, this.canaryC.y - 44, '🪶 !', '#ffe066', 20);
  }

  /** One quiet contented note. */
  softChirp() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 1760;
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  /** Two sharp warning notes. */
  chirpChirp() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    [1568, 1976].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.11;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.12);
    });
  }

  // ------------------------------------------------------------------
  // HELP — the full how-to-play, openable any time
  // ------------------------------------------------------------------

  openHelp() {
    if (this.helpGroup.length > 0) return;
    const { width, height } = this.scale;
    const s = Math.min(width / 640, 1);
    const dim = this.add
      .rectangle(0, 0, width, height, 0x0a0a0a, 0.96)
      .setOrigin(0)
      .setInteractive();
    const title = this.add
      .text(width / 2, height * 0.06, '❔ HOW TO DIG', {
        fontFamily: 'Arial Black',
        fontSize: 27,
        color: '#ffd700',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(s);
    const body = [
      'TAP the glowing row to dig. Break any tile → you drop down.',
      'One choice per row: fast dirt, or the gem behind hard rock?',
      '',
      '🫁 O₂ drains every swing. Hit 0 → you black out.',
      '🧰 crates refill air   ·   ☁️ gas pockets drain it (they look like dirt!)',
      '💎 gem +cm   ·   📦 chest = guaranteed treasure   ·   🪨 boulder = big cm',
      '🔥 tap in rhythm to build a ×2–×5 combo',
      '',
      '🏆 out-dig your own best — your run score is up top.',
      '💰 death pays grit. play daily → 🔥 streak multiplies it.',
      '🛒 spend grit on permanent gear (more air, gas mask, gem magnet…).',
      '',
      '🐤 Pip the canary is fed by digging. Starve it and it faints —',
      '   a healthy Pip chirps to warn you of gas. Keep it alive!',
      '⚡ dig 100m as a community → GOLD RUSH: 2× grit for everyone.',
      '🕳️ the hole is shared and permanent. every cm you dig stays forever.',
    ].join('\n');
    const text = this.add
      .text(width / 2, height * 0.53, body, {
        fontFamily: 'Arial',
        fontSize: 16,
        color: '#f0ead8',
        align: 'center',
        lineSpacing: 6,
        wordWrap: { width: (width * 0.92) / s },
      })
      .setOrigin(0.5)
      .setScale(s);
    // if it's too tall for the frame, shrink to fit
    const maxH = height * 0.78;
    if (text.height * s > maxH) text.setScale((s * maxH) / (text.height * s));
    const close = this.add
      .text(width / 2, height * 0.93, '✕ GOT IT', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#111111',
        backgroundColor: '#ffd700',
        padding: { x: 20, y: 8 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setInteractive({ useHandCursor: true })
      .once('pointerdown', () => {
        for (const obj of this.helpGroup) obj.destroy();
        this.helpGroup = [];
      });
    this.helpGroup = [dim, title, text, close];
  }

  // ------------------------------------------------------------------
  // COACH — a one-time welcome for brand-new players
  // ------------------------------------------------------------------

  showCoach() {
    if (this.coachGroup.length > 0) return;
    const { width, height } = this.scale;
    const s = Math.min(width / 640, 1);
    const dim = this.add
      .rectangle(0, 0, width, height, 0x0a0a0a, 0.93)
      .setOrigin(0)
      .setInteractive();
    const title = this.add
      .text(width / 2, height * 0.13, 'WELCOME, DIGGER', {
        fontFamily: 'Arial Black',
        fontSize: 30,
        color: '#ffd700',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(s);
    const body = [
      "We're all digging ONE endless hole.",
      'Every tap makes it deeper — forever.',
      '',
      'Tap the glowing row to dig. Watch your O₂.',
      'Grab treasure, dodge gas, beat your own record.',
      '',
      'Up top: 🏆 daily ranks   🛒 spend grit on gear   🏛️ treasures',
      '',
      'Come back daily — your streak multiplies grit,',
      'and the hole keeps growing while you are gone.',
      '',
      '🐤 that is Pip. Keep the community digging',
      'or the little guy faints.',
    ].join('\n');
    const text = this.add
      .text(width / 2, height * 0.5, body, {
        fontFamily: 'Arial',
        fontSize: 18,
        color: '#f0ead8',
        align: 'center',
        lineSpacing: 5,
        wordWrap: { width: (width * 0.9) / s },
      })
      .setOrigin(0.5)
      .setScale(s);
    const maxH = height * 0.62;
    if (text.height * s > maxH) text.setScale((s * maxH) / (text.height * s));
    const go = this.add
      .text(width / 2, height * 0.88, "⛏️ LET'S DIG", {
        fontFamily: 'Arial Black',
        fontSize: 26,
        color: '#111111',
        backgroundColor: '#ffd700',
        padding: { x: 26, y: 10 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setInteractive({ useHandCursor: true })
      .once('pointerdown', () => {
        for (const obj of this.coachGroup) obj.destroy();
        this.coachGroup = [];
      });
    this.tweens.add({
      targets: go,
      scale: { from: s, to: s * 1.06 },
      yoyo: true,
      repeat: -1,
      duration: 550,
    });
    this.coachGroup = [dim, title, text, go];
  }

  // ------------------------------------------------------------------
  // ONBOARDING — three lines, gone at first tap
  // ------------------------------------------------------------------

  showOnboarding() {
    if (this.hasDug || this.onboardGroup.length > 0) return;
    this.hintText.setVisible(false); // onboarding line 1 says the same thing (visible beats the pulse tween)
    const { width } = this.scale;
    const s = this.hudScale;
    const baseY = this.anchorY + this.tileSize + 30 * s;
    const lines = [
      '⛏️ tap tiles in the glowing row to dig',
      '🫁 every swing costs O₂ — 🧰 crates refill it',
      '🏆 out-dig yesterday-you. that is the game.',
      '❔ tap the ? up top anytime for help',
    ];
    this.onboardGroup = lines.map((str, i) =>
      this.add
        .text(width / 2, baseY + i * 30 * s, str, {
          fontFamily: 'Arial Black',
          fontSize: 17,
          color: i === 2 ? '#ffd700' : '#ffffff',
          stroke: '#000000',
          strokeThickness: 5,
        })
        .setOrigin(0.5)
        .setScale(Math.min(s, (width * 0.92) / 340))
    );
    this.time.delayedCall(12000, () => this.clearOnboarding());
  }

  clearOnboarding() {
    for (const obj of this.onboardGroup) obj.destroy();
    this.onboardGroup = [];
  }

  // ------------------------------------------------------------------
  // LEADERBOARD — today's ladder, your rung highlighted
  // ------------------------------------------------------------------

  openLeaderboard() {
    if (this.lbGroup.length > 0) return;
    const { width, height } = this.scale;
    const s = Math.min(width / 640, 1);
    const dim = this.add
      .rectangle(0, 0, width, height, 0x000000, 0.9)
      .setOrigin(0)
      .setInteractive();
    const title = this.add
      .text(width / 2, height * 0.09, "🏆 TODAY'S DEEPEST", {
        fontFamily: 'Arial Black',
        fontSize: 28,
        color: '#ffd700',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(s);
    const list = this.add
      .text(width / 2, height * 0.46, 'measuring the depths…', {
        fontFamily: 'Arial',
        fontSize: 18,
        color: '#ffffff',
        align: 'left',
        lineSpacing: 10,
      })
      .setOrigin(0.5)
      .setScale(s);
    const you = this.add
      .text(width / 2, height * 0.8, '', {
        fontFamily: 'Arial Black',
        fontSize: 18,
        color: '#7dffa0',
      })
      .setOrigin(0.5)
      .setScale(s);
    const close = this.add
      .text(width / 2, height * 0.9, '✕ CLOSE', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        backgroundColor: '#333333',
        padding: { x: 18, y: 8 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setInteractive({ useHandCursor: true })
      .once('pointerdown', () => {
        for (const obj of this.lbGroup) obj.destroy();
        this.lbGroup = [];
      });
    this.lbGroup = [dim, title, list, you, close];

    void (async () => {
      try {
        const response = await fetch(`/api/leaderboard?day=${isoDay(this.runDayNum)}`);
        if (!response.ok) throw new Error('leaderboard fetch failed');
        const data = (await response.json()) as LeaderboardResponse;
        const hint = '(a run posts here when you black out)';
        if (data.entries.length === 0) {
          list.setText(`no runs finished today yet.\nblack out and your depth tops the board!\n\n${hint}`);
          return;
        }
        const medals = ['🥇', '🥈', '🥉'];
        const lines = data.entries.map((e, i) => {
          const badge = medals[i] ?? ` ${i + 1}.`;
          const self = e.user === this.username ? '  ◀ you' : '';
          return `${badge} u/${e.user} — ${(e.depthCm / 100).toFixed(1)}m${self}`;
        });
        lines.push(`\n${hint}`);
        list.setText(lines.join('\n'));
        if (data.yourRank > 0) {
          you.setText(`your rank today: #${data.yourRank} · ${(data.yourBestCm / 100).toFixed(1)}m`);
        } else {
          you.setText('finish a run to claim your rank →');
        }
      } catch {
        list.setText('the board is buried. try again.');
      }
    })();
  }

  // ------------------------------------------------------------------
  // MUSEUM — everything this community ever unearthed
  // ------------------------------------------------------------------

  openMuseum() {
    if (this.museumGroup.length > 0) return;
    const { width, height } = this.scale;
    const s = Math.min(width / 640, 1);
    const dim = this.add
      .rectangle(0, 0, width, height, 0x000000, 0.9)
      .setOrigin(0)
      .setInteractive();
    const title = this.add
      .text(width / 2, height * 0.08, '🏛️ THE MUSEUM', {
        fontFamily: 'Arial Black',
        fontSize: 28,
        color: '#ffd700',
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScale(s);
    const list = this.add
      .text(width / 2, height * 0.48, 'excavating records…', {
        fontFamily: 'Arial',
        fontSize: 16,
        color: '#ffffff',
        align: 'left',
        lineSpacing: 7,
        wordWrap: { width: (width * 0.9) / s },
      })
      .setOrigin(0.5)
      .setScale(s);
    const close = this.add
      .text(width / 2, height * 0.92, '✕ CLOSE', {
        fontFamily: 'Arial Black',
        fontSize: 22,
        color: '#ffffff',
        backgroundColor: '#333333',
        padding: { x: 18, y: 8 },
      })
      .setOrigin(0.5)
      .setScale(s)
      .setInteractive({ useHandCursor: true })
      .once('pointerdown', () => {
        for (const obj of this.museumGroup) obj.destroy();
        this.museumGroup = [];
      });
    this.museumGroup = [dim, title, list, close];

    // fit however many entries the space between title and close can hold
    const rowPx = (16 + 7) * 2 * s; // two lines + spacing per find, scaled
    const maxEntries = Math.max(4, Math.min(14, Math.floor((height * 0.72) / rowPx)));

    void (async () => {
      try {
        const response = await fetch('/api/museum');
        if (!response.ok) throw new Error('museum fetch failed');
        const data = (await response.json()) as MuseumResponse;
        if (data.finds.length === 0 && data.legends.length === 0) {
          list.setText('nothing yet. the earth keeps its secrets…\nbreak more chests.');
          return;
        }
        const lines: string[] = [];
        if (data.legends.length > 0) {
          lines.push('⭐ HALL OF LEGENDS — carved forever:');
          for (const legend of data.legends.slice(0, 4)) {
            lines.push(`   ${legend.text}`);
          }
          lines.push('');
        }
        const findBudget = Math.max(3, maxEntries - Math.min(data.legends.length, 4) - 1);
        for (const f of data.finds.slice(0, findBudget)) {
          lines.push(
            `${f.emoji}  ${f.name}  ·  ${f.rarity.toUpperCase()}\n      found by u/${f.finder} at ${(f.depthCm / 100).toFixed(1)}m`
          );
        }
        list.setText(lines.join('\n'));
      } catch {
        list.setText('the museum is closed for renovations.');
      }
    })();
  }

  maybeLore() {
    const entry = LORE[this.loreIndex];
    if (!entry || this.runDepthCm < entry[0]) return;
    this.loreIndex += 1;

    const { width, height } = this.scale;
    const text = this.add
      .text(width / 2, height * 0.47, entry[1], {
        fontFamily: 'Georgia, serif',
        fontSize: 22,
        color: '#e8e0c8',
        stroke: '#000000',
        strokeThickness: 6,
        align: 'center',
        wordWrap: { width: width * 0.8 },
      })
      .setOrigin(0.5)
      .setAlpha(0);
    this.tweens.add({ targets: text, alpha: 1, duration: 800 });
    this.tweens.add({
      targets: text,
      alpha: 0,
      y: text.y - 24,
      delay: 2800,
      duration: 900,
      onComplete: () => text.destroy(),
    });
  }

  /** Gas escaping — bandpassed noise, longer and nastier than a crunch. */
  hiss() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const dur = 0.5;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 3800;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0.3;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
  }

  // ------------------------------------------------------------------
  // LIVE LAYER — see everyone else dig, as it happens
  // ------------------------------------------------------------------

  connectLive(postId: string) {
    try {
      connectRealtime<LiveEvent>({
        channel: liveChannel(postId),
        onMessage: (event) => this.handleLive(event),
      });
    } catch (error) {
      console.error('realtime connect failed (poll fallback active):', error);
    }
  }

  handleLive(event: LiveEvent) {
    if (event.kind === 'dig') {
      if (event.uid === this.uid) return;
      this.animateDepthTo(event.depthCm, 700);
      const now = this.time.now;
      if (now - this.lastPeerToastMs > 4000) {
        this.lastPeerToastMs = now;
        this.peerToast(`⛏️ u/${event.user} is digging…`, '#c9c9c9');
      }
    } else if (event.kind === 'goldrush') {
      if (this.rush) return; // already celebrating — ignore redelivered events
      this.rush = true;
      this.refreshHud();
      this.cameras.main.flash(400, 255, 215, 0);
      this.chime('legendary');
      const { width, height } = this.scale;
      const banner = this.add
        .text(width / 2, height * 0.45, `⚡ GOLD RUSH! ⚡\n2× grit until midnight`, {
          fontFamily: 'Arial Black',
          fontSize: 36,
          color: '#ffd700',
          stroke: '#000000',
          strokeThickness: 8,
          align: 'center',
        })
        .setOrigin(0.5);
      banner.setScale(Math.min(1, (width * 0.94) / banner.width) * 0);
      this.tweens.add({
        targets: banner,
        scale: Math.min(1, (width * 0.94) / banner.width),
        duration: 350,
        ease: 'Back.easeOut',
        onComplete: () => {
          this.time.delayedCall(2200, () =>
            this.tweens.add({
              targets: banner,
              alpha: 0,
              y: banner.y - 60,
              duration: 400,
              onComplete: () => banner.destroy(),
            })
          );
        },
      });
      this.peerToast(`⚡ u/${event.by} broke today's community goal!`, '#ffd700');
    } else if (event.kind === 'canary') {
      this.canaryFedAtMs = Date.now();
      this.applyCanaryState();
      this.peerToast(`🐤 u/${event.by} revived ${CANARY_NAME}! The mine sings again.`, '#ffe066');
      this.chirpChirp();
    } else if (event.kind === 'find') {
      if ((event.find.finderUid ?? event.find.finder) === this.uid) return;
      const meters = (event.find.depthCm / 100).toFixed(0);
      this.peerToast(
        `${event.find.emoji} u/${event.find.finder} found ${event.find.rarity.toUpperCase()} ${event.find.name} at ${meters}m!`,
        RARITY_COLORS[event.find.rarity]
      );
      if (event.find.rarity === 'epic' || event.find.rarity === 'legendary') {
        this.chime(event.find.rarity);
      }
    } else if (event.kind === 'milestone') {
      const { width, height } = this.scale;
      this.cameras.main.flash(400, 255, 215, 0);
      this.chime('legendary');
      const banner = this.add
        .text(width / 2, height * 0.45, `🎉 ${event.meters} METERS! 🎉`, {
          fontFamily: 'Arial Black',
          fontSize: 44,
          color: '#ffd700',
          stroke: '#000000',
          strokeThickness: 9,
        })
        .setOrigin(0.5);
      const bannerFit = Math.min(1, (width * 0.94) / banner.width);
      banner.setScale(0);
      this.tweens.add({
        targets: banner,
        scale: bannerFit,
        duration: 350,
        ease: 'Back.easeOut',
        onComplete: () => {
          this.time.delayedCall(1800, () =>
            this.tweens.add({
              targets: banner,
              alpha: 0,
              y: banner.y - 60,
              duration: 400,
              onComplete: () => banner.destroy(),
            })
          );
        },
      });
    }
  }

  /** Small event toast on the left edge — the "other people are here" ticker. */
  peerToast(message: string, color: string) {
    const { height } = this.scale;
    const t = this.add
      .text(12, height * 0.82, message, {
        fontFamily: 'Arial',
        fontSize: 16,
        color,
        stroke: '#000000',
        strokeThickness: 4,
        wordWrap: { width: this.scale.width * 0.7 },
      })
      .setOrigin(0, 1)
      .setAlpha(0);
    this.tweens.add({ targets: t, alpha: 0.95, duration: 200 });
    this.tweens.add({
      targets: t,
      y: t.y - 34,
      alpha: 0,
      delay: 2600,
      duration: 500,
      onComplete: () => t.destroy(),
    });
  }

  // ------------------------------------------------------------------
  // NETWORK
  // ------------------------------------------------------------------

  async flush() {
    if (this.pendingTaps === 0 && this.pendingBreaks === 0 && this.pendingChests === 0) return;
    const taps = Math.min(this.pendingTaps, MAX_TAPS_PER_BATCH);
    const breaks = Math.min(this.pendingBreaks, MAX_TAPS_PER_BATCH);
    // send earned cm in full, up to the honest ceiling the server enforces
    const cm = Math.min(this.pendingCm, taps * MAX_MULT + breaks * MAX_BREAK_BONUS_CM);
    const chests = Math.min(this.pendingChests, 3);
    this.pendingTaps -= taps;
    this.pendingBreaks -= breaks;
    this.pendingCm = Math.max(0, this.pendingCm - cm);
    this.pendingChests -= chests;
    try {
      const response = await fetch('/api/dig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taps, cm, breaks, chests }),
      });
      if (!response.ok) throw new Error(`API error: ${response.status}`);
      const data = (await response.json()) as DigResponse;
      this.holeDepthCm = Math.max(this.holeDepthCm, data.holeDepthCm);
      this.yourDigsCm = Math.max(this.yourDigsCm, data.yourDigsCm);
      this.diggers = data.diggers;
      this.grit = data.grit;
      this.canaryFedAtMs = data.canaryFedAtMs;
      this.dayCm = data.dayCm;
      this.rush = data.rush;
      this.applyCanaryState();
      this.refreshHud();
      for (const find of data.finds) this.findQueue.push(find);
      this.maybeShowFind();
    } catch (error) {
      console.error('Failed to send digs:', error);
      this.pendingTaps += taps;
      this.pendingBreaks += breaks;
      this.pendingCm += cm;
      this.pendingChests += chests;
    }
    if (this.pendingTaps > 0 || this.pendingBreaks > 0 || this.pendingChests > 0) {
      this.flushTimer?.remove();
      this.flushTimer = this.time.delayedCall(FLUSH_MS, () => void this.flush());
    }
  }

  /** The single owner of animated depth updates — new animations kill old ones. */
  animateDepthTo(target: number, duration: number) {
    if (target <= this.holeDepthCm) return;
    this.holeDepthCm = target;
    this.depthTween?.stop();
    this.depthTween = this.tweens.addCounter({
      from: this.displayedDepthCm,
      to: target,
      duration,
      ease: 'Cubic.easeOut',
      onUpdate: (tw) => {
        this.displayedDepthCm = Math.floor(tw.getValue() ?? target);
        this.refreshHud();
      },
      onComplete: () => {
        this.depthTween = null;
      },
    });
  }

  async sync() {
    if (this.pendingTaps > 0) return;
    try {
      const response = await fetch('/api/init');
      if (!response.ok) return;
      const data = (await response.json()) as InitResponse;
      this.animateDepthTo(data.holeDepthCm, 900);
      this.canaryFedAtMs = data.canaryFedAtMs;
      this.applyCanaryState();
    } catch {
      /* best-effort */
    }
  }

  // ------------------------------------------------------------------
  // FINDS
  // ------------------------------------------------------------------

  maybeShowFind() {
    if (this.showingFind) return;
    const find = this.findQueue.shift();
    if (!find) return;
    this.showingFind = true;

    const { width, height } = this.scale;
    const color = RARITY_COLORS[find.rarity];
    const isBig = find.rarity !== 'common';

    if (isBig) {
      this.cameras.main.flash(220, 255, 255, 255);
      this.cameras.main.shake(150, 0.008);
      // Pip gets excited about treasure too
      if (this.canaryState() !== 'faint') {
        this.tweens.add({
          targets: this.canaryImg,
          y: '-=12',
          yoyo: true,
          duration: 120,
          repeat: 3,
          ease: 'Quad.easeOut',
        });
      }
    }
    this.chime(find.rarity);

    const emoji = this.add
      .text(width / 2, height * 0.62, find.emoji, { fontSize: 88 })
      .setOrigin(0.5)
      .setScale(0);
    const label = this.add
      .text(width / 2, height * 0.74, `${find.rarity.toUpperCase()}!  ${find.name}`, {
        fontFamily: 'Arial Black',
        fontSize: 26,
        color,
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setAlpha(0);
    // long names on narrow screens: shrink to fit instead of clipping
    label.setScale(Math.min(1, (width * 0.94) / label.width));

    this.tweens.add({
      targets: emoji,
      scale: { from: 0, to: 1 },
      angle: { from: -12, to: 0 },
      duration: 320,
      ease: 'Back.easeOut',
    });
    this.tweens.add({ targets: label, alpha: 1, duration: 250, delay: 120 });

    // a backed-up queue drains fast so celebrations stay near their moment
    const backlog = Math.min(this.findQueue.length, 3);
    const hold = (isBig ? 1900 : 1200) / (1 + backlog * 0.7);
    this.time.delayedCall(hold, () => {
      this.tweens.add({
        targets: [emoji, label],
        alpha: 0,
        y: '-=40',
        duration: 300,
        onComplete: () => {
          emoji.destroy();
          label.destroy();
          this.showingFind = false;
          this.maybeShowFind();
        },
      });
    });
  }

  // ------------------------------------------------------------------
  // SMALL HELPERS
  // ------------------------------------------------------------------

  floatText(x: number, y: number, message: string, color: string, size: number) {
    const t = this.add
      .text(x, y, message, {
        fontFamily: 'Arial Black',
        fontSize: size,
        color,
        stroke: '#000000',
        strokeThickness: 6,
      })
      .setOrigin(0.5);
    t.setScale(Math.min(1, (this.scale.width * 0.94) / t.width));
    this.tweens.add({
      targets: t,
      y: y - 70,
      alpha: { from: 1, to: 0 },
      duration: 850,
      ease: 'Quad.easeOut',
      onComplete: () => t.destroy(),
    });
  }

  swingPickaxe(x: number, y: number) {
    let axe = this.pickaxePool.pop();
    if (!axe) {
      axe = this.add.text(0, 0, '⛏️', { fontSize: 46 }).setOrigin(0.8, 0.8);
    }
    axe.setPosition(x + 26, y - 22)
      .setAlpha(1)
      .setAngle(-70)
      .setVisible(true);
    this.tweens.add({
      targets: axe,
      angle: 15,
      duration: 90,
      ease: 'Quad.easeIn',
      onComplete: () => {
        this.tweens.add({
          targets: axe,
          alpha: 0,
          duration: 140,
          onComplete: () => {
            axe!.setVisible(false);
            this.pickaxePool.push(axe!);
          },
        });
      },
    });
  }

  impactRing(x: number, y: number) {
    const ring = this.add.circle(x, y, 6).setStrokeStyle(3, 0xffffff, 0.8);
    this.tweens.add({
      targets: ring,
      radius: 34,
      alpha: 0,
      duration: 220,
      ease: 'Quad.easeOut',
      onComplete: () => ring.destroy(),
    });
  }

  // ------------------------------------------------------------------
  // HUD & RULER
  // ------------------------------------------------------------------

  refreshHud() {
    const { width, height } = this.scale;
    this.depthText.setText(`${(this.displayedDepthCm / 100).toFixed(2)} m`);
    const mine =
      this.yourDigsCm >= 100
        ? `${(this.yourDigsCm / 100).toFixed(1)}m`
        : `${this.yourDigsCm}cm`;
    this.yourText.setText(
      this.rush
        ? `you: ${mine}  ·  ⚡ GOLD RUSH — 2× grit!`
        : `you: ${mine}  ·  today's goal: ${(this.dayCm / 100).toFixed(0)}/${DAILY_GOAL_CM / 100}m`
    );
    this.yourText.setColor(this.rush ? '#ffd700' : '#ffffff');
    this.diggersText.setText(
      this.diggers > 1 ? `🟢 ${this.diggers} digging now` : '🟢 you are digging'
    );
    this.gritText.setText(`🪙 ${this.grit}`);
    const beyondPB = this.bestRunCm > 0 && this.runDepthCm > this.bestRunCm;
    const bestPart =
      this.bestRunCm > 0 ? `  ·  best ${(this.bestRunCm / 100).toFixed(1)}m` : '';
    this.runText.setText(
      this.running
        ? `⛏️ run: ${(this.runDepthCm / 100).toFixed(1)}m${beyondPB ? '  🏆' : bestPart}`
        : ''
    );
    this.runText.setColor(beyondPB ? '#ffd700' : '#ffffff');
    this.drawHudPanel();

    this.wall.tilePositionY = this.displayedDepthCm * PX_PER_CM * 0.4;

    const cur = this.currentStratum();
    this.wall.setTint(this.brighten(cur.color));
    if (this.stratumText.text !== cur.name) {
      this.stratumText.setText(cur.name);
      if (this.hasDug) this.cameras.main.flash(300, 255, 255, 255);
      // repaint visible tiles into the new stratum's palette
      for (const tiles of this.rows.values()) {
        for (const tile of tiles) this.paintTile(tile);
      }
    }
    this.stratumText.setColor(cur.textColor);

    const pxPerMeter = 100 * PX_PER_CM;
    const centerY = height * 0.5;
    const currentMeter = this.displayedDepthCm / 100;
    const first = Math.ceil(currentMeter - centerY / pxPerMeter);
    for (let i = 0; i < this.rulerMarks.length; i++) {
      const meter = first + i;
      const mark = this.rulerMarks[i]!;
      if (meter < 0) {
        mark.line.setVisible(false);
        mark.label.setVisible(false);
        continue;
      }
      const y = centerY + (meter - currentMeter) * pxPerMeter;
      // never let ruler marks wander into the HUD zone up top
      if (y < height * 0.13 || y > height + 20) {
        mark.line.setVisible(false);
        mark.label.setVisible(false);
        continue;
      }
      mark.line.setVisible(true).setPosition(width - 88, y);
      mark.label
        .setVisible(true)
        .setText(`${meter} m`)
        .setPosition(width - 56, y);
    }
  }

  brighten(color: number): number {
    const r = Math.min(((color >> 16) & 0xff) * 1.9, 255);
    const g = Math.min(((color >> 8) & 0xff) * 1.9, 255);
    const b = Math.min((color & 0xff) * 1.9, 255);
    return (r << 16) | (g << 8) | b;
  }

  updateLayout(width: number, height: number) {
    this.cameras.resize(width, height);
    this.wall.setSize(width, height);
    this.vignette
      .setPosition(width / 2, height / 2)
      .setDisplaySize(width * 1.35, height * 1.35);

    // re-fit the tile grid; if tile size changed, respawn the seeded world at the new size
    const prevTile = this.tileSize;
    this.computeGrid(width, height);
    if (this.tileSize !== prevTile) {
      this.rebuildWorld();
    } else {
      this.worldC.setPosition(this.gridX, this.anchorY - this.activeRow * this.tileSize);
    }
    this.rowFrame
      .setPosition(this.gridX, this.anchorY)
      .setSize(COLS * this.tileSize, this.tileSize);
    this.canaryC.setPosition(Math.max(30, this.gridX + 26), this.anchorY - 22);

    // any open overlays are position-stale — close them (they're one tap to reopen)
    if (this.shopGroup.length > 0) {
      for (const obj of this.shopGroup) obj.destroy();
      this.shopGroup = [];
    }
    if (this.museumGroup.length > 0) {
      for (const obj of this.museumGroup) obj.destroy();
      this.museumGroup = [];
    }
    if (this.lbGroup.length > 0) {
      for (const obj of this.lbGroup) obj.destroy();
      this.lbGroup = [];
    }
    if (this.helpGroup.length > 0) {
      for (const obj of this.helpGroup) obj.destroy();
      this.helpGroup = [];
    }
    if (this.coachGroup.length > 0) {
      for (const obj of this.coachGroup) obj.destroy();
      this.coachGroup = [];
      this.showCoach(); // rebuild at the new size
    }
    this.clearOnboarding();

    // HUD scale: readable on a phone, not comically large on a desktop
    const scaleFactor = Phaser.Math.Clamp(
      Math.min(width / 1024, height / 768) * 1.15,
      0.58,
      1.05
    );
    this.hudScale = scaleFactor;

    this.diggersText.setPosition(10, height * 0.028).setScale(scaleFactor);
    this.gritText.setPosition(10, height * 0.062).setScale(scaleFactor);
    this.o2BarBg.setPosition(width - 146, height * 0.028).setScale(scaleFactor);
    this.o2BarFill.setPosition(width - 144, height * 0.028).setScale(scaleFactor);
    this.o2Label.setPosition(width - 152, height * 0.028).setScale(scaleFactor);
    this.museumBtn.setPosition(width - 12, height * 0.068).setScale(scaleFactor);
    this.shopBtn.setPosition(width - 58, height * 0.068).setScale(scaleFactor);
    this.lbBtn.setPosition(width - 104, height * 0.068).setScale(scaleFactor);
    this.fsBtn.setPosition(width - 150, height * 0.068).setScale(scaleFactor);
    this.muteBtn.setPosition(width - 192, height * 0.068).setScale(scaleFactor);
    this.helpBtn.setPosition(width - 234, height * 0.068).setScale(scaleFactor);

    // HUD backing panel hugs the depth block (drawn in drawHudPanel)
    this.lastPanelW = 0;
    this.drawHudPanel();

    // ambient dust motes drifting up through the shaft
    this.dust?.destroy();
    this.dust = this.add.particles(0, 0, 'dirtpx', {
      x: { min: 0, max: width },
      y: height + 8,
      lifespan: 7000,
      speedY: { min: -10, max: -26 },
      speedX: { min: -5, max: 5 },
      scale: { start: 0.5, end: 0.15 },
      alpha: { start: 0.15, end: 0 },
      quantity: 1,
      frequency: 480,
      tint: 0xfff3d6,
    });

    // the death screen is state, not decoration — rebuild it at the new size
    if (!this.running && this.blackoutGroup.length > 0) {
      for (const obj of this.blackoutGroup) obj.destroy();
      this.deathUI(true);
    }
    // compact HUD column above the action row
    this.depthLabel.setPosition(width / 2, height * 0.045).setScale(scaleFactor * 0.85);
    this.depthText.setPosition(width / 2, height * 0.105).setScale(scaleFactor);
    this.stratumText.setPosition(width / 2, height * 0.165).setScale(scaleFactor * 0.9);
    this.comboText.setPosition(width / 2, height * 0.222).setScale(scaleFactor);
    this.runText.setPosition(width / 2, height * 0.248).setScale(scaleFactor * 0.95);
    this.yourText.setPosition(width / 2, height * 0.965).setScale(scaleFactor);
    this.hintText.setPosition(width / 2, this.anchorY - 20 * scaleFactor).setScale(scaleFactor);
    this.refreshHud();
  }

  // ------------------------------------------------------------------
  // SOUND (WebAudio, zero asset files)
  // ------------------------------------------------------------------

  ensureAudio(): AudioContext | undefined {
    if (this.muted) return undefined;
    try {
      if (!this.audioCtx) {
        type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
        const Ctor = window.AudioContext ?? (window as AudioWindow).webkitAudioContext;
        if (!Ctor) return undefined;
        this.audioCtx = new Ctor();
      }
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      return this.audioCtx;
    } catch {
      return undefined;
    }
  }

  crunch() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const dur = 0.07;
    const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900 + Math.random() * 500;
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start();
  }

  thud() {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    const t = ctx.currentTime;
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.18);
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  chime(rarity: string) {
    const ctx = this.ensureAudio();
    if (!ctx) return;
    const notes: Record<string, number[]> = {
      common: [523],
      uncommon: [523, 659],
      rare: [523, 659, 784],
      epic: [523, 659, 784, 1047],
      legendary: [523, 659, 784, 1047, 1319],
    };
    (notes[rarity] ?? notes.common!).forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.09;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }
}
