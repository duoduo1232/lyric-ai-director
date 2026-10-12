// mods/lyric-ai-director/client.mjs
//
// Renderer half of "AI 歌词动画导演". It owns everything the user can see and
// everything that changes the player:
//
//   1. a settings section in the mods panel (plus commands in the command
//      palette) that asks the AI for a decision and applies it;
//   2. a player-panel tab showing the last decision and applying it per song;
//   3. the actual writes: `internals.stores.visualizerSettings`, i.e. the very
//      store the builtin settings UI writes. The mode goes through
//      `handleSetVisualizerMode`, each mode's params through its
//      `handleSet<T>Tuning` action — same clamping, same localStorage keys, so
//      AI decisions behave exactly like manual edits and ride into exports.
//
// `folium.internals` is used deliberately, and is why mod.json pins `folia`:
// the stable registries cannot switch a builtin mode or set its native tuning
// (a mod's `tunings` entry owns its own multiplier values, not the user's).
// Everything read through it is read-only and listed in the README:
//   - stores.visualizerSettings — read + write (the write surface);
//   - stores.playback           — read the displayed song and its lyrics;
//   - visualizerRegistry        — the live mode list;
//   - omni.getLyrics            — lyrics for a queued song (prefetch);
//   - localStorage 'player_loop_mode' — whether the queue wraps around.
// Every access is feature-detected, so a host that reshapes the store degrades
// to a clear message instead of a broken player.

const MODE_HINTS = {
  still: '只有歌词文字，几乎无动画',
  classic: '逐字发光、旋转与呼吸浮动，均衡通用',
  cadenza: '大字心象、光晕与光束，情绪外放',
  partita: '分栏排版、阶梯式入场，叙事感强',
  fume: '纸张印刷质感、镜头缓慢推拉',
  cappella: '群聊气泡、表情与头像，轻松俏皮',
  tilt: '文字倾斜、裂开与换色，躁动感强',
  claddagh: '环形排布、绕环流转，浪漫',
  monet: '油画质感的歌词栏、缓慢滚动',
  diorama: '点云三维场景、镜头飞行，空间感强',
  pendolo: '钟表机械、指针与齿轮',
  sonnet: '日式 MV 分镜、相机运动与转场，电影感强',
  tempera: '印刷色块与拼贴、逐字入场',
  lumiere: '光场与烟雾、辉光崩解，华丽',
};

/* 商籁的 11 个倍率（cameraScale…transitionGlitchScale）不在这份决策契约里：
 * 它们是宿主的 `foliumTunables`，由 `registries.tunings` 的参数存储消费，而平台
 * 只把写入能力交给设置卡片自身（模组拿到的句柄只有 `{ id, unregister }`）。AI
 * 改用同一模式的原生参数（cameraIntensity / typographyMotion / mgDensity …）
 * 表达同等观感。 */

/* Per-mode parameter space the AI may touch: key -> spec. Ranges mirror what the
 * host's own setters clamp to (useVisualizerSettingsStore + the mode's settings
 * panel), so a decision can never land outside what the sliders can express.
 * Cadenza is the exception: it has no settings panel and its setter only merges,
 * so those four ranges are our own sane bounds, not the host's. */
const MODE_PARAMS = {
  classic: {
    setter: 'handleSetClassicTuning',
    params: {
      enableWordRotation: { kind: 'boolean', zh: '逐字旋转' },
      breathingFloatMultiplier: { kind: 'number', min: 0, max: 2, zh: '呼吸浮动' },
      wordSpacing: { kind: 'number', min: 0, max: 2, zh: '词间距' },
      useLegacyLayout: { kind: 'boolean', zh: '旧版排版' },
    },
  },
  cadenza: {
    setter: 'handleSetCadenzaTuning',
    // 心象没有设置面板，宿主 setter 只做 {...prev, ...patch} 合并（无 clamp），
    // 这里的范围是模组自定的合理区间；每次写入宿主都会把 beamIntensity 归零。
    params: {
      fontScale: { kind: 'number', min: 0.6, max: 2, zh: '字号' },
      widthRatio: { kind: 'number', min: 0.3, max: 1, zh: '行宽占比' },
      motionAmount: { kind: 'number', min: 0, max: 2, zh: '运动量' },
      glowIntensity: { kind: 'number', min: 0, max: 2, zh: '光晕强度' },
    },
  },
  partita: {
    setter: 'handleSetPartitaTuning',
    params: {
      showGuideLines: { kind: 'boolean', zh: '参考线' },
      useSemanticLayout: { kind: 'boolean', zh: '语义排版' },
      staggerMin: { kind: 'number', min: 0, max: 180, zh: '入场错开下限' },
      staggerMax: { kind: 'number', min: 0, max: 180, zh: '入场错开上限' },
    },
  },
  fume: {
    setter: 'handleSetFumeTuning',
    params: {
      hidePrintSymbols: { kind: 'boolean', zh: '隐藏印刷符号' },
      disableGeometricBackground: { kind: 'boolean', zh: '关闭几何背景' },
      backgroundObjectOpacity: { kind: 'number', min: 0, max: 1, zh: '背景元素不透明度' },
      textHoldRatio: { kind: 'number', min: 0, max: 1, zh: '文字停留比例' },
      cameraTrackingMode: { kind: 'select', options: ['stepped', 'smooth'], zh: '镜头跟随' },
      cameraSpeed: { kind: 'number', min: 0.55, max: 1.85, zh: '镜头速度' },
      glowIntensity: { kind: 'number', min: 0, max: 1.8, zh: '辉光强度' },
      heroScale: { kind: 'number', min: 0.82, max: 1.32, zh: '主字缩放' },
    },
  },
  claddagh: {
    setter: 'handleSetCladdaghTuning',
    params: {
      focusScaleRatio: { kind: 'number', min: 0, max: 1.5, zh: '聚焦缩放' },
      radiusScale: { kind: 'number', min: 0.5, max: 1.5, zh: '环半径' },
      ellipseTiltDeg: { kind: 'number', min: 0, max: 60, zh: '环倾角' },
      showAxisLine: { kind: 'boolean', zh: '轴线' },
      letterSpacingOffset: { kind: 'number', min: -5, max: 20, zh: '字距偏移' },
    },
  },
  cappella: {
    setter: 'handleSetCappellaTuning',
    params: {
      showEmoMessages: { kind: 'boolean', zh: '表情消息' },
      emojiPackSource: { kind: 'select', options: ['builtin', 'custom'], zh: '表情包来源' },
      avatarSource: { kind: 'select', options: ['builtin', 'cover', 'color', 'custom'], zh: '头像来源' },
    },
  },
  tilt: {
    setter: 'handleSetTiltTuning',
    params: {
      splitProbability: { kind: 'number', min: 0, max: 1, zh: '裂开概率' },
      tiltStyleProbability: { kind: 'number', min: 0, max: 1, zh: '倾斜样式概率' },
      colorScheme: { kind: 'select', options: ['default', 'swap', 'accentAll', 'primaryAll'], zh: '配色方案' },
    },
  },
  monet: {
    setter: 'handleSetMonetTuning',
    params: {
      keywordColoringEnabled: { kind: 'boolean', zh: '关键词着色' },
      audioStyle: { kind: 'select', options: ['bar', 'line'], zh: '音频样式' },
      showDescription: { kind: 'boolean', zh: '显示简介' },
      showAudioVisualization: { kind: 'boolean', zh: '音频可视化' },
      fontScale: { kind: 'number', min: 0.7, max: 1.5, zh: '字号' },
      portraitStyle: { kind: 'select', options: ['square', 'rectangular'], zh: '封面样式' },
    },
  },
  diorama: {
    setter: 'handleSetDioramaTuning',
    params: {
      cameraSpeed: { kind: 'number', min: 0.55, max: 1.85, zh: '镜头速度' },
      motionAmount: { kind: 'number', min: 0.4, max: 1.6, zh: '运动量' },
      audioReactivity: { kind: 'number', min: 0, max: 1.5, zh: '音频响应' },
      particleScale: { kind: 'number', min: 0.65, max: 1.6, zh: '粒子缩放' },
      showParticles: { kind: 'boolean', zh: '显示粒子' },
      glowEnabled: { kind: 'boolean', zh: '普通辉光跟唱' },
      glowIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '辉光强度' },
      soulEnabled: { kind: 'boolean', zh: '灵魂出窍跟唱' },
      soulIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '灵魂出窍强度' },
      gradientEnabled: { kind: 'boolean', zh: '渐变跟唱' },
      gradientIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '渐变强度' },
      keywordColoringEnabled: { kind: 'boolean', zh: '关键词着色' },
      soulActiveEnabled: { kind: 'boolean', zh: '当前字跟随漂移' },
      particleGlowEnabled: { kind: 'boolean', zh: '粒子光晕' },
      particleGlowIntensity: { kind: 'number', min: 0.1, max: 1.5, zh: '粒子光晕强度' },
    },
  },
  pendolo: {
    setter: 'handleSetPendoloTuning',
    params: {
      arcRadius: { kind: 'number', min: 0.25, max: 0.8, zh: '弧半径' },
      arcAngleDeg: { kind: 'number', min: 40, max: 160, zh: '弧角度' },
      tickSnappiness: { kind: 'number', min: 0.5, max: 2, zh: '走时干脆度' },
      activeScale: { kind: 'number', min: 1, max: 1.6, zh: '当前行缩放' },
      showGearDecor: { kind: 'select', options: ['none', 'subtle', 'full'], zh: '齿轮装饰' },
      showCenterGradient: { kind: 'boolean', zh: '中心渐变' },
      showCoverOnWatchFace: { kind: 'boolean', zh: '表盘显示封面' },
      enableLineGlow: { kind: 'boolean', zh: '行发光' },
    },
  },
  sonnet: {
    setter: 'handleSetSonnetTuning',
    params: {
      cameraIntensity: { kind: 'number', min: 0, max: 2, zh: '相机强度' },
      typographyMotion: { kind: 'number', min: 0, max: 2, zh: '字体运动' },
      mgDensity: { kind: 'number', min: 0, max: 2, zh: '动图密度' },
      showOnlyText: { kind: 'boolean', zh: '只显示文字' },
      showGuide: { kind: 'boolean', zh: '参考线' },
      showBackgroundMg: { kind: 'boolean', zh: '背景动图' },
      showFixedGeo: { kind: 'boolean', zh: '固定几何' },
      showGiantDecorativeText: { kind: 'boolean', zh: '巨型装饰字' },
      showBackgroundDecor: { kind: 'boolean', zh: '背景装饰' },
      enableTransitions: { kind: 'boolean', zh: '转场' },
      outerFrameMode: { kind: 'select', options: ['none', 'frame', 'full'], zh: '外框' },
      textureResolution: { kind: 'number', min: 0.5, max: 4, zh: '纹理分辨率' },
      postProcessEnabled: { kind: 'boolean', zh: '后处理总开关' },
      postProcessGrain: { kind: 'number', min: 0, max: 1, zh: '胶片颗粒' },
      postProcessContrast: { kind: 'number', min: 0, max: 1, zh: '对比度' },
      postProcessRgbShift: { kind: 'number', min: 0, max: 1, zh: 'RGB 偏移' },
      postProcessHalftone: { kind: 'number', min: 0, max: 1, zh: '半调网屏' },
      postProcessVignette: { kind: 'number', min: 0, max: 2, zh: '暗角' },
      postProcessLensDistortion: { kind: 'number', min: 0, max: 2, zh: '镜头畸变' },
      postProcessLensDispersion: { kind: 'number', min: 0, max: 1, zh: '镜头色散' },
    },
  },
  tempera: {
    setter: 'handleSetTemperaTuning',
    params: {
      cameraIntensity: { kind: 'number', min: 0, max: 2, zh: '相机强度' },
      glyphMotion: { kind: 'number', min: 0, max: 2, zh: '逐字入场' },
      wholeLineLyrics: { kind: 'boolean', zh: '整行不切分' },
      glyphSettleStretch: { kind: 'number', min: 0, max: 1, zh: '逐字入场时序' },
      colorMode: { kind: 'select', options: ['duo', 'mono', 'gradient'], zh: '配色模式' },
      showBlocks: { kind: 'boolean', zh: '色块' },
      showDecor: { kind: 'boolean', zh: '装饰' },
      showCornerMarks: { kind: 'boolean', zh: '角标' },
      textInversion: { kind: 'boolean', zh: '文字动态反色' },
      enableTransitions: { kind: 'boolean', zh: '转场' },
      textureResolution: { kind: 'number', min: 0.5, max: 4, zh: '纹理分辨率' },
      postProcessEnabled: { kind: 'boolean', zh: '后处理总开关' },
      postProcessGrain: { kind: 'number', min: 0, max: 1, zh: '颗粒' },
      postProcessContrast: { kind: 'number', min: 0, max: 1, zh: '对比度' },
      postProcessRgbShift: { kind: 'number', min: 0, max: 1, zh: 'RGB 偏移' },
      postProcessVignette: { kind: 'number', min: 0, max: 2, zh: '暗角' },
      postProcessLensDistortion: { kind: 'number', min: 0, max: 2, zh: '镜头畸变' },
    },
  },
  lumiere: {
    setter: 'handleSetLumiereTuning',
    params: {
      lightIntensity: { kind: 'number', min: 0.3, max: 2, zh: '光强' },
      audioResponse: { kind: 'number', min: 0, max: 2, zh: '随音乐变亮' },
      fogDensity: { kind: 'number', min: 0, max: 2, zh: '烟雾浓度' },
      fogOctaves: { kind: 'number', min: 2, max: 6, zh: '烟雾细节' },
      moteAmount: { kind: 'number', min: 0, max: 2, zh: '浮尘数量' },
      bloom: { kind: 'number', min: 0, max: 2, zh: '图形辉光' },
      textBloom: { kind: 'number', min: 0, max: 2, zh: '文字辉光' },
      unlitOpacity: { kind: 'number', min: 0.05, max: 0.6, zh: '未唱字透明度' },
      darkField: { kind: 'number', min: 0, max: 1, zh: '暗场强度' },
      decay: { kind: 'number', min: 0, max: 2, zh: '崩解强度' },
      echo: { kind: 'number', min: 0, max: 2, zh: '背景歌词亮度' },
      windowNeighbors: { kind: 'select', options: [1, 2], zh: '邻行数' },
      lineArt: { kind: 'boolean', zh: '线稿' },
      frontBokeh: { kind: 'boolean', zh: '前景散景' },
      trails: { kind: 'boolean', zh: '轨迹线' },
      seamlessTransitions: { kind: 'boolean', zh: '无缝转场' },
      overlayFrame: { kind: 'boolean', zh: '画框' },
      textOnly: { kind: 'boolean', zh: '仅歌词文字' },
      keywordColors: { kind: 'boolean', zh: '关键词着色' },
      themeIcons: { kind: 'boolean', zh: '主题图标' },
      themeColorMix: { kind: 'number', min: 0, max: 1, zh: '主题色占比' },
      renderQuality: { kind: 'select', options: ['full', 'balanced', 'low'], zh: '画质' },
    },
  },
  still: { setter: null, params: {} },
};

