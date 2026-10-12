// mods/lyric-ai-director/index.cjs
//
// Node half of "AI 歌词动画导演". The renderer decides *what* to change (it owns
// the visualizer settings); this half only asks the AI for a decision.
//
// The mod owns its AI connection outright — it does not read Folia's config,
// and it does not load any of the host's private modules:
//
//   - The endpoint, model and temperature come from the mod's own settings
//     (sent along with each request by the client half).
//   - The API key is stored here, sealed with Electron's safeStorage (DPAPI on
//     Windows, Keychain on macOS, libsecret/kwallet on Linux), so the ciphertext
//     is all that reaches mod-data.json. It is decrypted per request and never
//     crosses IPC after the user types it.
//   - Requests go out through Electron's `net.fetch`, which rides Chromium's
//     network stack and therefore follows the system proxy like the rest of the
//     app; Node's global fetch ignores it.
//
// This is also why the mod works on Folia 0.7.18+, where the host's own AI keys
// are sealed and unreadable by mods by design: it never needed them.

'use strict';

const MAX_LINES_IN_PROMPT = 48;
const MAX_CHARS_PER_LINE = 90;
const REQUEST_TIMEOUT_MS = 90000;
const MAX_TOKENS = 2048;
const DEFAULT_MODEL = 'gpt-4o-mini';

/* The decision contract, spelled out in the prompt. Deliberately loose: `mode`
 * and `params` are validated in the renderer against the live visualizer
 * registry, and strict JSON schemas make the long tail of OpenAI-compatible
 * endpoints reject the whole request. */
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

// ---------------------------------------------------------------- credentials

const CREDENTIAL_KEY = 'aiCredential'; // { sealed: boolean, value: string }

/* Electron is a public API surface in the main process (the mod's Node entry
 * runs there); nothing host-private is touched. Resolved lazily so a mod that
 * cannot see Electron still activates and reports the problem per request. */
const electronOf = () => {
  try {
    return require('electron');
  } catch {
    return null;
  }
};

