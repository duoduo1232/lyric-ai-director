// mods/lyric-ai-director/index.cjs
//
// Node half of "AI 歌词动画导演". The renderer decides *what* to change (it owns
// the visualizer settings); this half only asks the user's configured AI for a
// decision, reusing the host's own AI plumbing so the mod behaves exactly like
// the built-in AI theme feature:
//
//   - the same store (electron-store, projectName 'Folia' -> %APPDATA%\Folia\config.json),
//     so OPENAI_API_URL / OPENAI_API_KEY / OPENAI_API_MODEL / OPENAI_API_TEMPERATURE /
//     OPENAI_API_STREAM / AI_PROVIDER are the values the user already set;
//   - the same request builder and reasoning/response_format negotiation
//     (electron/aiTextClient.cjs, shared/openAICompatibleRequest.mjs), which is what
//     makes DeepSeek-style endpoints and `stream: true` work without special cases;
//   - the same 120s timeout and the same "the model spent its budget reasoning"
//     diagnosis.
//
// The host's modules are loaded from the app directory at call time, never at
// activation time: a missing/renamed internal degrades to a clear error message
// in the mod panel instead of breaking the mod's activation.

const path = require('path');

const MAX_LINES_IN_PROMPT = 48;
const MAX_CHARS_PER_LINE = 90;

/* The decision contract. Kept loose on purpose: `mode` and `params` are validated
 * in the renderer against the live visualizer registry, and strict schemas make
 * the long tail of OpenAI-compatible endpoints reject the whole request. */
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    mode: { type: 'string' },
    reason: { type: 'string' },
    params: { type: 'object' },
  },
  required: ['mode'],
  additionalProperties: true,
};

const SYSTEM_PROMPT = [
  '你是一位歌词动画导演，为一个音乐播放器挑选“歌词动画模式”并微调其参数。',
  '',
  '你会收到：歌曲信息、用户可选模式的清单（id、中文名、一句话特点）、每个模式允许调整的参数（键、取值范围、默认值），以及歌词片段。',
  '请判断这首歌的气质（情绪、节奏、段落结构、是否副歌强烈、是否纯音乐），选出一个最合适的模式，并给出该模式参数的取值。',
  '',
  '输出要求：只输出一个 JSON 对象，不要任何解释文字、不要 Markdown 代码块。字段：',
  '{',
  '  "mode": "<模式 id，必须来自清单>",',
  '  "reason": "<一句中文说明为什么选它，30 字以内>",',
  '  "params": { "<该模式的参数键>": <数值或布尔或枚举字符串>, ... }',
  '}',
  '',
  '规则：',
  '1. `mode` 必须精确等于清单里的某个 id。',
  '2. `params` 只放“你选的这个模式”的参数；键名必须来自清单，数值必须落在给定范围内。',
  '3. 少即是好：不确定的参数不要给。宁可只给 2~4 个你确信能提升观感的参数。',
  '4. 强烈、副歌密集的歌可以调高运动与转场强度；安静、民谣、纯音乐宜收敛（降低运动、色差、故障、转场）。',
  '5. 参数清单里形如 `xxx[需 aaa=true]` 的标记表示：该参数只有在 aaa 打开时才看得见。要改这类参数，就把 aaa 一起写进 `params`；否则它会写进去却毫无效果。',
  '6. 反过来，别给出自相矛盾的组合（例如同时 `showOnlyText=true` 与 `mgDensity`）。',
  '7. 重要：模式之间没有“更好”或“最强”，只有“更合适”。不要因为某个模式功能多、特效强就总是选它。请先认真比较各模式的气质，选那个与这首歌最贴合的；如果两三个模式都说得通，就选比较少见、更有个性的那一个，让不同歌曲尽量呈现不同模式。',
  '8. “这首歌上次的选择”指同一首歌：除非这次明显不合适，否则沿用它，让同一首歌保持稳定的观感。',
  '9. “最近用过的模式”指别的歌用过什么：列出它是为了提醒你别让所有歌都长一个样。除非这首歌确实更适合其中某个，否则优先挑一个不在这个列表里的模式。',
].join('\n');

