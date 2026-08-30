// Persisted settings with a safe merge — a corrupt or outdated blob can never
// break a boot, it just falls back to defaults field by field.

const KEY = 'blacksite.settings.v1';

export const DEFAULTS = {
  sensitivity: 0.22,       // shown to the player as 0.05 - 1.50
  adsSensScale: 0.72,
  invertY: false,
  fov: 92,
  adsFovScale: 0.74,
  volumeMaster: 0.8,
  volumeSfx: 1.0,
  volumeMusic: 0.35,
  quality: 'high',         // low | medium | high | ultra
  bloom: true,
  motionBlur: false,
  filmGrain: true,
  chromaticAberration: true,
  vignette: true,
  showFps: false,
  crosshairStyle: 'dynamic',
  crosshairColor: '#4ff2c8',
  viewBob: 1.0,
  cameraShake: 1.0,
  weaponSway: 1.0,
  hitmarkers: true,
  damageNumbers: true,
  difficulty: 'regular',   // recruit | regular | veteran | elite
  toggleAds: false,
  toggleCrouch: false,
  autoSprint: false,
};

function isSameShape(a, b) {
  return typeof a === typeof b && Array.isArray(a) === Array.isArray(b);
}

export function loadSettings() {
  const out = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return out;
    for (const k of Object.keys(DEFAULTS)) {
      if (k in parsed && isSameShape(parsed[k], DEFAULTS[k])) out[k] = parsed[k];
    }
  } catch { /* storage blocked or corrupt — defaults are fine */ }
  return out;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

export const QUALITY = {
  low: { shadowMap: 1024, shadows: false, pixelRatio: 0.75, bloom: false, smaa: false, particles: 0.35, decals: 40, envRes: 128, lightCount: 6 },
  medium: { shadowMap: 1536, shadows: true, pixelRatio: 1.0, bloom: true, smaa: false, particles: 0.7, decals: 90, envRes: 256, lightCount: 12 },
  high: { shadowMap: 2048, shadows: true, pixelRatio: 1.0, bloom: true, smaa: true, particles: 1.0, decals: 160, envRes: 256, lightCount: 20 },
  ultra: { shadowMap: 4096, shadows: true, pixelRatio: 1.35, bloom: true, smaa: true, particles: 1.5, decals: 256, envRes: 512, lightCount: 32 },
};