const createCredentialStore = (api) => {
  const electron = electronOf();
  const safeStorage = electron?.safeStorage ?? null;

  const canEncrypt = () => {
    try {
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  };

  const readRaw = async () => {
    try {
      const stored = await api.storage.data.get(CREDENTIAL_KEY);
      return stored && typeof stored === 'object' ? stored : null;
    } catch {
      return null;
    }
  };

  /* Whether a sealed value can actually be opened *on this machine*. A copied
   * mod-data.json, or a Linux session without the keyring it was sealed in, leaves
   * a value that is present but useless; reporting it as "configured" made every
   * request fail with "还没配置密钥" while the panel claimed the key was saved. */
  const canDecrypt = (stored) => {
    if (stored?.sealed !== true) return true;
    try {
      return safeStorage.decryptString(Buffer.from(stored.value, 'base64')).length > 0;
    } catch {
      return false;
    }
  };

  const statusOf = (stored) => {
    const stored_ = Boolean(stored && typeof stored.value === 'string' && stored.value.length > 0);
    const usable = stored_ && canDecrypt(stored);
    return {
      configured: usable,
      encrypted: usable && stored.sealed === true,
      canEncrypt: canEncrypt(),
      undecryptable: stored_ && !usable,
    };
  };

  return {
    /** Stores a key the user just typed. Returns the new status. */
    setKey: async (plain) => {
      const text = typeof plain === 'string' ? plain.trim() : '';
      /* An empty payload is a no-op, never a delete: the panel's placeholder
       * promises that leaving the box blank keeps the stored key, and only the
       * "清除密钥" button (credential.clear) removes it. */
      if (!text) return statusOf(await readRaw());
      if (canEncrypt()) {
        const sealed = safeStorage.encryptString(text).toString('base64');
        await api.storage.data.set(CREDENTIAL_KEY, { sealed: true, value: sealed });
      } else {
        // No OS keyring (Linux without libsecret/kwallet): the honest fallback is
        // plaintext, and the settings panel says so out loud.
        await api.storage.data.set(CREDENTIAL_KEY, { sealed: false, value: text });
      }
      return statusOf(await readRaw());
    },

    clear: async () => {
      await api.storage.data.delete(CREDENTIAL_KEY);
      return { configured: false, encrypted: false, canEncrypt: canEncrypt(), undecryptable: false };
    },

    /** The key in the clear, for one request. Never returned over IPC. */
    getKey: async () => {
      const stored = await readRaw();
      if (!stored || typeof stored.value !== 'string' || !stored.value) return '';
      if (stored.sealed !== true) return stored.value;
      try {
        return safeStorage.decryptString(Buffer.from(stored.value, 'base64'));
      } catch (error) {
        api.log.warn('本机无法解密已保存的密钥，请在模组设置里重新填写', { message: String(error?.message ?? error) });
        return '';
      }
    },

    status: async () => statusOf(await readRaw()),
  };
};

// ---------------------------------------------------------------- transport

/* Chromium's stack, so the user's system proxy setting applies (Node's global
 * fetch would bypass it). */
const httpFetchOf = () => {
  const electron = electronOf();
  if (typeof electron?.net?.fetch === 'function') return electron.net.fetch;
  return typeof fetch === 'function' ? fetch : null;
};

/** `https://host`, `https://host/v1` and a full endpoint all end up at chat/completions. */
const normalizeChatUrl = (raw) => {
  let url = String(raw ?? '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  /* Split the query/fragment off first: appending to the whole string turned
   * `https://host/v1?api-version=x` into `...?api-version=x/v1/chat/completions`
   * (common for Azure-style or proxied gateways). */
  const cut = url.search(/[?#]/);
  const suffix = cut === -1 ? '' : url.slice(cut);
  let path = (cut === -1 ? url : url.slice(0, cut)).replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(path)) {
    path = /\/v\d+$/i.test(path) ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  }
  return `${path}${suffix}`;
};

const extractContentText = (message) => {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  // Some gateways answer with content parts instead of a string.
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
      .filter(Boolean)
      .join('');
  }
  return '';
};

const describeFailure = (error, timeoutMs) => {
  const name = String(error?.name ?? '');
  const message = String(error?.message ?? error);
  if (name === 'AbortError' || /abort/i.test(message)) return `请求超时（${Math.round(timeoutMs / 1000)} 秒）`;
  return message;
};

/*
 * One request, with a small ladder for the quirks of OpenAI-compatible
 * endpoints: `response_format` and `max_tokens` are both optional extensions, so
 * a 4xx that is not an auth/limit error drops them one at a time instead of
 * failing the whole decision.
 */
const requestCompletion = async ({ url, apiKey, model, temperature, systemPrompt, sourcePrompt, signal, log, isDisposed }) => {
  const fetchImpl = httpFetchOf();
  if (!fetchImpl) throw new Error('无法发起网络请求：Electron 的 net.fetch 与全局 fetch 都不可用。');

  /* A deactivation aborts the same way a timeout does, so the two are told apart
   * here rather than reported as "timeout" to a user who just switched the mod
   * off. */
  const failureOf = (error) => new Error(
    isDisposed?.() ? '模组已停用' : describeFailure(error, REQUEST_TIMEOUT_MS),
  );

  const base = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: sourcePrompt },
    ],
    temperature,
    stream: false,
  };

  const attempts = [
    { ...base, response_format: { type: 'json_object' }, max_tokens: MAX_TOKENS },
    { ...base, max_tokens: MAX_TOKENS },
    { ...base },
  ];

  let lastError = null;
  for (let index = 0; index < attempts.length; index += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(attempts[index]),
        signal,
      });
    } catch (error) {
      throw failureOf(error);
    }

    if (response.ok) {
      let data;
      try {
        data = await response.json();
      } catch (error) {
        throw new Error(`AI 返回的不是合法 JSON：${describeFailure(error, REQUEST_TIMEOUT_MS)}`);
      }
      const text = extractContentText(data?.choices?.[0]?.message);
      if (!text) {
        const finish = data?.choices?.[0]?.finish_reason;
        throw new Error(
          finish === 'length'
            ? 'AI 的回答被长度上限截断，没留下内容。请换一个更听话的模型。'
            : 'AI 返回的内容是空的。',
        );
      }
      return text;
    }

    const bodyText = await response.text().catch(() => '');
    /* The provider's error body is shown to the user, so it must not be able to
     * echo the credential back. Gateways do sometimes repeat request headers in
     * an error payload; strip the key (and any Bearer token) before it reaches a
     * message, a toast or the log. */
    const redact = (text) => String(text)
      .split(apiKey).join('[已隐藏]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}/gi, '$1[已隐藏]')
      .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[^"\s,}]{8,}/gi, '$1[已隐藏]');
    lastError = new Error(`接口返回 ${response.status}：${redact(bodyText).slice(0, 300) || response.statusText}`);
    // Only the two optional fields are worth retrying without; anything else is
    // a real error the user has to see (bad key, wrong URL, rate limit...).
    const retryable = index < attempts.length - 1 && response.status >= 400 && response.status < 500
      && ![401, 403, 404, 429].includes(response.status);
    if (!retryable) throw lastError;
    log.warn(`接口拒绝了第 ${index + 1} 种请求形态，改用更保守的参数重试`, { status: response.status });
  }
  throw lastError ?? new Error('请求失败');
};