const loadHostModule = (appPath, relativePath) => require(path.join(appPath, relativePath));

/* electron-store with the same projectName the host uses, so we read the very
 * same config.json. Falls back to reading the file directly when the module
 * cannot be resolved from the app directory. */
const createSettingsStore = (appPath, app) => {
  try {
    const StoreModule = loadHostModule(appPath, 'node_modules/electron-store');
    const Store = StoreModule.default || StoreModule;
    return new Store({ projectName: 'Folia' });
  } catch (error) {
    const fs = require('fs');
    const configPath = path.join(app.getPath('appData'), 'Folia', 'config.json');
    const read = () => {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch {
        return {};
      }
    };
    return { get: (key) => read()[key], store: read() };
  }
};

const readApiKeyPresence = (store) => {
  const provider = store.get('AI_PROVIDER') || 'gemini';
  const key = provider === 'openai' ? store.get('OPENAI_API_KEY') : store.get('GEMINI_API_KEY');
  return { provider, configured: typeof key === 'string' && key.trim().length > 0 };
};

const clipLine = (text) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CHARS_PER_LINE ? `${flat.slice(0, MAX_CHARS_PER_LINE)}…` : flat;
};

/* Compact lyric digest: the AI only needs enough to judge the mood, so the whole
 * song never crosses the IPC boundary. */
const buildLyricSnippet = (lines) => {
  if (!Array.isArray(lines) || lines.length === 0) return '(这首歌没有歌词)';
  const step = Math.max(1, Math.ceil(lines.length / MAX_LINES_IN_PROMPT));
  const picked = [];
  for (let index = 0; index < lines.length && picked.length < MAX_LINES_IN_PROMPT; index += step) {
    const line = lines[index] ?? {};
    const parts = [];
    if (line.songPart) parts.push(`[${line.songPart}]`);
    if (line.isChorus) parts.push('[副歌]');
    parts.push(clipLine(line.fullText));
    if (line.translation) parts.push(`(${clipLine(line.translation)})`);
    picked.push(parts.filter(Boolean).join(' '));
  }
  return picked.join('\n');
};

const buildSourcePrompt = ({ song, lyricsSnippet, modes, paramSpec, currentMode, userHint, recentModes, previousChoice }) => {
  const lines = [
    `歌曲：${song?.title || '(未知曲目)'}`,
    `艺人：${song?.artist || '(未知)'}`,
    `专辑：${song?.album || '(未知)'}`,
    `当前模式：${currentMode || '(未知)'}`,
  ];
  if (userHint) lines.push(`用户偏好：${clipLine(userHint)}`);

  /* Consistency per song, variety across songs: the model sees this song's own
   * last pick and what it handed to other songs recently. */
  const modeLabelOf = (id) => {
    const found = Array.isArray(modes) ? modes.find((mode) => mode?.id === id) : null;
    return found?.label ? `${id}（${found.label}）` : String(id);
  };
  if (previousChoice && typeof previousChoice.mode === 'string') {
    const paramKeys = previousChoice.params && typeof previousChoice.params === 'object'
      ? Object.keys(previousChoice.params)
      : [];
    lines.push(
      '',
      `这首歌上次的选择：${modeLabelOf(previousChoice.mode)}`
        + `${paramKeys.length > 0 ? `，参数 ${JSON.stringify(previousChoice.params)}` : ''}`
        + `${previousChoice.reason ? `（理由：${clipLine(previousChoice.reason)}）` : ''}`,
      previousChoice.forced
        ? '注意：用户主动要求“重新决策这首歌”，可以改变上面的选择。'
        : '这首歌的用户体验应该保持稳定，除非明显不合适，请沿用上次的选择。',
    );
  }
  if (Array.isArray(recentModes) && recentModes.length > 0) {
    const unique = [...new Set(recentModes.filter((mode) => typeof mode === 'string'))];
    if (unique.length > 0) {
      lines.push(
        '',
        `最近用过的模式（新→旧）：${unique.map((id) => modeLabelOf(id)).join('、')}`,
        '除非这首歌确实更适合其中某个，否则请优先选一个最近没用过的模式，让不同歌曲各有面貌。',
      );
    }
  }

  lines.push('', '可选模式：');
  modes.forEach((mode) => {
    lines.push(`- ${mode.id}（${mode.label}）${mode.hint ? `：${mode.hint}` : ''}`);
  });
  // Every mode's parameter space, so the AI can tune whichever mode it picks
  // (it chooses and tunes in one round trip).
  const spec = paramSpec && typeof paramSpec === 'object' ? paramSpec : {};
  const specEntries = Object.entries(spec).filter(([, value]) => typeof value === 'string' && value);
  if (specEntries.length > 0) {
    lines.push('', '各模式可调参数（键(范围或取值)；未列出的键不要使用）：');
    specEntries.forEach(([modeId, value]) => lines.push(`- ${modeId}: ${value}`));
  }
  lines.push('', '歌词片段：', lyricsSnippet);
  return lines.join('\n');
};

