// Entry point. Boots the game and surfaces any fatal error as readable text
// instead of a black screen.

import { Game } from './game.js';

function fatal(message, detail) {
  const el = document.createElement('div');
  el.className = 'fatal';
  el.innerHTML = `
    <div class="fatal-panel">
      <h1>UNABLE TO START</h1>
      <p>${message}</p>
      ${detail ? `<pre>${String(detail).slice(0, 900)}</pre>` : ''}
      <p class="fatal-hint">This game needs a browser with WebGL 2. Try a recent Chrome, Edge, Firefox or Safari, and make sure hardware acceleration is enabled.</p>
    </div>`;
  document.body.appendChild(el);
}

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGL2RenderingContext && c.getContext('webgl2'));
  } catch { return false; }
}

async function main() {
  const canvas = document.getElementById('viewport');
  const ui = document.getElementById('ui');
  if (!canvas || !ui) return fatal('The page did not load correctly.');
  if (!hasWebGL2()) return fatal('WebGL 2 is not available in this browser.');

  let game;
  try {
    game = new Game(canvas, ui);
    window.__game = game;   // handy for debugging from the console
  } catch (err) {
    console.error(err);
    return fatal('The renderer failed to initialise.', err?.stack || err);
  }

  try {
    await game.boot();
  } catch (err) {
    console.error(err);
    return fatal('Startup failed while preparing assets.', err?.stack || err);
  }

  // A crash mid-match should pause rather than spin at 0 fps.
  window.addEventListener('error', (e) => {
    console.error('runtime error', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled rejection', e.reason);
  });
}

main();
