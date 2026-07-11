import { Boot } from './scenes/Boot';
import { Game as MainGame } from './scenes/Game';
import * as Phaser from 'phaser';
import { AUTO, Game } from 'phaser';

const config: Phaser.Types.Core.GameConfig = {
  type: AUTO,
  parent: 'game-container',
  backgroundColor: '#120d08',
  input: {
    // two-thumb drumming on mobile needs headroom beyond the default 2 pointers
    activePointers: 4,
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: 1024,
    height: 768,
  },
  scene: [Boot, MainGame],
};

const StartGame = (parent: string) => {
  return new Game({ ...config, parent });
};

document.addEventListener('DOMContentLoaded', () => {
  StartGame('game-container');
});