const extractJsonText = (raw) => {
  let text = String(raw ?? '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
  }
  if (text.startsWith('{')) return text;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text;
};

module.exports = function activate(api) {
  api.rpc.handle('decide', async (payload) => {
    const { app } = require('electron');
    const appPath = app.getAppPath();
    const store = createSettingsStore(appPath, app);
    const { provider, configured } = readApiKeyPresence(store);
    if (!configured) {
      throw new Error(
        provider === 'openai'
          ? '还没配置 AI：请在「设置 → AI 主题设置 → 其他兼容接口」里填好接口链接、模型与密钥。'
          : '还没配置 AI：请在「设置 → AI 主题设置」里填好 Gemini 密钥，或改用「其他兼容接口」。',
      );
    }

    const { runAiJsonCompletion } = loadHostModule(appPath, 'electron/aiTextClient.cjs');

    const systemPrompt = payload?.userHint
      ? `${SYSTEM_PROMPT}\n\n用户额外要求（优先满足）：${clipLine(payload.userHint)}`
      : SYSTEM_PROMPT;
    const sourcePrompt = buildSourcePrompt({
      song: payload?.song,
      lyricsSnippet: buildLyricSnippet(payload?.lines),
      modes: Array.isArray(payload?.modes) ? payload.modes : [],
      paramSpec: payload?.paramSpec,
      currentMode: payload?.currentMode,
      userHint: payload?.userHint,
      recentModes: Array.isArray(payload?.recentModes) ? payload.recentModes : [],
      previousChoice: payload?.previousChoice && typeof payload.previousChoice === 'object'
        ? payload.previousChoice
        : null,
    });

    api.log.info(`请求 AI 决策（${provider}，${Array.isArray(payload?.modes) ? payload.modes.length : 0} 个模式）`);

    const raw = await runAiJsonCompletion({
      store,
      systemPrompt,
      sourcePrompt,
      schema: DECISION_SCHEMA,
      schemaName: 'lyric_animation_decision',
      customFetch: (url, init) => fetch(url, init),
      maxTokens: 2048,
    });

    let parsed;
    try {
      parsed = JSON.parse(extractJsonText(raw));
    } catch (error) {
      api.log.error('AI 返回的不是合法 JSON', { preview: String(raw).slice(0, 300) });
      throw new Error(`AI 返回的内容无法解析为 JSON：${String(error.message || error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.mode !== 'string') {
      throw new Error('AI 返回的 JSON 里没有可用的 mode 字段。');
    }

    return {
      mode: parsed.mode,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      params: parsed.params && typeof parsed.params === 'object' ? parsed.params : {},
    };
  });

  api.log.info('AI 歌词动画导演：main 入口就绪');
};