// ---------------------------------------------------------------- prompt

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
  (Array.isArray(modes) ? modes : []).forEach((mode) => {
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

const normalizeTemperature = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.7;
  return Math.min(2, Math.max(0, numeric));
};

// ---------------------------------------------------------------- activation

module.exports = function activate(api) {
  let disposed = false;
  /* Every request still on the wire. A single slot was not enough: a prefetch does
   * not hold the renderer's `busy`, so it can be in flight while a command starts
   * another one, and deactivation has to abort both (the older one would otherwise
   * keep running for up to REQUEST_TIMEOUT_MS after the mod was switched off). */
  const inFlight = new Set();

  /* Disabling the mod (or quitting) aborts whatever is still on the wire, so a
   * late answer cannot be handed back to a renderer that is already gone. */
  api.lifecycle.onDeactivate(() => {
    disposed = true;
    inFlight.forEach((controller) => {
      try {
        controller.abort();
      } catch {
        /* already settled */
      }
    });
    inFlight.clear();
  });

  const credentials = createCredentialStore(api);

  /* Guarded like `decide`: writing the credential store after teardown would touch
   * the mod's data file on behalf of a mod that is no longer running. */
  api.rpc.handle('credential.status', () => (
    disposed ? { configured: false, encrypted: false, canEncrypt: false, undecryptable: false } : credentials.status()
  ));
  api.rpc.handle('credential.set', async (payload) => {
    if (disposed) throw new Error('模组已停用');
    return credentials.setKey(payload?.key);
  });
  api.rpc.handle('credential.clear', async () => {
    if (disposed) throw new Error('模组已停用');
    return credentials.clear();
  });

  api.rpc.handle('decide', async (payload) => {
    if (disposed) throw new Error('模组已停用');

    const config = payload?.config && typeof payload.config === 'object' ? payload.config : {};
    const url = normalizeChatUrl(config.apiUrl);
    if (!url) throw new Error('还没配置接口地址：请在「模组面板 → AI 歌词动画导演」里填写（例如 https://api.openai.com/v1）。');
    const model = String(config.model ?? '').trim() || DEFAULT_MODEL;
    const temperature = normalizeTemperature(config.temperature);

    const apiKey = await credentials.getKey();
    if (!apiKey) {
      throw new Error('还没配置密钥：请在「模组面板 → AI 歌词动画导演」里填写这个接口的 API 密钥（只保存在本机，加密存放）。');
    }

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

    api.log.info(`请求 AI 决策（${model}，${Array.isArray(payload?.modes) ? payload.modes.length : 0} 个模式）`);

    const controller = new AbortController();
    inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let raw;
    try {
      raw = await requestCompletion({
        url,
        apiKey,
        model,
        temperature,
        systemPrompt,
        sourcePrompt,
        signal: controller.signal,
        log: api.log,
        isDisposed: () => disposed,
      });
    } finally {
      clearTimeout(timer);
      inFlight.delete(controller);
    }

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

  api.log.info('AI 歌词动画导演：main 入口就绪（模组自有密钥，Electron net.fetch 传输）');
};