const T = (zh, en) => ({ 'zh-CN': zh, en });

/* Lyrics usually arrive a moment after the song does. The decision waits for the
 * `lyrics.loaded` event; this is only the fallback for tracks whose lyrics never
 * come (pure music, or a provider that has none). */
const LYRICS_WAIT_FALLBACK_MS = 4000;
const LYRICS_SETTLE_MS = 250;

/* Per-song memory bounds. The mod's data file is capped at 1 MB by the host, and
 * a write past the cap would silently kill every later one — so entries are kept
 * small (validated params only, clipped reason) and the least recently used ones
 * are dropped once the list grows past the limit. */
const MEMORY_ENTRY_LIMIT = 300;
const REASON_MAX_CHARS = 200;

/* runDecision outcomes that are not a summary string. Distinct values, so the
 * commands and the panel can tell "queued behind another decision" apart from
 * "the track changed under us and the answer went to that song's memory". */
const QUEUED = Symbol('queued');
const STALE = Symbol('stale');
const DISPOSED = Symbol('disposed');
/* Nothing is playing (the host emits `playback.songChanged` with `song: null` when
 * playback stops or hands off to the stage window): there is no song to judge, so
 * no request is sent and no answer is applied. */
const NO_SONG = Symbol('no-song');

/* `folium.internals` is a gated proxy: in the export window (or without a
 * `folia` range) reading it throws instead of returning undefined, and optional
 * chaining does not catch a throwing getter. One guarded accessor keeps every
 * caller degrading to "unavailable" instead of an exception. */
const internalsOf = (folium) => {
  try {
    return folium?.internals ?? null;
  } catch {
    return null;
  }
};

const settingsStore = (folium) => {
  const visualizerSettings = internalsOf(folium)?.stores?.visualizerSettings;
  if (!visualizerSettings || typeof visualizerSettings.getState !== 'function') return null;
  return visualizerSettings;
};

/* The live mode list, so a decision can only name a mode that exists right now
 * (a mode contributed by another mod included — the list is the real registry,
 * not a fixed count). */
const availableModes = (folium) => {
  const registry = internalsOf(folium)?.visualizerRegistry ?? null;
  const entries = Array.isArray(registry) ? registry : (registry?.entries ?? []);
  return entries
    .filter((entry) => entry && typeof entry.mode === 'string')
    .map((entry) => ({
      id: entry.mode,
      label: entry.labelFallback || entry.mode,
      hint: MODE_HINTS[entry.mode] ?? '',
    }));
};

const currentMode = (visualizerSettings) => {
  const mode = visualizerSettings?.getState?.()?.visualizerMode;
  return typeof mode === 'string' ? mode : 'classic';
};

/* The AI picks a mode *and* tunes it in one round trip, so it needs the
 * parameter space of every mode, not just the current one. One compact string
 * per mode keeps this well inside the prompt budget. */
const buildParamSpec = () => {
  const spec = {};
  Object.entries(MODE_PARAMS).forEach(([modeId, mode]) => {
    const fields = Object.entries(mode.params).map(([key, param]) => {
      let text;
      if (param.kind === 'boolean') text = `${key}(true|false)`;
      else if (param.kind === 'select') text = `${key}(${(param.options ?? []).join('|')})`;
      else text = `${key}(${param.min}~${param.max})`;
      // Name the switch a value depends on, so the AI can set it in the same
      // decision instead of producing a value that changes nothing on screen.
      const gates = gatesFor(modeId, key);
      if (gates.length > 0) {
        const need = gates.map((gate) => (
          gate.not !== undefined ? `${gate.key}≠${gate.not}` : `${gate.key}=${gate.mustBe}`
        )).join(' 且 ');
        text += `[需 ${need}]`;
      }
      return text;
    });
    if (fields.length > 0) spec[modeId] = fields.join(' ');
  });
  return spec;
};

const normalizeParam = (param, value) => {
  if (param.kind === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return undefined;
  }
  if (param.kind === 'select') {
    const options = param.options ?? [];
    if (options.includes(value)) return value;
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && options.includes(asNumber)) return asNumber;
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.min(param.max, Math.max(param.min, numeric));
};

const formatValue = (value) => (typeof value === 'number' ? String(Math.round(value * 100) / 100) : String(value));

/* `handleSet<Mode>Tuning` -> the store field it writes (`handleSetSonnetTuning`
 * -> `sonnetTuning`), so a gate can be checked against the live values. */
