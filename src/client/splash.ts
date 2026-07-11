import { requestExpandedMode } from '@devvit/web/client';
import type { InitResponse } from '../shared/api';
import { CANARY_NAME, canaryStateFor } from '../shared/api';

const digButton = document.getElementById('dig-button') as HTMLButtonElement;
const depthEl = document.getElementById('depth') as HTMLDivElement;
const diggersEl = document.getElementById('diggers') as HTMLDivElement;
const whisperEl = document.getElementById('whisper') as HTMLParagraphElement;
const canaryEl = document.getElementById('canary') as HTMLParagraphElement;
const historyEl = document.getElementById('history') as HTMLParagraphElement;

digButton.addEventListener('click', (e) => {
  requestExpandedMode(e, 'game');
});

const WHISPERS = [
  'something is down there.',
  'the dirt remembers every tap.',
  'today’s mine resets at midnight.',
  'they say there’s a door at 60m.',
  'do NOT trust the worms.',
];

async function init() {
  whisperEl.textContent = WHISPERS[Math.floor(Math.random() * WHISPERS.length)] ?? WHISPERS[0]!;
  try {
    const response = await fetch('/api/init');
    if (!response.ok) throw new Error(`API ${response.status}`);
    const data = (await response.json()) as InitResponse;
    depthEl.textContent = `${(data.holeDepthCm / 100).toFixed(2)} m`;
    diggersEl.textContent = data.diggers > 1 ? `${data.diggers} ⛏️` : 'be first ⛏️';
    if (data.allTimeDiggers > 0 || data.allTimeFinds > 0) {
      historyEl.textContent = `⛏️ ${data.allTimeDiggers.toLocaleString()} diggers · 💎 ${data.allTimeFinds.toLocaleString()} treasures unearthed`;
    }
    const hours = (Date.now() - data.canaryFedAtMs) / 3_600_000;
    const state = canaryStateFor(hours);
    if (state === 'happy') {
      canaryEl.textContent = `🐤 ${CANARY_NAME} the canary is chirping`;
    } else if (state === 'hungry') {
      canaryEl.textContent = `🐤 ${CANARY_NAME} is hungry — ${Math.floor(hours)}h since the last dig`;
      canaryEl.classList.add('alert');
    } else {
      canaryEl.textContent = `🚨 ${CANARY_NAME} FAINTED — dig to revive!`;
      canaryEl.classList.add('alert');
    }
  } catch {
    depthEl.textContent = '? m';
    diggersEl.textContent = '⛏️';
    canaryEl.textContent = '';
  }
}

void init();
