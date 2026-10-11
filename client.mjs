// mods/lyric-ai-director/client.mjs
//
// Renderer half of "AI 歌词动画导演". It owns everything the user can see and
// everything that changes the player:
//
//   1. a settings section in the mods panel (plus a command in the command
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
 * 只把写入能力交给设置卡片自身（模组拿到的句柄只有 `{ id, unregister }`），并且
 * k3panel 已经占用了全部 11 个键。AI 改用同一模式的原生参数（cameraIntensity /
 * typographyMotion / mgDensity …）表达同等观感。 */

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

const AUTO_DECIDE_DELAY_MS = 2000;

/* runDecision outcomes that are not a summary string. Distinct values, so the
 * commands and the panel can tell "queued behind another decision" apart from
 * "the track changed under us and the answer went to that song's memory". */
const QUEUED = Symbol('queued');
const STALE = Symbol('stale');

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
 * (a mode contributed by another mod included). */
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

  const patch = {};
  Object.entries(decision?.params ?? {}).forEach(([key, value]) => {
    const param = spec.params[key];
    if (!param) return;
    const normalized = normalizeParam(param, value);
    if (normalized === undefined) return;
    patch[key] = normalized;
  });
  if (Object.keys(patch).length === 0) return { mode, applied };

  const tuningKey = tuningStateKey(spec.setter);
  const currentTuning = tuningKey ? state[tuningKey] : null;

  /* A value behind a closed switch changes nothing on screen, so open the gate in
   * the same write. A switch the AI spoke about itself is left alone, and a value
   * that asks for less (off / zero) needs no gate at all. */
  const openedFor = new Set();
  Object.keys(patch).forEach((key) => {
    if (isInertValue(spec.params[key], patch[key])) return;
    gatesFor(mode, key).forEach((gate) => {
      if (gate.key in patch) return;
      if (gateSatisfied(currentTuning, gate)) return;
      patch[gate.key] = gate.setTo ?? gate.mustBe;
      openedFor.add(key);
    });
  });
  state[spec.setter](patch);

  const finalTuning = { ...(currentTuning ?? {}), ...patch };
  Object.keys(patch).forEach((key) => {
    const zh = spec.params[key]?.zh ?? key;
    // Honest reporting: never claim an effect the final state still blocks. A
    // value that only asks for less cannot be blocked — it is a no-op by design.
    const inert = isInertValue(spec.params[key], patch[key]);
    const blocked = !inert && gatesFor(mode, key).some((gate) => !gateSatisfied(finalTuning, gate));
    const suffix = blocked ? '（被开关挡住，未生效）'
      : openedFor.has(key) ? '（已同时打开所需开关）' : '';
    applied.push(`${zh}→${formatValue(patch[key])}${suffix}`);
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
 * getPlaybackSongKey (src/utils/appPlaybackGuards.ts): source kind + media id, so
 * a local file and an online track with the same title never share an entry. */
const songKeyOf = (song) => {
  if (!song || typeof song !== 'object') return null;
  const sourceRef = song.sourceRef;
  if (sourceRef && typeof sourceRef === 'object') {
    if (sourceRef.kind === 'online') {
      return `online:${sourceRef.providerId ?? 'netease'}:${sourceRef.mediaId ?? song.id}`;
    }
    if (sourceRef.kind && sourceRef.mediaId !== undefined) return `${sourceRef.kind}:${sourceRef.mediaId}`;
  }
  if (song.localRef?.songId) return `local:${song.localRef.songId}`;
  if (song.isStage === true) return `stage:${song.id}`;
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
  let autoTimer = null;
  /** The song a decision is currently being requested for, so a late answer for
   *  an old track is never applied on top of the new one. */
  let inFlightSongKey = null;
  /** Set while a song change arrived during a decision: the pending decision is
   *  re-scheduled instead of being dropped (that drop was why some tracks never
   *  got a decision at all). */
  let pendingSongKey = null;
  /** Song key already pre-decided while waiting in the queue, so the same track
   *  is not prefetched twice before it starts playing. */
  let prefetchedSongKey = null;
  const listeners = new Set();

  /* Per-song memory, in the mod's own data file (folium.storage, 1 MB, shared
   * with the main entry). The host's AI theme keeps its cache in its own
   * IndexedDB, which no mod can read, so this mirrors that behaviour instead:
   * one entry per song key, reused on every later visit, no AI call. */
  const MEMORY_KEY = 'decisions';
  const memoryKeyOf = (songKey) => `${MEMORY_KEY}:${songKey}`;
  const canRemember = () => typeof folium.storage?.get === 'function';

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
      };
    } catch (error) {
      folium.log.warn('读取这首歌的记忆失败', error);
      return null;
    }
  };

  const writeMemory = async (songKey, decision) => {
    if (!canRemember() || !songKey) return;
    try {
      await folium.storage.set(memoryKeyOf(songKey), {
        mode: decision.mode,
        reason: decision.reason ?? '',
        params: decision.params ?? {},
        at: Date.now(),
      });
    } catch (error) {
      folium.log.warn('写入这首歌的记忆失败', error);
    }
  };

  const forgetMemory = async (songKey) => {
    if (!canRemember() || !songKey) return;
    try {
      await folium.storage.delete(memoryKeyOf(songKey));
    } catch (error) {
      folium.log.warn('清除这首歌的记忆失败', error);
    }
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

  const notify = () => listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      folium.log.warn('面板刷新失败', error);
    }
  });

  const settingsSection = folium.registries.settingsSections.register({
    id: 'director',
    label: T('AI 歌词动画导演', 'AI lyric animation director'),
    description: T(
      '用你在「设置 → AI 主题设置」里配置的 AI，为当前歌曲挑选歌词动画模式并微调参数。',
      'Uses the AI you configured in Settings → AI theme to pick a lyric animation mode and tune it.',
    ),
    settings: [
      {
        key: 'autoOnSongChange',
        type: 'boolean',
        label: T('换歌时自动决策', 'Decide on every song change'),
        description: T(
          '默认开启：启用模组时若已有歌曲会立即决策一次，之后每首歌开始约 2 秒后自动决策。已记住的歌直接复用，不调用 AI。',
          'On by default: one decision when the mod loads with a song already playing, then one per track about 2s in. A remembered song reuses its stored pick.',
        ),
        defaultValue: true,
      },
      {
        key: 'rememberPerSong',
        type: 'boolean',
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
        label: T('同时应用参数', 'Apply parameters too'),
        description: T('关闭时只切换模式，保留你手动调好的参数。', 'Off: switch the mode only, keep your own parameter values.'),
        defaultValue: true,
      },
      {
        key: 'prefetchNext',
        type: 'boolean',
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
        label: T('偏好提示（可选）', 'Preference hint (optional)'),
        description: T('例如「安静一点」「多来点转场」，会一并交给 AI。', 'For example “keep it calm”, “more transitions”.'),
        defaultValue: '',
      },
    ],
  });

  const readSettings = () => {
    const values = settingsSection.params.get();
    return {
      auto: values.autoOnSongChange === true,
      applyParams: values.applyParams !== false,
      remember: values.rememberPerSong !== false,
      prefetchNext: values.prefetchNext !== false,
      userHint: typeof values.userHint === 'string' ? values.userHint : '',
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
   * path, which overwrites that memory. */
  const runDecision = async ({ announce = true, force = false } = {}) => {
    const settings = readSettings();
    const songKey = currentSongKey(folium);
    const visualizerSettings = settingsStore(folium);

    // A stored decision is applied without asking the AI again. Wrapped like the
    // network path so a broken internals state degrades to a message instead of
    // throwing out of the command.
    if (!force && settings.remember && songKey) {
      const remembered = await readMemory(songKey);
      if (remembered) {
        try {
          const result = applyDecision(folium, remembered, { applyParams: settings.applyParams });
          lastReason = remembered.reason;
          lastSummary = `${result.applied.length > 0 ? result.applied.join('，') : '没有需要改动的地方'}（沿用这首歌上次的选择）`;
          const text = `${lastSummary}${lastReason ? `（${lastReason}）` : ''}`;
          if (announce) folium.ui.toast(`AI 导演：${text}`, { type: 'info' });
          return text;
        } catch (error) {
          // The stored pick cannot be applied (host interface unavailable): fall
          // through to a fresh decision, which reports the real reason.
          folium.log.warn('沿用记忆失败，改为重新决策', error);
        }
      }
    }

    /* A decision is already running. Rather than dropping this request (which is
     * how a track ended up with no decision at all), remember the song that asked
     * and re-run once the current one settles. */
    if (busy) {
      pendingSongKey = songKey;
      return QUEUED;
    }

    busy = true;
    inFlightSongKey = songKey;
    notify();
    const { applyParams, userHint } = settings;
    try {
      const decision = await requestDecision({
        song: currentSongOf(folium),
        lines: currentLinesOf(folium),
        targetSongKey: songKey,
        force,
      });

      /* The track changed while the AI was thinking: this answer describes a song
       * that is no longer playing, so it is remembered for *that* song instead of
       * being painted onto the new one. */
      const nowKey = currentSongKey(folium);
      if (nowKey !== inFlightSongKey) {
        if (settings.remember && inFlightSongKey) {
          await writeMemory(inFlightSongKey, {
            ...decision,
            mode: validatedMode(folium, decision?.mode, currentMode(settingsStore(folium))),
          });
        }
        folium.log.info('决策返回时已换歌，结果记入那首歌的记忆');
        return STALE;
      }

      const result = applyDecision(folium, decision, { applyParams });
      lastReason = typeof decision?.reason === 'string' ? decision.reason : '';
      lastSummary = result.applied.length > 0
        ? result.applied.join('，')
        : '没有需要改动的地方';
      /* `result.mode` is the validated one (an unknown id falls back to the mode
       * that is actually playing), so a hallucinated mode never enters the memory
       * or the recent list and cannot mislead later decisions. */
      const applied = { mode: result.mode, reason: decision?.reason, params: decision?.params };
      if (settings.remember && songKey) await writeMemory(songKey, applied);
      await noteRecentMode(result.mode);
      const text = `${lastSummary}${lastReason ? `（${lastReason}）` : ''}`;
      if (announce) folium.ui.toast(`AI 导演：${text}`, { type: 'success' });
      return text;
    } catch (error) {
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
      // A song asked while this one was running: give it its turn now.
      if (pendingSongKey !== null) {
        const queued = pendingSongKey;
        pendingSongKey = null;
        if (queued === currentSongKey(folium)) void runDecision({ announce: true });
      } else {
        // Nothing else waiting: use the idle moment to prepare the next track, so
        // it can start with its own animation already in place.
        void prefetchNextSong();
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
    const settings = readSettings();
    if (!settings.auto || !settings.prefetchNext) return;
    if (busy) return; // never race the song that is on screen
    const state = playbackStateOf(folium);
    const song = nextQueuedSong(state);
    if (!song) return;
    const key = songKeyOf(song);
    if (!key || key === prefetchedSongKey) return;
    if (!settings.remember) return; // nowhere to park the answer
    if (await readMemory(key)) {
      prefetchedSongKey = key; // already known: nothing to do
      return;
    }
    const omni = omniOf(folium);
    if (!omni) return;

    prefetchedSongKey = key;
    try {
      const result = await omni.getLyrics(song);
      const lines = lyricLinesOf(result?.lyrics);
      if (lines.length === 0 && !result?.isPureMusic) return; // nothing to judge by
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
      if (readSettings().remember) await writeMemory(key, decision);
      folium.log.info(`已提前为下一首「${songInfoOf(song)?.title}」决策：${decision.mode}`);
    } catch (error) {
      prefetchedSongKey = null; // a failed prefetch must not block a later retry
      folium.log.warn('为下一首提前决策失败（不影响当前歌曲）', error);
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
      if (text === QUEUED) return '上一次决策还在进行中，请稍候。';
      if (text === STALE) return '决策返回时你已经切到了别的歌，这条结果记在了那首歌上。';
      return text.startsWith('失败：') ? text : `已重新决策：${text}`;
    },
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

  /* One debounced auto decision. Lyrics arrive slightly after the song does, so
   * deciding too early would send an empty snippet; the delay also lets a newer
   * song cancel the pending one. */
  const scheduleAutoDecision = () => {
    if (!readSettings().auto) return;
    if (autoTimer !== null) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      // A remembered song is applied without any AI call; runDecision decides that.
      void runDecision({ announce: true });
    }, AUTO_DECIDE_DELAY_MS);
  };

  folium.events.on('playback.songChanged', () => {
    // A new track is on screen: whatever was prepared for the queue is stale now.
    prefetchedSongKey = null;
    scheduleAutoDecision();
  });

  /* Turning the switch on mid-song should act on the song that is playing right
   * now, not wait for the next track. */
  let autoWasOn = readSettings().auto;
  const unsubscribeSettings = settingsSection.params.subscribe(() => {
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
  return () => {
    if (autoTimer !== null) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    unsubscribeSettings?.();
    listeners.clear();
  };
}