const tuningStateKey = (setter) => {
  const match = /^handleSet([A-Za-z]+)Tuning$/.exec(String(setter ?? ''));
  if (!match) return null;
  const name = match[1];
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}Tuning`;
};

/* Values that do nothing while a sibling switch is closed. The host setters only
 * clamp numbers — they never link a value to its gate — so a decision that sets
 * `postProcessGrain` alone is invisible on screen. Every pair below is read off
 * the renderer source (see folia-gated-params-audit.md): `key` is the switch,
 * `mustBe` the value it needs (or `not` the value that blocks), `setTo` what to
 * write when the mod has to open it itself. */
const PARAM_GATES = {
  classic: {
    // wordSpacing is only consumed by the modern layout.
    wordSpacing: { key: 'useLegacyLayout', mustBe: false },
  },
  cappella: {
    // The emoji pool is only reached from the emo-message branch.
    emojiPackSource: { key: 'showEmoMessages', mustBe: true },
  },
  monet: {
    audioStyle: { key: 'showAudioVisualization', mustBe: true },
  },
  pendolo: {
    // The whole clockwork canvas (line glow included) is skipped at 'none'.
    enableLineGlow: { key: 'showGearDecor', not: 'none', setTo: 'subtle' },
  },
  sonnet: {
    postProcessGrain: { key: 'postProcessEnabled', mustBe: true },
    postProcessContrast: { key: 'postProcessEnabled', mustBe: true },
    postProcessRgbShift: { key: 'postProcessEnabled', mustBe: true },
    postProcessHalftone: { key: 'postProcessEnabled', mustBe: true },
    postProcessVignette: { key: 'postProcessEnabled', mustBe: true },
    postProcessLensDistortion: { key: 'postProcessEnabled', mustBe: true },
    postProcessLensDispersion: { key: 'postProcessEnabled', mustBe: true },
    // MG density needs the background layer, which 'only text' hides entirely.
    mgDensity: [
      { key: 'showBackgroundMg', mustBe: true },
      { key: 'showOnlyText', mustBe: false },
    ],
    showBackgroundMg: { key: 'showOnlyText', mustBe: false },
    showFixedGeo: { key: 'showOnlyText', mustBe: false },
    showBackgroundDecor: { key: 'showOnlyText', mustBe: false },
    showGuide: { key: 'showOnlyText', mustBe: false },
    outerFrameMode: { key: 'showOnlyText', mustBe: false },
  },
  tempera: {
    postProcessGrain: { key: 'postProcessEnabled', mustBe: true },
    postProcessContrast: { key: 'postProcessEnabled', mustBe: true },
    postProcessRgbShift: { key: 'postProcessEnabled', mustBe: true },
    postProcessVignette: { key: 'postProcessEnabled', mustBe: true },
    postProcessLensDistortion: { key: 'postProcessEnabled', mustBe: true },
  },
  diorama: {
    particleGlowIntensity: { key: 'particleGlowEnabled', mustBe: true },
    glowIntensity: { key: 'glowEnabled', mustBe: true },
    soulIntensity: { key: 'soulEnabled', mustBe: true },
    soulActiveEnabled: { key: 'soulEnabled', mustBe: true },
    gradientIntensity: { key: 'gradientEnabled', mustBe: true },
  },
  lumiere: {
    // `textOnly` stops the whole graphics group from rendering.
    themeIcons: { key: 'textOnly', mustBe: false },
    echo: { key: 'textOnly', mustBe: false },
    frontBokeh: { key: 'textOnly', mustBe: false },
    lineArt: { key: 'textOnly', mustBe: false },
    moteAmount: { key: 'textOnly', mustBe: false },
    bloom: { key: 'textOnly', mustBe: false },
    fogDensity: { key: 'textOnly', mustBe: false },
    fogOctaves: { key: 'textOnly', mustBe: false },
    overlayFrame: { key: 'textOnly', mustBe: false },
    renderQuality: { key: 'textOnly', mustBe: false },
  },
};

const gatesFor = (mode, key) => {
  const raw = PARAM_GATES[mode]?.[key];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
};

/* No tuning read means we cannot prove the gate is closed, so we claim nothing. */
const gateSatisfied = (tuning, gate) => {
  if (!tuning) return true;
  const value = tuning[gate.key];
  if (gate.not !== undefined) return value !== gate.not;
  return value === gate.mustBe;
};

/* A value that asks for *less* (a switch off, an intensity of zero) needs no gate:
 * turning something off works whether or not the layer behind it is drawn, and
 * opening the gate would contradict the decision. */
const isInertValue = (param, value) => {
  if (!param) return false;
  if (param.kind === 'boolean') return value === false;
  if (param.kind === 'number') return value === 0;
  return false;
};

/* The mode an answer really means: an id that is not in the live registry is a
 * hallucination, so it degrades to `fallback` instead of being recorded. */
const validatedMode = (folium, mode, fallback) => {
  const candidate = typeof mode === 'string' ? mode.trim() : '';
  if (availableModes(folium).some((item) => item.id === candidate)) return candidate;
  if (candidate) folium.log.warn(`AI 选择了不存在的模式「${candidate}」，保持当前模式`);
  return fallback;
};

/* The params an answer really means: whitelisted against the mode's spec and
 * clamped to its range. Applied *and* stored in this form, so the memory never
 * carries keys the player cannot express (a smaller file, and one that cannot
 * grow with whatever the model felt like returning). */
const sanitizeParams = (mode, rawParams) => {
  const spec = MODE_PARAMS[mode];
  if (!spec || !rawParams || typeof rawParams !== 'object') return {};
  const clean = {};
  Object.entries(rawParams).forEach(([key, value]) => {
    const param = spec.params[key];
    if (!param) return;
    const normalized = normalizeParam(param, value);
    if (normalized === undefined) return;
    clean[key] = normalized;
  });
  return clean;
};

const sanitizeDecision = (folium, decision, fallbackMode) => {
  const mode = validatedMode(folium, decision?.mode, fallbackMode);
  const reason = typeof decision?.reason === 'string' ? decision.reason : '';
  return {
    mode,
    reason: reason.length > REASON_MAX_CHARS ? `${reason.slice(0, REASON_MAX_CHARS)}…` : reason,
    params: sanitizeParams(mode, decision?.params),
  };
};

/* Applies one AI decision through the host's own setters. Returns what changed. */
const applyDecision = (folium, decision, { applyParams = true } = {}) => {
  const visualizerSettings = settingsStore(folium);
  if (!visualizerSettings) {
    throw new Error('无法访问歌词动画设置：宿主内部接口不可用。请确认 mod.json 声明了 folia 版本范围并重启应用。');
  }
  const state = visualizerSettings.getState();
  const modes = availableModes(folium);
  const applied = [];
  const previousMode = currentMode(visualizerSettings);

  const mode = validatedMode(folium, decision?.mode, previousMode);
  const label = modes.find((item) => item.id === mode)?.label ?? mode;
  if (mode !== previousMode) {
    // notify:false keeps the host from stacking its own toast on top of ours.
    state.handleSetVisualizerMode?.(mode, { notify: false });
    applied.push(`模式→${label}`);
  } else {
    // Report the pick even when it agrees with the player: a summary with no mode
    // line reads as "it never chose a mode".
    applied.push(`模式→${label}（与当前一致）`);
  }
  if (!applyParams) return { mode, applied };

  const spec = MODE_PARAMS[mode];
  if (!spec || !spec.setter || typeof state[spec.setter] !== 'function') return { mode, applied };

  const patch = sanitizeParams(mode, decision?.params);
  if (Object.keys(patch).length === 0) return { mode, applied };

  const tuningKey = tuningStateKey(spec.setter);
  const currentTuning = tuningKey ? state[tuningKey] : null;

  /* A value behind a closed switch changes nothing on screen, so open the gate in
   * the same write — but only when opening it actually unblocks the value. A key
   * can depend on several switches (sonnet's mgDensity needs showBackgroundMg on
   * *and* showOnlyText off); injecting one of them while the AI explicitly set
   * another to a blocking value would change a switch the AI never asked about
   * and still not show the value. In that case nothing is injected and the value
   * is reported as blocked. A switch the AI spoke about itself is never
   * overridden, and a value that asks for less (off / zero) needs no gate. */
  const requested = Object.keys(patch); // what the AI actually asked for
  const openedFor = new Set();
  requested.forEach((key) => {
    if (isInertValue(spec.params[key], patch[key])) return;
    const gates = gatesFor(mode, key);
    if (gates.length === 0) return;
    // Already satisfied once the AI's own patch is in place?
    const preview = { ...(currentTuning ?? {}), ...patch };
    if (gates.every((gate) => gateSatisfied(preview, gate))) return;
    // Every unsatisfied gate must be one we are allowed to set ourselves.
    const injectable = gates.filter((gate) => !gateSatisfied(preview, gate));
    if (injectable.some((gate) => gate.key in patch)) return; // the AI decided this switch
    const trial = { ...preview };
    injectable.forEach((gate) => { trial[gate.key] = gate.setTo ?? gate.mustBe; });
    if (!gates.every((gate) => gateSatisfied(trial, gate))) return; // opening it would not help
    injectable.forEach((gate) => { patch[gate.key] = gate.setTo ?? gate.mustBe; });
    openedFor.add(key);
  });
  state[spec.setter](patch);

  /* Read the values back instead of trusting the request: the host's setters are
   * not a plain merge. Cappella rewrites `emojiPackSource:'custom'` to 'builtin'
   * when no pack is uploaded (useVisualizerSettingsStore.ts:538-540) and partita
   * sorts staggerMin/staggerMax (:330-331), so reporting the request would claim a
   * value that is not in the store — and would also judge "blocked" from the wrong
   * state. */
  /* Read the values back from a FRESH state: the host's setters call the store's
   * own `set`, which replaces the state object, so the snapshot taken above still
   * holds the old tuning. */
  const afterState = visualizerSettings.getState?.() ?? state;
  const storedTuning = tuningKey && afterState?.[tuningKey] && typeof afterState[tuningKey] === 'object'
    ? afterState[tuningKey]
    : null;
  const actualValueOf = (key) => (
    storedTuning && key in storedTuning ? storedTuning[key] : patch[key]
  );
  const finalTuning = { ...(currentTuning ?? {}), ...patch, ...(storedTuning ?? {}) };
  // Report only what the AI asked for: a switch this mod opened on its own is
  // named in the suffix of the value that needed it, never as its own "the AI
  // chose this" line.
  requested.forEach((key) => {
    const zh = spec.params[key]?.zh ?? key;
    // Honest reporting: never claim an effect the final state still blocks. A
    // value that only asks for less cannot be blocked — it is a no-op by design.
    const inert = isInertValue(spec.params[key], patch[key]);
    const blocked = !inert && gatesFor(mode, key).some((gate) => !gateSatisfied(finalTuning, gate));
    const actual = actualValueOf(key);
    // The host moved the value (cappella's pack source, partita's stagger order):
    // say so instead of reporting a number the store does not hold.
    const rewritten = storedTuning !== null && key in storedTuning && storedTuning[key] !== patch[key];
    const suffix = blocked ? '（被开关挡住，未生效）'
      : openedFor.has(key) ? '（已同时打开所需开关）' : '';
    applied.push(`${zh}→${formatValue(actual)}${suffix}${rewritten ? '（宿主已按可用资源调整）' : ''}`);
  });
  return { mode, applied };
};

/* Reads the song and lyric lines that are actually on screen. The host's own
 * user-facing surfaces go through selectDisplaySong / selectDisplayLyrics
 * (src/stores/usePlaybackStore.ts:149-155): while an automix transition runs the
 * outgoing deck still owns the picture, and `playback.songChanged` carries that
 * same display song. Reading the raw fields instead would judge (and remember) a
 * track the user cannot see yet. */
const playbackStateOf = (folium) => internalsOf(folium)?.stores?.playback?.getState?.() ?? null;

const displaySongOf = (state) => state?.transitionDisplay?.song ?? state?.currentSong ?? null;
const displayLyricsOf = (state) => (
  state?.transitionDisplay ? state.transitionDisplay.lyrics : state?.lyrics
);

/* The prompt-facing shape of any SongResult (the playing one, or a queued one). */
const songInfoOf = (song) => {
  if (!song) return null;
  return {
    title: song.name ?? '',
    artist: Array.isArray(song.artists) ? song.artists.map((artist) => artist?.name).filter(Boolean).join(' / ') : '',
    album: song.album?.name ?? null,
  };
};

/* The prompt-facing shape of any LyricData. */
const lyricLinesOf = (lyricData) => {
  // LyricData: { lines, title?, artist?, isWordByWord?, ttml? }
  const lines = lyricData?.lines ?? null;
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => ({
    fullText: line?.fullText ?? '',
    translation: line?.translation ?? '',
    songPart: line?.songPart ?? '',
    isChorus: Boolean(line?.isChorus),
  }));
};

const currentSongOf = (folium) => songInfoOf(displaySongOf(playbackStateOf(folium)));
const currentLinesOf = (folium) => lyricLinesOf(displayLyricsOf(playbackStateOf(folium)));

/* Song identity for the per-song memory. Mirrors the host's own
 * getPlaybackSourceRef + getPlaybackSongKey (src/utils/appPlaybackGuards.ts):
 * an explicit `sourceRef` wins, otherwise the song is classified the same way the
 * host does (stage / local / navidrome / online). The classification matters:
 * a queue entry usually has no `sourceRef` yet, while the same song carries one
 * once it plays — guessing "online" for a Navidrome or cloud track would file the
 * prefetched decision under a key the playing song never looks up, so the entry
 * would be lost and the song would be decided twice. */
const songKeyOf = (song) => {
  if (!song || typeof song !== 'object') return null;
  const ref = song.sourceRef && typeof song.sourceRef === 'object' ? song.sourceRef : null;
  if (ref && ref.kind) {
    return ref.kind === 'online'
      ? `online:${ref.providerId ?? 'netease'}:${ref.mediaId ?? song.id}`
      : `${ref.kind}:${ref.mediaId ?? song.id}`;
  }
  // No sourceRef: classify exactly like getPlaybackSourceRef.
  if (song.isStage === true) return `stage:${song.id}`;
  if (song.localRef?.songId) return `local:${song.localRef.songId}`;
  /* Mirrors resolveNavidromePlaybackCarrier (src/utils/appPlaybackGuards.ts:13-33)
   * rather than guessing a shape: the host only treats a song as Navidrome when
   * `navidromeData` is itself a Navidrome carrier (`isNavidrome === true`) or when
   * the song itself is one. `navidromeCarrier` is not a host field at all, and an
   * id read from the wrong level would file the prefetched entry under a key the
   * playing song never looks up. */
  const navidromeCarrier = song.navidromeData && song.navidromeData.isNavidrome === true
    ? song.navidromeData
    : (song.isNavidrome === true && song.navidromeData ? song : null);
  if (navidromeCarrier) {
    const navidromeId = navidromeCarrier.navidromeData?.id ?? song.id;
    if (navidromeId !== undefined && navidromeId !== null) return `navidrome:${navidromeId}`;
  }
  if (song.id !== undefined && song.id !== null) return `online:${song.providerId ?? 'netease'}:${song.id}`;
  // Last resort for a song DTO without any id: title + artist, normalised.
  const title = String(song.name ?? '').trim().toLowerCase();
  if (!title) return null;
  const artist = Array.isArray(song.artists)
    ? song.artists.map((entry) => entry?.name).filter(Boolean).join('/').toLowerCase()
    : '';
  return `title:${title}|${artist}`;
};

// Keyed off the same display song the decision is made for, so the memory entry
// always belongs to the track that is actually on screen.
const currentSongKey = (folium) => songKeyOf(displaySongOf(playbackStateOf(folium)));

export default function activate(folium) {
  let lastReason = '';
  let lastSummary = '';
  let busy = false;
  let lyricsTimer = null;
  let disposed = false;
  /** The song a decision is currently being requested for, so a late answer for
   *  an old track is never applied on top of the new one. */
  let inFlightSongKey = null;
  /** Set while a song change arrived during a decision: the pending decision is
   *  re-scheduled instead of being dropped (that drop was why some tracks never
   *  got a decision at all). */
  let pendingSongKey = null;
  /** Whether the queued request was a forced re-decide, so it is not silently
   *  downgraded to "reuse this song's memory" when it finally runs. */
  let pendingForce = false;
  /** Song key already pre-decided while waiting in the queue, so the same track
   *  is not prefetched twice before it starts playing. */
  let prefetchedSongKey = null;
  /** The song whose lyrics the auto decision is waiting for; null when nothing
   *  is waiting. */
  let awaitingLyricsSongKey = null;
  const listeners = new Set();

  const notify = () => listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      folium.log.warn('面板刷新失败', error);
    }
  });

  /* ---- per-song memory ----------------------------------------------------
   *
   * In the mod's own data file (folium.storage, 1 MB, shared with the main
   * entry). The host's AI theme keeps its cache in its own IndexedDB, which no
   * mod can read, so this mirrors that behaviour instead: one entry per song
   * key, reused on every later visit, no AI call.
   *
   * Entries hold the *validated* decision (see sanitizeDecision) and a clipped
   * reason; a separate index list keeps the entries in most-recently-used order
   * so the oldest ones can be dropped before the 1 MB cap is ever reached.
   */
  const MEMORY_KEY = 'decisions';
  const MEMORY_INDEX_KEY = 'decisionsIndex';
  const SNAPSHOT_KEY = 'settingsSnapshot';
  const memoryKeyOf = (songKey) => `${MEMORY_KEY}:${songKey}`;
  const canRemember = () => typeof folium.storage?.get === 'function';

  const readMemoryIndex = async () => {
    try {
      const stored = await folium.storage.get(MEMORY_INDEX_KEY);
      return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : [];
    } catch {
      return [];
    }
  };

  /* Newest first, deduplicated, capped. Entries past the cap are deleted here —
   * the one place that knows the order. */
  const touchMemoryIndex = async (songKey) => {
    if (!canRemember()) return;
    try {
      const previous = await readMemoryIndex();
      const next = [songKey, ...previous.filter((key) => key !== songKey)];
      const dropped = next.slice(MEMORY_ENTRY_LIMIT);
      const kept = next.slice(0, MEMORY_ENTRY_LIMIT);
      await folium.storage.set(MEMORY_INDEX_KEY, kept);
      for (const old of dropped) {
        await folium.storage.delete(memoryKeyOf(old));
      }
      if (dropped.length > 0) folium.log.info(`记忆已满，清理了 ${dropped.length} 首歌的旧记录`);
    } catch (error) {
      folium.log.warn('整理记忆索引失败', error);
    }
  };

  const readMemory = async (songKey) => {
    if (!canRemember() || !songKey) return null;
    try {
      const stored = await folium.storage.get(memoryKeyOf(songKey));
      if (!stored || typeof stored !== 'object') return null;
      if (typeof stored.mode !== 'string') return null;
      return {
        mode: stored.mode,
        reason: typeof stored.reason === 'string' ? stored.reason : '',
        params: stored.params && typeof stored.params === 'object' ? stored.params : {},
        at: typeof stored.at === 'number' ? stored.at : 0,
      };
    } catch (error) {
      folium.log.warn('读取这首歌的记忆失败', error);
      return null;
    }
  };

  const writeMemory = async (songKey, decision) => {
    if (!canRemember() || !songKey) return;
    const entry = {
      mode: decision.mode,
      reason: decision.reason ?? '',
      params: decision.params ?? {},
      at: Date.now(),
    };
    try {
      await folium.storage.set(memoryKeyOf(songKey), entry);
      await touchMemoryIndex(songKey);
    } catch (error) {
      // The cap is enforced by the host; drop the oldest third and try once more
      // rather than letting the memory go silently dead for the rest of the run.
      // The index is newest-first, so the oldest entries are its *tail*.
      folium.log.warn('写入这首歌的记忆失败，清理旧记录后重试', error);
      try {
        const index = await readMemoryIndex();
        const dropCount = Math.max(1, Math.floor(index.length / 3));
        const dropped = index.slice(index.length - dropCount);
        const kept = index.slice(0, index.length - dropCount);
        for (const old of dropped) await folium.storage.delete(memoryKeyOf(old));
        await folium.storage.set(MEMORY_INDEX_KEY, kept);
        await folium.storage.set(memoryKeyOf(songKey), entry);
        // Re-enter the LRU index at the front: the entry was written outside
        // touchMemoryIndex, so without this it would never be reordered again and
        // could not be evicted when the memory fills up.
        await touchMemoryIndex(songKey);
        if (dropped.length > 0) folium.log.info(`记忆写入超限，清理了最旧的 ${dropped.length} 首歌的旧记录`);
      } catch (retryError) {
        folium.log.warn('清理后仍然写入失败，这次决策不会记住', retryError);
      }
    }
  };

  const forgetMemory = async (songKey) => {
    if (!canRemember() || !songKey) return;
    try {
      await folium.storage.delete(memoryKeyOf(songKey));
      const index = await readMemoryIndex();
      await folium.storage.set(MEMORY_INDEX_KEY, index.filter((key) => key !== songKey));
    } catch (error) {
      folium.log.warn('清除这首歌的记忆失败', error);
    }
  };

  /* ---- settings snapshot --------------------------------------------------
   *
   * Auto decisions write the player's own settings, so the values that were
   * there before the mod touched anything are saved once, and the
   * "恢复原来的设置" command/button puts them back. Written only when absent, so
   * the original state survives later AI decisions. */
  const snapshotSettings = async () => {
    if (!canRemember()) return;
    const state = settingsStore(folium)?.getState?.();
    if (!state) return;
    try {
      if (await folium.storage.has(SNAPSHOT_KEY)) return;
      const tunings = {};
      Object.entries(MODE_PARAMS).forEach(([mode, spec]) => {
        const key = tuningStateKey(spec.setter);
        if (key && state[key] && typeof state[key] === 'object') tunings[mode] = state[key];
      });
      await folium.storage.set(SNAPSHOT_KEY, { mode: state.visualizerMode, tunings, at: Date.now() });
    } catch (error) {
      folium.log.warn('保存设置快照失败', error);
    }
  };

  /* Guarded like the decision path: this awaits storage, so the mod can be switched
   * off in the middle of it. Writing the host's persisted visualizer settings after
   * teardown would change the player for a mod that is no longer running. */
  const restoreSettings = async () => {
    if (!canRemember()) return '无法访问模组存储，无法恢复。';
    let snapshot = null;
    try {
      snapshot = await folium.storage.get(SNAPSHOT_KEY);
    } catch (error) {
      folium.log.warn('读取设置快照失败', error);
    }
    if (disposed) return '模组已停用。';
    if (!snapshot || typeof snapshot !== 'object') return '还没有可恢复的快照：这个模组还没改过你的动画设置。';
    const state = settingsStore(folium)?.getState?.();
    if (!state) return '宿主内部接口不可用，无法恢复。';
    if (typeof snapshot.mode === 'string') {
      state.handleSetVisualizerMode?.(snapshot.mode, { notify: false });
    }
    Object.entries(snapshot.tunings ?? {}).forEach(([mode, tuning]) => {
      const setter = MODE_PARAMS[mode]?.setter;
      if (setter && typeof state[setter] === 'function' && tuning && typeof tuning === 'object') {
        state[setter](tuning);
      }
    });
    return '已恢复 AI 导演接管之前的动画设置。';
  };

  /* The last few modes handed out, newest first. Sent to the AI so it stops
   * defaulting to the same "strongest" mode for every song. */
  const RECENT_KEY = 'recentModes';
  const RECENT_LIMIT = 8;
  const recentModes = [];
  let recentLoaded = false;

  const loadRecentModes = async () => {
    recentLoaded = true;
    if (!canRemember()) return;
    try {
      const stored = await folium.storage.get(RECENT_KEY);
      if (Array.isArray(stored)) {
        recentModes.length = 0;
        stored.filter((mode) => typeof mode === 'string').slice(0, RECENT_LIMIT)
          .forEach((mode) => recentModes.push(mode));
      }
    } catch (error) {
      folium.log.warn('读取最近用过的模式失败', error);
    }
  };

  const noteRecentMode = async (mode) => {
    if (typeof mode !== 'string' || !mode) return;
    const next = [mode, ...recentModes.filter((entry) => entry !== mode)].slice(0, RECENT_LIMIT);
    recentModes.length = 0;
    next.forEach((entry) => recentModes.push(entry));
    if (!canRemember()) return;
    try {
      await folium.storage.set(RECENT_KEY, next);
    } catch (error) {
      folium.log.warn('写入最近用过的模式失败', error);
    }
  };

  /* ---- AI connection ------------------------------------------------------
   *
   * The mod has its own connection settings instead of borrowing Folia's: since
   * 0.7.18 the host's keys are sealed for exactly this reason (so other local
   * code cannot read them), and a mod that decrypts them would be working around
   * the user's protection. The endpoint and model are ordinary settings; the key
   * never goes into `params` (that store is plain-text localStorage) — it is sent
   * straight to the main entry over rpc, sealed with the OS keyring there, and
   * never comes back to this side. */
  const DEFAULT_API_URL = 'https://api.openai.com/v1';
  const DEFAULT_MODEL = 'gpt-4o-mini';
  let credential = { configured: false, encrypted: false, canEncrypt: false, undecryptable: false };
  let credentialKnown = false;
  /** The settings panel's own redraw functions, so a credential status refresh
   *  reaches the panel that is showing it (see refreshCredential). */
  const panelRefreshers = new Set();

  const refreshCredential = async () => {
    try {
      const status = await folium.rpc.call('credential.status');
      credential = {
        configured: status?.configured === true,
        encrypted: status?.encrypted === true,
        canEncrypt: status?.canEncrypt === true,
        undecryptable: status?.undecryptable === true,
      };
      credentialKnown = true;
    } catch (error) {
      credentialKnown = true;
      credential = { configured: false, encrypted: false, canEncrypt: false, undecryptable: false };
      folium.log.warn('读取密钥状态失败', error);
    }
    notify();
    /* `notify` refreshes the player tab's own render only; the settings panel keeps
     * its own `render` and would otherwise show "密钥：检查中…" until the user touched
     * some unrelated setting. Registered here (and cleared on teardown) so a status
     * refresh redraws the panel that asked for it. */
    panelRefreshers.forEach((refresh) => {
      try {
        refresh();
      } catch (error) {
        folium.log.warn('刷新模组设置面板失败', error);
      }
    });
  };

  const credentialLine = () => {
    if (!credentialKnown) return '密钥：检查中…';
    /* A stored value that cannot be opened on this machine (copied mod-data.json,
     * or a session without the keyring it was sealed in) is not "saved": saying so
     * would promise a working key while every request fails. */
    if (credential.undecryptable) return '密钥：已保存但本机无法解密，请重新填写';
    if (!credential.configured) return '密钥：还没填写';
    return credential.encrypted ? '密钥：已保存（系统加密）' : '密钥：已保存（明文，本机没有可用的加密后端）';
  };

  const settingsSection = folium.registries.settingsSections.register({
    id: 'director',
    label: T('AI 歌词动画导演', 'AI lyric animation director'),
    description: T(
      '让 AI 为每首歌挑选歌词动画模式并微调参数。接口地址与密钥填在这里，不会读取 Folia 自己的 AI 设置。',
      'Lets the AI pick a lyric animation mode and tune it per song. The endpoint and key live here; Folia’s own AI settings are not read.',
    ),
    settings: [
      {
        key: 'apiUrl',
        type: 'text',
        group: T('AI 连接', 'AI connection'),
        label: T('接口地址', 'API base URL'),
        description: T(
          'OpenAI 兼容接口。填 https://host 或 https://host/v1 都可以，会自动补 /chat/completions。',
          'An OpenAI-compatible endpoint; /chat/completions is appended automatically.',
        ),
        defaultValue: DEFAULT_API_URL,
      },
      {
        key: 'model',
        type: 'text',
        group: T('AI 连接', 'AI connection'),
        label: T('模型', 'Model'),
        description: T('要使用的模型名。', 'Model name to call.'),
        defaultValue: DEFAULT_MODEL,
      },
      {
        key: 'temperature',
        type: 'number',
        group: T('AI 连接', 'AI connection'),
        label: T('温度', 'Temperature'),
        description: T('越高越随机。0.7 左右比较合适。', 'Higher is more random; around 0.7 works well.'),
        defaultValue: 0.7,
        min: 0,
        max: 2,
        step: 0.1,
      },
      {
        key: 'autoOnSongChange',
        type: 'boolean',
        group: T('行为', 'Behaviour'),
        label: T('换歌时自动决策', 'Decide on every song change'),
        description: T(
          '默认开启：启用模组时若已有歌曲会立即决策一次，之后每首歌的歌词就绪后自动决策。已记住的歌直接复用，不调用 AI。',
          'On by default: one decision when the mod loads with a song already playing, then one per track once its lyrics are ready. A remembered song reuses its stored pick.',
        ),
        defaultValue: true,
      },
      {
        key: 'rememberPerSong',
        type: 'boolean',
        group: T('行为', 'Behaviour'),
        label: T('记住每首歌的选择', 'Remember each song’s pick'),
        description: T(
          '默认开启：同一首歌再次播放时直接复用上次的模式与参数，不再调用 AI（省时省钱，且这首歌的观感保持一致）。',
          'On by default: replaying a song reuses its stored mode and parameters instead of asking the AI again.',
        ),
        defaultValue: true,
      },
      {
        key: 'applyParams',
        type: 'boolean',
        group: T('行为', 'Behaviour'),
        label: T('同时应用参数', 'Apply parameters too'),
        description: T(
          '默认关闭：只切换模式，保留你手动调好的参数。开启后 AI 会连同参数一起改（改动前会保存一次快照，可用「恢复原来的设置」还原）。',
          'Off by default: the mode is switched, your own parameter values are left alone. When on, a snapshot is saved first and can be restored.',
        ),
        defaultValue: false,
      },
      {
        key: 'prefetchNext',
        type: 'boolean',
        group: T('行为', 'Behaviour'),
        label: T('提前为下一首做准备', 'Prepare the next song ahead of time'),
        description: T(
          '默认开启：当前歌决策完成后，若队列里的下一首还没有记忆，就趁它还没播放先向 AI 问好，并存入这首歌的记忆。这样切到它时会立刻生效，开头几秒不会还沿用上一首的动画。只写记忆，不会提前改动画面。',
          'On by default: after the current song settles, the next queued track is decided in advance and stored in its memory, so it takes effect the instant it starts instead of the previous animation lingering. Memory only — nothing on screen changes early.',
        ),
        defaultValue: true,
      },
      {
        key: 'userHint',
        type: 'text',
        group: T('行为', 'Behaviour'),
        label: T('偏好提示（可选）', 'Preference hint (optional)'),
        description: T('例如「安静一点」「多来点转场」，会一并交给 AI。', 'For example “keep it calm”, “more transitions”.'),
        defaultValue: '',
      },
    ],
    /* The key field is drawn here instead of going through the schema: `params`
     * is plain-text localStorage, and a credential does not belong there. */
    settingsPanel: (container, ctx) => {
      const root = document.createElement('div');
      root.style.cssText = 'display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.6;';
      container.appendChild(root);

      const params = ctx.params;
      let draftKey = '';
      let keyNote = '';

      const field = (label, hint, control) => {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
        const title = document.createElement('span');
        title.textContent = label;
        title.style.cssText = 'font-weight:600;';
        wrap.appendChild(title);
        wrap.appendChild(control);
        if (hint) {
          const note = document.createElement('span');
          note.textContent = hint;
          note.style.cssText = 'opacity:0.6;font-size:12px;';
          wrap.appendChild(note);
        }
        return wrap;
      };

      const input = (value, type = 'text') => {
        const el = document.createElement('input');
        el.type = type;
        el.value = value;
        el.style.cssText = [
          'padding:6px 8px', 'border-radius:8px', 'font-size:13px',
          'border:1px solid var(--folium-border,rgba(128,128,128,0.45))',
          'background:var(--folium-input-bg,transparent)', 'color:inherit', 'width:100%',
        ].join(';');
        return el;
      };

      /* One schema field, drawn by its declared type. Every field the schema
       * declares must be reachable here: a custom panel REPLACES the host's
       * automatic form, so anything not drawn is unreachable, and drawing a
       * `text` field as a checkbox would write a boolean the host's own
       * validation drops (the value could never be set at all). */
      const schemaField = (item) => {
        const label = String(item.label?.['zh-CN'] ?? item.label?.en ?? item.key);
        const hint = String(item.description?.['zh-CN'] ?? item.description?.en ?? '');
        const value = params.get()[item.key];
        if (item.type === 'boolean') {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = value === true;
          box.addEventListener('change', () => params.set({ [item.key]: box.checked }));
          const line = document.createElement('label');
          line.style.cssText = 'display:flex;gap:8px;align-items:flex-start;';
          line.appendChild(box);
          const text = document.createElement('span');
          const strong = document.createElement('span');
          strong.textContent = label;
          strong.style.cssText = 'font-weight:600;display:block;';
          text.appendChild(strong);
          if (hint) {
            const note = document.createElement('span');
            note.textContent = hint;
            note.style.cssText = 'opacity:0.6;font-size:12px;';
            text.appendChild(note);
          }
          line.appendChild(text);
          return line;
        }
        if (item.type === 'select') {
          const el = document.createElement('select');
          el.style.cssText = [
            'padding:6px 8px', 'border-radius:8px', 'font-size:13px',
            'border:1px solid var(--folium-border,rgba(128,128,128,0.45))',
            'background:var(--folium-input-bg,transparent)', 'color:inherit', 'width:100%',
          ].join(';');
          (item.options ?? []).forEach((option) => {
            const choice = document.createElement('option');
            choice.value = String(option.value);
            choice.textContent = String(option.label?.['zh-CN'] ?? option.label?.en ?? option.value);
            el.appendChild(choice);
          });
          el.value = String(value ?? '');
          el.addEventListener('change', () => params.set({ [item.key]: el.value }));
          return field(label, hint, el);
        }
        if (item.type === 'number') {
          const el = input(String(value ?? 0), 'number');
          if (item.min !== undefined) el.min = String(item.min);
          if (item.max !== undefined) el.max = String(item.max);
          if (item.step !== undefined) el.step = String(item.step);
          el.addEventListener('change', () => params.set({ [item.key]: Number(el.value) }));
          return field(label, hint, el);
        }
        const el = input(String(value ?? ''));
        if (item.placeholder) el.placeholder = String(item.placeholder);
        el.addEventListener('change', () => params.set({ [item.key]: el.value }));
        return field(label, hint, el);
      };

      const button = (label, primary) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.textContent = label;
        el.style.cssText = [
          'align-self:flex-start', 'padding:6px 12px', 'border-radius:999px', 'cursor:pointer', 'font-size:12px',
          primary
            ? 'border:1px solid var(--folium-accent,#8b5cf6)'
            : 'border:1px solid var(--folium-border,rgba(128,128,128,0.45))',
          'background:transparent', 'color:inherit',
        ].join(';');
        return el;
      };

      const render = () => {
        root.replaceChildren();
        const values = params.get();

        const groupStyle = 'display:flex;flex-direction:column;gap:10px;';
        const heading = (text) => {
          const el = document.createElement('div');
          el.textContent = text;
          el.style.cssText = 'font-weight:700;font-size:12px;letter-spacing:0.04em;opacity:0.7;text-transform:uppercase;';
          return el;
        };

        // --- AI connection ---
        const conn = document.createElement('div');
        conn.style.cssText = groupStyle;
        conn.appendChild(heading('AI 连接'));

        const urlInput = input(String(values.apiUrl ?? DEFAULT_API_URL));
        urlInput.addEventListener('change', () => params.set({ apiUrl: urlInput.value }));
        conn.appendChild(field('接口地址', 'OpenAI 兼容接口，例如 https://api.openai.com/v1', urlInput));

        const modelInput = input(String(values.model ?? DEFAULT_MODEL));
        modelInput.addEventListener('change', () => params.set({ model: modelInput.value }));
        conn.appendChild(field('模型', '例如 gpt-4o-mini、deepseek-chat', modelInput));

        const tempInput = input(String(values.temperature ?? 0.7), 'number');
        tempInput.min = '0';
        tempInput.max = '2';
        tempInput.step = '0.1';
        tempInput.addEventListener('change', () => params.set({ temperature: Number(tempInput.value) }));
        conn.appendChild(field('温度', '越高越随机，0.7 左右比较合适', tempInput));

        const keyInput = input(draftKey, 'password');
        keyInput.placeholder = credential.configured ? '（已保存，留空表示不修改）' : '粘贴这个接口的 API 密钥';
        keyInput.autocomplete = 'off';
        keyInput.addEventListener('input', () => { draftKey = keyInput.value; });
        conn.appendChild(field('API 密钥', '只保存在本机，主进程用系统凭据加密后存进模组数据文件；不会写进设置、不会进日志。', keyInput));

        const keyStatus = document.createElement('div');
        keyStatus.style.cssText = 'opacity:0.7;font-size:12px;';
        keyStatus.textContent = credentialLine();
        conn.appendChild(keyStatus);

        if (credentialKnown && credential.configured && !credential.encrypted) {
          const warn = document.createElement('div');
          warn.style.cssText = 'opacity:0.8;font-size:12px;color:#d97706;';
          warn.textContent = '这台机器没有可用的系统加密后端（Linux 缺少 libsecret / kwallet），密钥只能明文存放。';
          conn.appendChild(warn);
        }
        if (keyNote) {
          const note = document.createElement('div');
          note.style.cssText = 'opacity:0.8;font-size:12px;';
          note.textContent = keyNote;
          conn.appendChild(note);
        }

        const keyRow = document.createElement('div');
        keyRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';
        const saveKey = button('保存密钥', true);
        saveKey.addEventListener('click', async () => {
          /* The placeholder promises that an empty box keeps the stored key, and
           * "清除密钥" is the button that removes it. Sending '' here would delete a
           * working credential and still report success. */
          if (!draftKey.trim()) {
            keyNote = credential.configured
              ? '没有填写新密钥，已保存的密钥保持不变（要删除请点「清除密钥」）。'
              : '还没有填写密钥。';
            render();
            return;
          }
          saveKey.disabled = true;
          keyNote = '正在保存…';
          render();
          try {
            const status = await folium.rpc.call('credential.set', { key: draftKey.trim() });
            credential = {
              configured: status?.configured === true,
              encrypted: status?.encrypted === true,
              canEncrypt: status?.canEncrypt === true,
              undecryptable: status?.undecryptable === true,
            };
            credentialKnown = true;
            draftKey = '';
            keyNote = credential.configured ? '密钥已保存。' : '密钥没有保存成功。';
            folium.ui.toast('AI 导演：密钥已更新', { type: 'success' });
          } catch (error) {
            keyNote = `保存失败：${String(error?.message ?? error)}`;
          }
          render();
        });
        keyRow.appendChild(saveKey);

        const clearKey = button('清除密钥');
        clearKey.addEventListener('click', async () => {
          clearKey.disabled = true;
          try {
            await folium.rpc.call('credential.clear');
            credential = { configured: false, encrypted: false, canEncrypt: credential.canEncrypt, undecryptable: false };
            draftKey = '';
            keyNote = '密钥已清除。';
          } catch (error) {
            keyNote = `清除失败：${String(error?.message ?? error)}`;
          }
          render();
        });
        keyRow.appendChild(clearKey);
        conn.appendChild(keyRow);
        root.appendChild(conn);

        // --- behaviour ---
        const behaviour = document.createElement('div');
        behaviour.style.cssText = groupStyle;
        behaviour.appendChild(heading('行为'));
        const schema = params.schema ?? [];
        schema
          .filter((item) => item.group && item.key !== 'apiUrl' && item.key !== 'model' && item.key !== 'temperature')
          .forEach((item) => behaviour.appendChild(schemaField(item)));
        root.appendChild(behaviour);

        // --- escape hatch ---
        const restore = document.createElement('div');
        restore.style.cssText = groupStyle;
        restore.appendChild(heading('恢复'));
        const restoreNote = document.createElement('div');
        restoreNote.style.cssText = 'opacity:0.6;font-size:12px;';
        restoreNote.textContent = 'AI 改过动画设置后，这里可以把模式与参数还原成它接管之前的样子。';
        restore.appendChild(restoreNote);
        const restoreButton = button('恢复原来的设置');
        restoreButton.addEventListener('click', async () => {
          restoreButton.disabled = true;
          const message = await restoreSettings();
          folium.ui.toast(`AI 导演：${message}`, { type: 'info' });
          render();
        });
        restore.appendChild(restoreButton);
        root.appendChild(restore);
      };

      render();
      const unsubscribe = params.subscribe(() => render());
      panelRefreshers.add(render);
      void refreshCredential();
      return () => {
        panelRefreshers.delete(render);
        unsubscribe?.();
      };
    },
  });

  const readSettings = () => {
    const values = settingsSection.params.get();
    return {
      auto: values.autoOnSongChange === true,
      applyParams: values.applyParams === true,
      remember: values.rememberPerSong !== false,
      prefetchNext: values.prefetchNext !== false,
      userHint: typeof values.userHint === 'string' ? values.userHint : '',
      config: {
        apiUrl: typeof values.apiUrl === 'string' && values.apiUrl.trim() ? values.apiUrl.trim() : DEFAULT_API_URL,
        model: typeof values.model === 'string' && values.model.trim() ? values.model.trim() : DEFAULT_MODEL,
        temperature: Number.isFinite(Number(values.temperature)) ? Number(values.temperature) : 0.7,
      },
    };
  };

  /* Asks the AI for one decision and returns it verbatim. Shared by the song on
   * screen and by the pre-decision for the next queued one, so both send exactly
   * the same context (modes, parameter space, this song's own previous pick, and
   * the modes handed out recently). */
  const requestDecision = async ({ song, lines, targetSongKey, force = false }) => {
    if (!recentLoaded) await loadRecentModes();
    /* "This song's previous choice" must be looked up for the song being decided —
     * for a prefetch that is the queued track, not the one on screen. Reading the
     * playing song's memory here would describe a *different* track to the model
     * and nudge every song toward the same pick. */
    const key = targetSongKey ?? songKeyOf(displaySongOf(playbackStateOf(folium)));
    const previous = key ? await readMemory(key) : null;
    return folium.rpc.call('decide', {
      song,
      lines,
      modes: availableModes(folium),
      paramSpec: buildParamSpec(),
      currentMode: currentMode(settingsStore(folium)),
      userHint: readSettings().userHint,
      config: readSettings().config,
      recentModes: [...recentModes],
      previousChoice: previous
        ? { mode: previous.mode, params: previous.params, reason: previous.reason, forced: force }
        : null,
    });
  };

  /* One decision, for the song that is playing right now.
   *
   * `remember` (default on) makes a song remember its pick: a second visit reuses
   * the stored decision and never calls the AI. `force` is the "decide again"
   * path, which overwrites that memory.
   *
   * Every `await` is followed by a `disposed` check: a decision can be in flight
   * for up to 90 seconds, and the mod may be disabled in the middle of it. Without
   * the checks a late answer would still write the player's settings (which the
   * host persists), toast, and touch storage after the mod was switched off. */
  const runDecision = async ({ announce = true, force = false } = {}) => {
    if (disposed) return DISPOSED;
    const settings = readSettings();
    /* Nothing is on screen: the host emits `playback.songChanged` with `song: null`
     * when playback stops or hands off to the stage window (hostEvents.ts:79-83).
     * Deciding then would send "(未知曲目)" to the AI, spend a call and paint the
     * answer onto whatever plays next.
     *
     * No playback *state* at all is a different problem: the host's internals are
     * unavailable (mod.json range, older host), and telling the user "no song is
     * playing" would send them looking for a track instead of at the setting. */
    const songKey = currentSongKey(folium);
    if (!songKey || !currentSongOf(folium)) {
      if (!settingsStore(folium)) {
        lastSummary = '失败：无法访问歌词动画设置：宿主内部接口不可用。请确认 mod.json 声明了 folia 版本范围并重启应用。';
        lastReason = '';
        folium.log.error('宿主内部接口不可用，无法决策');
        if (announce) folium.ui.toast(`AI 导演失败：${lastSummary.slice(3)}`, { type: 'error' });
        return lastSummary;
      }
      return NO_SONG;
    }

    // A stored decision is applied without asking the AI again. Wrapped like the
    // network path so a broken internals state degrades to a message instead of
    // throwing out of the command.
    if (!force && settings.remember) {
      const remembered = await readMemory(songKey);
      if (disposed) return DISPOSED;
      /* The lookup is an await too: a fast skip can move the player to another
       * track while it runs, and applying the old song's pick to the new one was
       * a real bug. Re-check the song before touching anything. */
      if (remembered && currentSongKey(folium) === songKey) {
        try {
          await snapshotSettings();
          if (disposed) return DISPOSED;
          const result = applyDecision(folium, remembered, { applyParams: settings.applyParams });
          lastReason = remembered.reason;
          lastSummary = `${result.applied.length > 0 ? result.applied.join('，') : '没有需要改动的地方'}（沿用这首歌上次的选择）`;
          const text = `${lastSummary}${lastReason ? `（${lastReason}）` : ''}`;
          if (announce) folium.ui.toast(`AI 导演：${text}`, { type: 'info' });
          /* This path returns before the main `finally` below, so the prefetch has
           * to be started here as well — otherwise it would never run for a
           * remembered song, which is exactly the songs that get replayed. */
          if (!disposed) void prefetchNextSong();
          return text;
        } catch (error) {
          // The stored pick cannot be applied (host interface unavailable): fall
          // through to a fresh decision, which reports the real reason.
          folium.log.warn('沿用记忆失败，改为重新决策', error);
        }
      }
    }
    if (disposed) return DISPOSED;

    /* The memory lookup above is an await as well: a skip during it moved the
     * player to another track. Everything from here on has to describe the song
     * that is on screen *now* — capturing the earlier key made the request use the
     * new song's lyrics while `inFlightSongKey` still held the old one, so the
     * answer was filed under the wrong song and reported as STALE. */
    const liveKey = currentSongKey(folium);
    if (!liveKey || !currentSongOf(folium)) return NO_SONG;

    /* A decision is already running. Rather than dropping this request (which is
     * how a track ended up with no decision at all), remember the song that asked
     * and re-run once the current one settles. `force` travels with it: a
     * "重新决策" clicked while another decision runs must not come back as "沿用这
     * 首歌上次的选择". */
    if (busy) {
      pendingSongKey = liveKey;
      pendingForce = pendingForce || force;
      return QUEUED;
    }

    busy = true;
    inFlightSongKey = liveKey;
    notify();
    const { applyParams } = settings;
    try {
      const decision = await requestDecision({
        song: currentSongOf(folium),
        lines: currentLinesOf(folium),
        targetSongKey: liveKey,
        force,
      });
      if (disposed) return DISPOSED;

      /* The track changed while the AI was thinking: this answer describes a song
       * that is no longer playing, so it is remembered for *that* song instead of
       * being painted onto the new one. */
      const nowKey = currentSongKey(folium);
      if (nowKey !== inFlightSongKey) {
        if (settings.remember && inFlightSongKey) {
          /* The fallback mode must NOT come from the store here: the track on
           * screen is a different one, so its mode describes the wrong song. An
           * id that is not in the live registry is dropped instead of being
           * remembered as whatever the new song happens to be playing. */
          const candidate = typeof decision?.mode === 'string' ? decision.mode.trim() : '';
          const known = availableModes(folium).some((item) => item.id === candidate);
          if (known) {
            await writeMemory(inFlightSongKey, sanitizeDecision(folium, decision, candidate));
          } else {
            folium.log.warn(`决策返回时已换歌，且模式「${candidate}」不存在，这条结果不写入记忆`);
          }
        }
        folium.log.info('决策返回时已换歌，结果记入那首歌的记忆');
        return STALE;
      }

      await snapshotSettings();
      if (disposed) return DISPOSED;
      const result = applyDecision(folium, decision, { applyParams });
      lastReason = typeof decision?.reason === 'string' ? decision.reason : '';
      lastSummary = result.applied.length > 0
        ? result.applied.join('，')
        : '没有需要改动的地方';
      /* `result.mode` is the validated one (an unknown id falls back to the mode
       * that is actually playing), and the params are the clamped, whitelisted
       * ones — so a hallucinated value never enters the memory or the recent list
       * and cannot mislead later decisions. */
      const applied = sanitizeDecision(folium, { ...decision, mode: result.mode }, result.mode);
      /* A track whose lyrics have not arrived (or a pure-music track) is judged on
       * "(这首歌没有歌词)". Remembering that would freeze a guess forever, so the
       * decision is applied but not stored. */
      const hadLyrics = currentLinesOf(folium).length > 0;
      if (settings.remember && inFlightSongKey && hadLyrics) await writeMemory(inFlightSongKey, applied);
      else if (settings.remember && inFlightSongKey) folium.log.info('这首歌没有歌词，本次决策不写入记忆');
      await noteRecentMode(result.mode);
      const text = `${lastSummary}${lastReason ? `（${lastReason}）` : ''}`;
      if (announce) folium.ui.toast(`AI 导演：${text}`, { type: 'success' });
      return text;
    } catch (error) {
      if (disposed) return DISPOSED;
      const message = String(error?.message ?? error);
      lastSummary = `失败：${message}`;
      lastReason = '';
      folium.log.error('AI 决策失败', error);
      if (announce) folium.ui.toast(`AI 导演失败：${message}`, { type: 'error' });
      return lastSummary;
    } finally {
      busy = false;
      inFlightSongKey = null;
      notify();
      /* NOTE: no `return` here — a return inside `finally` would swallow the
       * DISPOSED sentinel the try block just produced. The guard only skips the
       * follow-up work. */
      if (!disposed) {
        // A song asked while this one was running: give it its turn now.
        if (pendingSongKey !== null) {
          const queued = pendingSongKey;
          const queuedForce = pendingForce;
          pendingSongKey = null;
          pendingForce = false;
          if (queued === currentSongKey(folium)) {
            void runDecision({ announce: true, force: queuedForce });
          }
        } else {
          // Nothing else waiting: use the idle moment to prepare the next track, so
          // it can start with its own animation already in place.
          void prefetchNextSong();
        }
      }
    }
  };

  /* ---- pre-deciding the NEXT queued song ----------------------------------
   *
   * The complaint this solves: the first seconds of a track played under the
   * previous song's animation, because a decision only started once the song was
   * already on screen (and took ~2s).
   *
   * The host has no usable hook for this: `playback.beforePlay` is skipped by
   * automix transitions and any handler slower than 1.5s is dropped, while a real
   * decision takes seconds. So instead of intercepting playback, the next song is
   * prepared ahead of time from the queue and stored in the per-song memory; when
   * the track actually starts, runDecision finds the entry and applies it at once.
   *
   * Only the *memory* is written here — never the visualizer. A queued song is not
   * on screen yet, so changing the mode now would be wrong.
   *
   * Lyrics for a song that is not playing cannot come from the playback store, so
   * they are fetched through `internals.omni.getLyrics(song)` — the same provider
   * path the player itself uses. */
  const nextQueuedSong = (state) => {
    const queue = Array.isArray(state?.playQueue) ? state.playQueue : null;
    const currentSong = state?.currentSong ?? null;
    if (!queue || queue.length === 0 || !currentSong) return null;
    // Mirrors resolvePlaybackNeighbors (src/utils/playbackNeighbors.ts:59-88):
    // the queue index is found by song key, not by identity.
    const currentKey = songKeyOf(currentSong);
    const index = queue.findIndex((song) => songKeyOf(song) === currentKey);
    const lastIndex = queue.length - 1;
    if (index >= 0 && index < lastIndex) return queue[index + 1] ?? null;
    if (index < 0) return queue[0] ?? null;
    // At the tail: only a wrap-around queue has a next track.
    const loopMode = state?.loopMode
      ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('player_loop_mode') : null);
    return loopMode === 'all' ? (queue[0] ?? null) : null;
  };

  const omniOf = (folium) => {
    try {
      const omni = internalsOf(folium)?.omni;
      return typeof omni?.getLyrics === 'function' ? omni : null;
    } catch {
      return null;
    }
  };

  const prefetchNextSong = async () => {
    if (disposed) return;
    const settings = readSettings();
    if (!settings.auto || !settings.prefetchNext) return;
    if (busy) return; // never race the song that is on screen
    const state = playbackStateOf(folium);
    const song = nextQueuedSong(state);
    if (!song) return;
    const key = songKeyOf(song);
    if (!key || key === prefetchedSongKey) return;
    /* `nextQueuedSong` falls back to `queue[0]` when the song on screen is not in
     * the queue (the queue was replaced, or the track is not from it), and that
     * entry can be the track that is already playing. Preparing it would spend an
     * AI call on a song that is on screen and then discard the answer, so skip it. */
    if (key === songKeyOf(displaySongOf(state))) return;
    if (!settings.remember) return; // nowhere to park the answer
    if (await readMemory(key)) {
      prefetchedSongKey = key; // already known: nothing to do
      return;
    }
    if (disposed) return;
    const omni = omniOf(folium);
    if (!omni) return;

    prefetchedSongKey = key;
    try {
      const result = await omni.getLyrics(song);
      if (disposed) return;
      const lines = lyricLinesOf(result?.lyrics);
      /* Nothing to judge by. The guard is released so a later attempt (when the
       * provider does have lyrics for this track) is not blocked until the next
       * song change. A pure-music track stays skipped: there is no lyric to decide
       * from, and the README promises such tracks are not remembered. */
      if (lines.length === 0) {
        prefetchedSongKey = null;
        if (!result?.isPureMusic) folium.log.info(`「${songInfoOf(song)?.title}」暂时取不到歌词，稍后再试`);
        return;
      }
      // The track may have started (or been skipped) while the provider answered.
      // Compared against the display song, like every other "what is on screen"
      // decision in this file.
      if (busy || songKeyOf(displaySongOf(playbackStateOf(folium))) === key) return;
      const decision = await requestDecision({
        song: songInfoOf(song),
        lines,
        targetSongKey: key,
        force: false,
      });
      if (disposed) return;
      /* The prefetch can land while the song it prepared for is already on screen
       * and showing something else (the user pressed play, or the queue was
       * reordered). Writing then would replace the pick that is visibly in use, so
       * the current state decides: if this track is playing now, keep its memory.
       * Same for a request that started in the meantime. */
      if (busy || songKeyOf(displaySongOf(playbackStateOf(folium))) === key) return;
      /* Same validation as the on-screen path: a mode that is not in the live
       * registry must never be stored, or the prefetched entry would apply a
       * hallucinated pick the next time the track starts. Unlike the stale path,
       * the mode on screen is NOT a valid fallback here — it belongs to a different
       * song, so the entry is dropped instead of freezing that song under the
       * previous track's animation. */
      const candidate = typeof decision?.mode === 'string' ? decision.mode.trim() : '';
      const known = availableModes(folium).some((item) => item.id === candidate);
      if (!known) {
        folium.log.warn(`提前决策返回的模式「${candidate}」不存在，这条结果不写入记忆`);
        return;
      }
      const settled = sanitizeDecision(folium, decision, candidate);
      const existing = await readMemory(key);
      if (disposed) return;
      if (existing && existing.at > 0) return; // a newer answer is already there
      if (readSettings().remember) await writeMemory(key, settled);
      folium.log.info(`已提前为下一首「${songInfoOf(song)?.title}」决策：${settled.mode}`);
    } catch (error) {
      prefetchedSongKey = null; // a failed prefetch must not block a later retry
      if (!disposed) folium.log.warn('为下一首提前决策失败（不影响当前歌曲）', error);
    }
  };

  folium.registries.commands.register({
    id: 'direct',
    label: T('AI 导演：为这首歌选动画', 'AI director: pick this song’s animation'),
    description: T(
      '请 AI 根据当前歌曲的歌词与气质挑选歌词动画模式并调参。若这首歌已有记忆，会直接沿用（想重新决策请用「重新决策」）。',
      'Let the AI choose and tune the lyric animation for the current song. A remembered song reuses its stored pick.',
    ),
    keywords: ['ai', '动画', '歌词', 'visualizer', 'director'],
    run: async () => {
      const text = await runDecision({ announce: true });
      if (text === DISPOSED) return '模组已停用。';
      if (text === NO_SONG) return '现在没有正在播放的歌，先播放一首再来。';
      if (text === QUEUED) return '上一次决策还在进行中，这首歌已排队，稍候会自动完成。';
      if (text === STALE) return '决策返回时你已经切到了别的歌，这条结果记在了那首歌上。';
      return text.startsWith('失败：') ? text : `已应用：${text}`;
    },
  });

  folium.registries.commands.register({
    id: 'direct-again',
    label: T('AI 导演：重新决策这首歌', 'AI director: decide this song again'),
    description: T('忽略这首歌的记忆，重新请 AI 决策一次，并覆盖记忆。', 'Ignore this song’s memory and ask the AI again.'),
    keywords: ['ai', '动画', '重新', '重来', 'again', 'redecide'],
    run: async () => {
      const text = await runDecision({ announce: true, force: true });
      if (text === DISPOSED) return '模组已停用。';
      if (text === QUEUED) return '上一次决策还在进行中，请稍候。';
      if (text === STALE) return '决策返回时你已经切到了别的歌，这条结果记在了那首歌上。';
      return text.startsWith('失败：') ? text : `已重新决策：${text}`;
    },
  });

  folium.registries.commands.register({
    id: 'restore-settings',
    label: T('AI 导演：恢复原来的动画设置', 'AI director: restore the previous animation settings'),
    description: T(
      '把歌词动画的模式与参数还原成这个模组第一次改动之前的样子。',
      'Restores the lyric animation mode and parameters to what they were before this mod first changed them.',
    ),
    keywords: ['ai', '动画', '恢复', '还原', 'restore', 'reset'],
    run: async () => restoreSettings(),
  });

  folium.registries.playerPanelTabs.register({
    id: 'director',
    label: T('AI 导演', 'AI director'),
    mount(container) {
      const root = document.createElement('div');
      root.style.cssText = 'display:flex;flex-direction:column;gap:10px;padding:16px;font-size:13px;line-height:1.6;';
      container.appendChild(root);

      const render = () => {
        root.replaceChildren();
        const visualizerSettings = settingsStore(folium);

        const heading = document.createElement('div');
        heading.textContent = 'AI 歌词动画导演';
        heading.style.cssText = 'font-size:15px;font-weight:600;';
        root.appendChild(heading);

        const modeLine = document.createElement('div');
        modeLine.style.cssText = 'opacity:0.75;';
        modeLine.textContent = visualizerSettings
          ? `当前模式：${availableModes(folium).find((item) => item.id === currentMode(visualizerSettings))?.label ?? currentMode(visualizerSettings)}`
          : '宿主内部接口不可用，无法读写动画设置';
        root.appendChild(modeLine);

        const credentialNote = document.createElement('div');
        credentialNote.style.cssText = 'opacity:0.75;';
        credentialNote.textContent = `${credentialLine()}${credential.configured ? '' : '（在「模组面板 → AI 歌词动画导演」里填写）'}`;
        root.appendChild(credentialNote);

        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = busy ? 'AI 正在决策…' : '让 AI 为这首歌决策';
        button.disabled = busy || !visualizerSettings;
        button.style.cssText = [
          'align-self:flex-start', 'padding:8px 14px', 'border-radius:999px',
          'border:1px solid var(--folium-accent,#8b5cf6)', 'background:transparent',
          'color:inherit', 'cursor:pointer', 'font-size:13px',
        ].join(';');
        button.addEventListener('click', () => { void runDecision({ announce: true }); });
        root.appendChild(button);

        const again = document.createElement('button');
        again.type = 'button';
        again.textContent = '重新决策这首歌（忽略记忆）';
        again.disabled = busy || !visualizerSettings;
        again.style.cssText = [
          'align-self:flex-start', 'padding:6px 12px', 'border-radius:999px',
          'border:1px solid var(--folium-border,rgba(128,128,128,0.45))', 'background:transparent',
          'color:inherit', 'cursor:pointer', 'font-size:12px', 'opacity:0.85',
        ].join(';');
        again.addEventListener('click', () => { void runDecision({ announce: true, force: true }); });
        root.appendChild(again);

        if (lastReason) {
          const reason = document.createElement('div');
          reason.style.cssText = 'opacity:0.8;';
          reason.textContent = `AI 的理由：${lastReason}`;
          root.appendChild(reason);
        }
        if (lastSummary) {
          const summary = document.createElement('div');
          summary.style.cssText = 'opacity:0.8;';
          summary.textContent = `上次结果：${lastSummary}`;
          root.appendChild(summary);
        }

        const hint = document.createElement('div');
        hint.style.cssText = 'opacity:0.55;font-size:12px;';
        const settingsNow = readSettings();
        hint.textContent = settingsNow.remember
          ? '这首歌会记住本次选择，下次播放直接复用；自动决策与偏好提示在「模组面板 → AI 歌词动画导演」里设置。'
          : '「记住每首歌的选择」当前关闭，每次播放都会重新调用 AI。';
        root.appendChild(hint);

        /* What the queue is preparing, so "nothing happens" is distinguishable
         * from "the next song is already decided". */
        if (settingsNow.prefetchNext) {
          const nextSong = nextQueuedSong(playbackStateOf(folium));
          if (nextSong) {
            const next = document.createElement('div');
            next.style.cssText = 'opacity:0.55;font-size:12px;';
            next.textContent = `下一首「${songInfoOf(nextSong)?.title ?? '?'}」已提前决策时会直接套用，开头不再沿用上一首的动画。`;
            root.appendChild(next);
          }
        }
      };

      render();
      listeners.add(render);
      return () => {
        listeners.delete(render);
        root.remove();
      };
    },
  });

  /* The auto decision waits for the lyrics of the current song instead of
   * running on a fixed delay: lyrics arrive after the song does, and deciding
   * before they land would send "(这首歌没有歌词)" for a song that has them. The
   * fallback timer covers tracks that never get lyrics. */
  const scheduleAutoDecision = () => {
    if (disposed) return;
    if (!readSettings().auto) return;
    if (lyricsTimer !== null) clearTimeout(lyricsTimer);
    /* Nothing on screen (the host emits `playback.songChanged` with `song: null`
     * when playback stops or hands off to the stage window): there is nothing to
     * decide, so no timer is armed. */
    const key = currentSongKey(folium);
    if (!key || !currentSongOf(folium)) {
      lyricsTimer = null;
      awaitingLyricsSongKey = null;
      return;
    }
    const decide = () => {
      lyricsTimer = null;
      awaitingLyricsSongKey = null;
      void runDecision({ announce: true });
    };
    if (currentLinesOf(folium).length > 0) {
      lyricsTimer = setTimeout(decide, LYRICS_SETTLE_MS);
      return;
    }
    awaitingLyricsSongKey = key;
    lyricsTimer = setTimeout(decide, LYRICS_WAIT_FALLBACK_MS);
  };

  folium.events.on('playback.songChanged', () => {
    // A new track is on screen: whatever was prepared for the queue is stale now.
    prefetchedSongKey = null;
    awaitingLyricsSongKey = null;
    scheduleAutoDecision();
  });

  folium.events.on('lyrics.loaded', () => {
    if (disposed || awaitingLyricsSongKey === null) return;
    if (currentLinesOf(folium).length === 0) return;
    awaitingLyricsSongKey = null;
    if (lyricsTimer !== null) clearTimeout(lyricsTimer);
    lyricsTimer = setTimeout(() => {
      lyricsTimer = null;
      void runDecision({ announce: true });
    }, LYRICS_SETTLE_MS);
  });

  /* Turning the switch on mid-song should act on the song that is playing right
   * now, not wait for the next track. */
  let autoWasOn = readSettings().auto;
  const unsubscribeSettings = settingsSection.params.subscribe(() => {
    if (disposed) return;
    const autoNow = readSettings().auto;
    const turnedOn = autoNow && !autoWasOn;
    autoWasOn = autoNow;
    if (turnedOn) scheduleAutoDecision();
  });

  /* Enabling the mod while a song is already loaded is the common case, and
   * `playback.songChanged` only fires on a *change*: without this the user would
   * have to skip a track before anything happened at all. */
  if (autoWasOn && currentSongOf(folium)) scheduleAutoDecision();

  folium.log.info('AI 歌词动画导演已就绪');
  /* Warm the "recently used modes" list so the very first decision of a session
   * already knows what the last session picked (diversity across songs). */
  void loadRecentModes();
  void refreshCredential();

  return () => {
    // Everything that can still be running when the mod is switched off stops
    // here: the pending timer, the settings subscription, the panel listeners.
    // A decision already on the wire is aborted in the main entry and its answer
    // is dropped — every await after this point checks `disposed`.
    disposed = true;
    if (lyricsTimer !== null) {
      clearTimeout(lyricsTimer);
      lyricsTimer = null;
    }
    awaitingLyricsSongKey = null;
    unsubscribeSettings?.();
    listeners.clear();
  };
}
