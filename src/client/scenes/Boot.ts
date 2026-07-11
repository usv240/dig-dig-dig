import { Scene } from 'phaser';

export class Boot extends Scene {
  constructor() {
    super('Boot');
  }

  create() {
    // every texture in this game is generated in code — nothing to preload
    this.scene.start('Game');
  }
}
