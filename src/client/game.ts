import { Boot } from './scenes/Boot';
import { Game as MainGame } from './scenes/Game';
import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';

/**
 * High-DPI: Phaser's RESIZE mode renders the canvas at CSS pixels, which the
 * browser then upscales on high-density phones → blur. Instead we run in NONE
 * mode and size the canvas backing store at CSS × devicePixelRatio (crisp),
 * while keeping the CSS display size at the parent size. Each scene renders its
 * logical (CSS-sized) layout through a camera zoomed by the same ratio, so all
 * the layout code stays in CSS coordinates.
 */
export const UI_DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#120d08',
  input: {
    // two-thumb drumming on mobile needs headroom beyond the default 2 pointers
    activePointers: 4,
  },
  scale: {
    mode: Phaser.Scale.NONE,
    width: 1024,
    height: 768,
  },
  scene: [Boot, MainGame],
};

const StartGame = (parent: string) => new Game({ ...config, parent });

document.addEventListener('DOMContentLoaded', () => {
  const game = StartGame('game-container');
  const host = document.getElementById('game-container');

  const applySize = () => {
    const w = Math.max(1, host?.clientWidth || window.innerWidth || 1);
    const h = Math.max(1, host?.clientHeight || window.innerHeight || 1);
    // backing store at device resolution…
    game.scale.resize(Math.round(w * UI_DPR), Math.round(h * UI_DPR));
    // …but displayed at CSS size
    if (game.canvas) {
      game.canvas.style.width = `${w}px`;
      game.canvas.style.height = `${h}px`;
    }
  };

  game.events.once('ready', applySize);
  window.addEventListener('resize', applySize);
  // some webviews settle their size a beat after load
  setTimeout(applySize, 60);
  setTimeout(applySize, 400);
});
