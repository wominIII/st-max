import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { itemizedPrompts } from '../../../itemized-prompts.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_ID = 'context-token-meter';
const REFRESH_INTERVAL = 1600;
const PROMPT_PROBE_INPUT_DEBOUNCE = 1000;
const PROMPT_PROBE_IDLE_DEBOUNCE = 450;
const PROMPT_PROBE_COOLDOWN = 4000;
const VIEWPORT_PADDING = 8;
const POSITION_PAGE_STEP = 32;
const MAX_TOKEN_STEP = 1000;

const defaultSettings = {
    position: 'top',
    positionX: 16,
    positionY: 16,
    displayStyle: 'vertical',
    contextColor: '#0a4069',
    promptColor: '#f1c40f',
    maxTokens: 8192,
    contextMessages: 20,
};

const settings = typeof structuredClone === 'function'
    ? structuredClone(defaultSettings)
    : JSON.parse(JSON.stringify(defaultSettings));

let refreshTimer = null;
let periodicTimer = null;
let settingsUiRetryTimer = null;
let lastRenderKey = '';
let latestPromptPacket = null;
let promptProbeTimer = null;
let promptProbeInFlight = false;
let promptProbePending = false;
let lastPromptProbeAt = 0;
let lastPromptProbeSignature = '';
let isRealGenerationRunning = false;

function ensureSettings() {
    if (!extension_settings[MODULE_ID]) {
        extension_settings[MODULE_ID] = {};
    }

    Object.assign(settings, defaultSettings, extension_settings[MODULE_ID]);
    settings.positionX = sanitizeInteger(settings.positionX, defaultSettings.positionX, 0);
    settings.positionY = sanitizeInteger(settings.positionY, defaultSettings.positionY, 0);
    settings.displayStyle = ['vertical', 'horizontal', 'verticalSlim'].includes(settings.displayStyle) ? settings.displayStyle : defaultSettings.displayStyle;
    settings.contextColor = sanitizeColor(settings.contextColor, defaultSettings.contextColor);
    settings.promptColor = sanitizeColor(settings.promptColor, defaultSettings.promptColor);
    settings.maxTokens = sanitizeInteger(settings.maxTokens, defaultSettings.maxTokens, 1);
    settings.contextMessages = sanitizeInteger(settings.contextMessages, defaultSettings.contextMessages, 1);

    Object.assign(extension_settings[MODULE_ID], settings);
}

function saveSetting(key, value, { probe = false } = {}) {
    settings[key] = value;
    Object.assign(extension_settings[MODULE_ID], settings);
    saveSettingsDebounced();
    scheduleRefresh(0);
    if (probe) {
        schedulePromptPacketProbe();
    }
}

function onExtensionEvent(eventName, handler) {
    if (!eventName) {
        return;
    }

    eventSource.on(eventName, handler);
}

function scheduleRefresh(delay = 120) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshWidget().catch(error => console.warn(`[${MODULE_ID}] Refresh failed`, error));
    }, delay);
}

function getPromptProbeSignature() {
    const context = getContext();
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    const chat = Array.isArray(context.chat) ? context.chat : [];
    const lastMessage = chat[chat.length - 1];

    return [
        context.chatId ?? 'no-chat',
        chat.length,
        lastMessage?.send_date ?? lastMessage?.extra?.send_date ?? '',
        String(textarea?.value || ''),
        settings.maxTokens,
        settings.contextMessages,
        settings.displayStyle,
    ].join('|');
}

function schedulePromptPacketProbe(delay = PROMPT_PROBE_IDLE_DEBOUNCE) {
    clearTimeout(promptProbeTimer);
    promptProbeTimer = setTimeout(() => {
        runPromptPacketProbe().catch(error => console.warn(`[${MODULE_ID}] Prompt probe failed`, error));
    }, delay);
}

async function runPromptPacketProbe() {
    if (isRealGenerationRunning) {
        promptProbePending = true;
        return;
    }

    const signature = getPromptProbeSignature();
    if (signature === lastPromptProbeSignature && latestPromptPacket?.tokens > 0) {
        return;
    }

    if (promptProbeInFlight) {
        promptProbePending = true;
        return;
    }

    const elapsed = Date.now() - lastPromptProbeAt;
    if (elapsed < PROMPT_PROBE_COOLDOWN) {
        promptProbePending = true;
        schedulePromptPacketProbe(PROMPT_PROBE_COOLDOWN - elapsed);
        return;
    }

    const context = getContext();
    if (typeof context.generate !== 'function') {
        return;
    }

    promptProbeInFlight = true;
    promptProbePending = false;
    lastPromptProbeAt = Date.now();
    lastPromptProbeSignature = signature;

    try {
        const generateData = await context.generate('normal', {}, true);
        if (generateData) {
            await cachePromptPacketFromGenerateData(generateData);
        }
    } finally {
        promptProbeInFlight = false;

        if (promptProbePending) {
            promptProbePending = false;
            schedulePromptPacketProbe(PROMPT_PROBE_COOLDOWN);
        }
    }
}

function createBarFaces() {
    return `
        <div class="face top"><div class="growing-bar"></div></div>
        <div class="face side-0"><div class="growing-bar"></div></div>
        <div class="face floor"><div class="growing-bar"></div></div>
        <div class="face side-a"></div>
        <div class="face side-b"></div>
        <div class="face side-1"><div class="growing-bar"></div></div>
    `;
}

function ensureWidget() {
    let widget = document.getElementById('stctx_token_meter');
    if (widget) {
        applyWidgetAppearance(widget);
        applyWidgetPlacement(widget);
        return widget;
    }

    widget = document.createElement('div');
    widget.id = 'stctx_token_meter';
    widget.className = 'stctx-token-meter';
    applyWidgetAppearance(widget);
    widget.innerHTML = `
        <div class="stctx-token-meter-inner container">
            <div class="chart grid" data-role="chart" aria-label="Token progress">
                <div class="exercise second">
                    <div class="stctx-stacked-progress" data-role="stack" title="等待 token 数据">
                        <div class="bar bar-track lightGray-face" aria-hidden="true">${createBarFaces()}</div>
                        <div class="bar bar-fill stctx-stack-fill" aria-hidden="true">${createBarFaces()}</div>
                        <div class="stctx-total-marker" aria-hidden="true"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.append(widget);
    applyWidgetPlacement(widget);
    return widget;
}

function ensureSettingsUi() {
    if (document.getElementById('stctx_token_meter_settings')) {
        return;
    }

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) {
        scheduleSettingsUiRetry();
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'stctx_token_meter_settings';
    panel.className = 'stctx-token-meter-settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>上下文 Token 进度条</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="stctx-settings-grid">
                    <label for="stctx_meter_style">进度条样式</label>
                    <select id="stctx_meter_style" class="text_pole">
                        <option value="vertical">竖条</option>
                        <option value="horizontal">横条</option>
                        <option value="verticalSlim">竖向长条</option>
                    </select>

                    <label for="stctx_meter_position_x">X 坐标：<span data-role="position-x-value">0</span></label>
                    <div class="stctx-range-control">
                        <button type="button" class="stctx-step-button" data-step-target="positionX" data-step="-${POSITION_PAGE_STEP}" aria-label="X 坐标减少">−</button>
                        <input id="stctx_meter_position_x" class="stctx-range" type="range" min="0" step="1">
                        <button type="button" class="stctx-step-button" data-step-target="positionX" data-step="${POSITION_PAGE_STEP}" aria-label="X 坐标增加">+</button>
                    </div>

                    <label for="stctx_meter_position_y">Y 坐标：<span data-role="position-y-value">0</span></label>
                    <div class="stctx-range-control">
                        <button type="button" class="stctx-step-button" data-step-target="positionY" data-step="-${POSITION_PAGE_STEP}" aria-label="Y 坐标减少">−</button>
                        <input id="stctx_meter_position_y" class="stctx-range" type="range" min="0" step="1">
                        <button type="button" class="stctx-step-button" data-step-target="positionY" data-step="${POSITION_PAGE_STEP}" aria-label="Y 坐标增加">+</button>
                    </div>

                    <label for="stctx_meter_context_color">上下文颜色</label>
                    <input id="stctx_meter_context_color" class="stctx-color-input" type="color">

                    <label for="stctx_meter_prompt_color">发送包颜色</label>
                    <input id="stctx_meter_prompt_color" class="stctx-color-input" type="color">

                    <label for="stctx_meter_max_tokens">最高 token</label>
                    <div class="stctx-number-control">
                        <button type="button" class="stctx-step-button" data-step-target="maxTokens" data-step="-${MAX_TOKEN_STEP}" aria-label="最高 token 减少">−</button>
                        <input id="stctx_meter_max_tokens" class="text_pole" type="number" min="1" step="1" inputmode="numeric">
                        <button type="button" class="stctx-step-button" data-step-target="maxTokens" data-step="${MAX_TOKEN_STEP}" aria-label="最高 token 增加">+</button>
                    </div>

                    <label for="stctx_meter_context_messages">读取最近消息数</label>
                    <div class="stctx-number-control">
                        <button type="button" class="stctx-step-button" data-step-target="contextMessages" data-step="-1" aria-label="读取消息数减少">−</button>
                        <input id="stctx_meter_context_messages" class="text_pole" type="number" min="1" step="1" inputmode="numeric">
                        <button type="button" class="stctx-step-button" data-step-target="contextMessages" data-step="1" aria-label="读取消息数增加">+</button>
                    </div>
                </div>
                <div class="stctx-settings-help">拖动 X/Y 滑条可以实时移动进度条。横条样式会变成很窄的长条，更适合手机输入区上方。</div>
            </div>
        </div>
    `;

    host.prepend(panel);

    const styleSelect = /** @type {HTMLSelectElement | null} */ (panel.querySelector('#stctx_meter_style'));
    const positionXInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_position_x'));
    const positionYInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_position_y'));
    const positionXValue = panel.querySelector('[data-role="position-x-value"]');
    const positionYValue = panel.querySelector('[data-role="position-y-value"]');
    const contextColorInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_context_color'));
    const promptColorInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_prompt_color'));
    const maxTokensInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_max_tokens'));
    const contextMessagesInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_context_messages'));

    syncPositionSliderLimits(panel);

    if (styleSelect) {
        styleSelect.value = settings.displayStyle;
        styleSelect.addEventListener('change', () => {
            const value = ['vertical', 'horizontal', 'verticalSlim'].includes(styleSelect.value) ? styleSelect.value : defaultSettings.displayStyle;
            saveSetting('displayStyle', value);
        });
    }

    if (positionXInput) {
        positionXInput.value = String(settings.positionX);
        if (positionXValue) {
            positionXValue.textContent = String(settings.positionX);
        }
        positionXInput.addEventListener('input', () => {
            const value = sanitizeInteger(positionXInput.value, defaultSettings.positionX, 0);
            positionXInput.value = String(value);
            if (positionXValue) {
                positionXValue.textContent = String(value);
            }
            saveSetting('positionX', value);
        });
    }

    if (positionYInput) {
        positionYInput.value = String(settings.positionY);
        if (positionYValue) {
            positionYValue.textContent = String(settings.positionY);
        }
        positionYInput.addEventListener('input', () => {
            const value = sanitizeInteger(positionYInput.value, defaultSettings.positionY, 0);
            positionYInput.value = String(value);
            if (positionYValue) {
                positionYValue.textContent = String(value);
            }
            saveSetting('positionY', value);
        });
    }

    if (contextColorInput) {
        contextColorInput.value = settings.contextColor;
        contextColorInput.addEventListener('input', () => {
            saveSetting('contextColor', sanitizeColor(contextColorInput.value, defaultSettings.contextColor));
        });
    }

    if (promptColorInput) {
        promptColorInput.value = settings.promptColor;
        promptColorInput.addEventListener('input', () => {
            saveSetting('promptColor', sanitizeColor(promptColorInput.value, defaultSettings.promptColor));
        });
    }

    if (maxTokensInput) {
        maxTokensInput.value = String(settings.maxTokens);
        maxTokensInput.addEventListener('change', () => {
            const value = sanitizeInteger(maxTokensInput.value, defaultSettings.maxTokens, 1);
            maxTokensInput.value = String(value);
            saveSetting('maxTokens', value);
        });
    }

    if (contextMessagesInput) {
        contextMessagesInput.value = String(settings.contextMessages);
        contextMessagesInput.addEventListener('change', () => {
            const value = sanitizeInteger(contextMessagesInput.value, defaultSettings.contextMessages, 1);
            contextMessagesInput.value = String(value);
            saveSetting('contextMessages', value);
        });
    }

    panel.querySelectorAll('.stctx-step-button').forEach(button => {
        button.addEventListener('click', () => {
            const target = button.getAttribute('data-step-target');
            const step = sanitizeInteger(button.getAttribute('data-step'), 0, Number.NEGATIVE_INFINITY);
            applySettingsStep(target, step, panel);
        });
    });
}

function updateSettingsUiValues(root = document) {
    const positionXInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_position_x'));
    const positionYInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_position_y'));
    const positionXValue = root.querySelector('[data-role="position-x-value"]');
    const positionYValue = root.querySelector('[data-role="position-y-value"]');
    const maxTokensInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_max_tokens'));
    const contextMessagesInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_context_messages'));

    if (positionXInput) {
        positionXInput.value = String(settings.positionX);
    }
    if (positionYInput) {
        positionYInput.value = String(settings.positionY);
    }
    if (positionXValue) {
        positionXValue.textContent = String(settings.positionX);
    }
    if (positionYValue) {
        positionYValue.textContent = String(settings.positionY);
    }
    if (maxTokensInput) {
        maxTokensInput.value = String(settings.maxTokens);
    }
    if (contextMessagesInput) {
        contextMessagesInput.value = String(settings.contextMessages);
    }
}

function applySettingsStep(target, step, root = document) {
    if (!Number.isFinite(step) || !target) {
        return;
    }

    if (target === 'positionX' || target === 'positionY') {
        const max = target === 'positionX'
            ? Math.max(window.innerWidth, settings.positionX, 1)
            : Math.max(window.innerHeight, settings.positionY, 1);
        const value = clamp(sanitizeInteger(settings[target], defaultSettings[target], 0) + step, 0, max);
        saveSetting(target, value);
        syncPositionSliderLimits(root);
        updateSettingsUiValues(root);
        return;
    }

    if (target === 'maxTokens' || target === 'contextMessages') {
        const value = sanitizeInteger(settings[target], defaultSettings[target], 1) + step;
        saveSetting(target, Math.max(1, value));
        updateSettingsUiValues(root);
    }
}

function scheduleSettingsUiRetry() {
    if (settingsUiRetryTimer) {
        return;
    }

    settingsUiRetryTimer = setTimeout(() => {
        settingsUiRetryTimer = null;
        ensureSettingsUi();
    }, 500);
}

function syncPositionSliderLimits(root = document) {
    const xInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_position_x'));
    const yInput = /** @type {HTMLInputElement | null} */ (root.querySelector('#stctx_meter_position_y'));

    if (xInput) {
        xInput.max = String(Math.max(window.innerWidth, settings.positionX, 1));
        xInput.value = String(settings.positionX);
    }

    if (yInput) {
        yInput.max = String(Math.max(window.innerHeight, settings.positionY, 1));
        yInput.value = String(settings.positionY);
    }

    updateSettingsUiValues(root);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function sanitizeInteger(value, fallback, min) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(min, parsed);
}

function sanitizeColor(value, fallback) {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(Math.max(0, Math.round(Number(value) || 0)));
}

function getUsageLevel(ratio) {
    if (ratio >= 0.9) {
        return 'danger';
    }

    if (ratio >= 0.7) {
        return 'warning';
    }

    if (ratio >= 0.45) {
        return 'mid';
    }

    return 'safe';
}

function getRecentContextText(context) {
    const limit = sanitizeInteger(settings.contextMessages, defaultSettings.contextMessages, 1);
    const messages = Array.isArray(context.chat) ? context.chat : [];

    return messages
        .filter(message => message?.mes && !message?.is_system)
        .slice(-limit)
        .map(message => String(message.mes).trim())
        .filter(Boolean)
        .join('\n');
}

async function countTokens(context, text) {
    const trimmed = String(text || '').trim();
    return trimmed ? await context.getTokenCountAsync(trimmed) : 0;
}

function flattenPrompt(prompt) {
    if (Array.isArray(prompt)) {
        return prompt
            .map(item => typeof item === 'string' ? item : item?.content)
            .filter(Boolean)
            .join('\n');
    }

    return String(prompt || '');
}

function readPromptViewerTotalFromDom() {
    const bodyText = document.body?.innerText || '';
    const match = bodyText.match(/总\s*token\s*数?\s*[:：]\s*([\d,]+)/i)
        || bodyText.match(/total\s*tokens?\s*[:：]\s*([\d,]+)/i);

    if (!match) {
        return null;
    }

    const parsed = Number.parseInt(match[1].replace(/,/g, ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getLatestItemizedPrompt() {
    if (!Array.isArray(itemizedPrompts) || itemizedPrompts.length === 0) {
        return null;
    }

    return itemizedPrompts[itemizedPrompts.length - 1] ?? null;
}

async function getItemizedPromptTokens(context) {
    const latestPrompt = getLatestItemizedPrompt();
    if (!latestPrompt) {
        return null;
    }

    const directTokenFields = [
        latestPrompt.oaiTotalTokens,
        latestPrompt.finalPromptTokens,
        latestPrompt.totalTokensInPrompt,
    ];
    const directTokens = directTokenFields
        .map(value => Number(value))
        .find(value => Number.isFinite(value) && value > 0);

    if (directTokens) {
        return {
            tokens: directTokens,
            source: '提示词缓存',
            key: `itemized-direct:${latestPrompt.mesId ?? 'none'}:${directTokens}`,
        };
    }

    const promptText = flattenPrompt(latestPrompt.rawPrompt || latestPrompt.finalPrompt);
    const tokens = await countTokens(context, promptText);
    if (!tokens) {
        return null;
    }

    return {
        tokens,
        source: '提示词缓存',
        key: `itemized-text:${latestPrompt.mesId ?? 'none'}:${promptText.length}:${tokens}`,
    };
}

async function getPromptPacketTokens(context) {
    const promptViewerTokens = readPromptViewerTotalFromDom();
    if (promptViewerTokens) {
        return {
            tokens: promptViewerTokens,
            source: '提示词查看器',
            key: `viewer:${promptViewerTokens}`,
        };
    }

    const cachedPrompt = latestPromptPacket;
    if (cachedPrompt?.chatId === context.chatId && cachedPrompt.tokens > 0) {
        return cachedPrompt;
    }

    const itemized = await getItemizedPromptTokens(context);
    if (itemized) {
        return itemized;
    }

    return {
        tokens: 0,
        source: '等待提示词缓存',
        key: 'no-prompt-packet',
    };
}

async function cachePromptPacketFromGenerateData(generateData) {
    const context = getContext();
    const promptText = flattenPrompt(generateData?.prompt || generateData?.input);
    const tokens = await countTokens(context, promptText);
    if (!tokens) {
        return;
    }

    latestPromptPacket = {
        tokens,
        source: '刚组装的发送包',
        key: `generate-data:${context.chatId ?? 'no-chat'}:${promptText.length}:${tokens}`,
        chatId: context.chatId,
    };
}

async function buildStats() {
    const context = getContext();
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    const inputText = String(textarea?.value || '').trim();
    const maxTokens = sanitizeInteger(settings.maxTokens, defaultSettings.maxTokens, 1);
    const contextMessages = sanitizeInteger(settings.contextMessages, defaultSettings.contextMessages, 1);
    const contextText = getRecentContextText(context);

    const [contextTokens, promptPacket] = await Promise.all([
        countTokens(context, contextText),
        getPromptPacketTokens(context),
    ]);
    const promptTokens = promptPacket.tokens;
    const totalTokens = contextTokens + promptTokens;
    const totalRatio = maxTokens > 0 ? totalTokens / maxTokens : 0;

    return {
        contextTokens,
        inputTokens: promptTokens,
        totalTokens,
        maxTokens,
        contextMessages,
        promptSource: promptPacket.source,
        percent: Math.round(clamp(totalRatio, 0, 1) * 100),
        level: getUsageLevel(totalRatio),
        key: [
            context.chatId ?? 'no-chat',
            Array.isArray(context.chat) ? context.chat.length : 0,
            contextText.length,
            inputText,
            maxTokens,
            contextMessages,
            settings.displayStyle,
            settings.positionX,
            settings.positionY,
            promptPacket.key,
            contextTokens,
            promptTokens,
        ].join('|'),
    };
}

function paintStack(widget, stats) {
    const stack = widget.querySelector('[data-role="stack"]');
    if (!stack) {
        return;
    }

    const totalRatio = clamp(stats.totalTokens / stats.maxTokens, 0, 1);
    const contextStop = stats.totalTokens > 0 ? clamp(stats.contextTokens / stats.totalTokens, 0, 1) * 100 : 0;

    stack.style.setProperty('--stctx-total-scale', String(totalRatio));
    stack.style.setProperty('--stctx-context-stop', `${contextStop}%`);
    stack.style.setProperty('--stctx-marker-bottom', `${totalRatio * 14}em`);
    stack.style.setProperty('--stctx-marker-left', `${totalRatio * 100}%`);

    stack.querySelector('.stctx-stack-fill')?.classList.toggle('is-active', totalRatio > 0);
    stack.querySelector('.stctx-stack-fill')?.classList.toggle('is-full', totalRatio >= 0.999);
    stack.querySelector('.stctx-total-marker')?.classList.toggle('is-active', totalRatio > 0);
}

function applyWidgetAppearance(widget) {
    widget.dataset.style = settings.displayStyle;
    widget.style.setProperty('--stctx-context-color', settings.contextColor);
    widget.style.setProperty('--stctx-prompt-color', settings.promptColor);
}

function applyWidgetPlacement(widget) {
    applyWidgetAppearance(widget);
    widget.dataset.style = settings.displayStyle;
    const width = widget.offsetWidth || (settings.displayStyle === 'horizontal' ? 320 : settings.displayStyle === 'verticalSlim' ? 12 : 78);
    const height = widget.offsetHeight || (settings.displayStyle === 'horizontal' ? 12 : settings.displayStyle === 'verticalSlim' ? 224 : 132);
    let left = sanitizeInteger(settings.positionX, defaultSettings.positionX, 0);
    let top = sanitizeInteger(settings.positionY, defaultSettings.positionY, 0);

    const maxLeft = Math.max(VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);

    left = clamp(left, VIEWPORT_PADDING, maxLeft);
    top = clamp(top, VIEWPORT_PADDING, maxTop);

    widget.style.left = `${Math.round(left)}px`;
    widget.style.top = `${Math.round(top)}px`;
}

function renderStats(widget, stats) {
    if (lastRenderKey === stats.key && widget.dataset.level === stats.level) {
        applyWidgetPlacement(widget);
        return;
    }

    widget.dataset.level = stats.level;
    const stack = widget.querySelector('[data-role="stack"]');
    if (stack) {
        stack.setAttribute('title', [
            `上下文: ${formatNumber(stats.contextTokens)}`,
            `发送包: ${formatNumber(stats.inputTokens)}`,
            `合计: ${formatNumber(stats.totalTokens)} / ${formatNumber(stats.maxTokens)} (${stats.percent}%)`,
            `最近消息: ${formatNumber(stats.contextMessages)} 条`,
            `来源: ${stats.promptSource}`,
        ].join('\n'));
    }
    paintStack(widget, stats);
    lastRenderKey = stats.key;
    requestAnimationFrame(() => applyWidgetPlacement(widget));
}

async function refreshWidget() {
    const widget = ensureWidget();
    if (!widget) {
        return;
    }

    const stats = await buildStats();
    renderStats(widget, stats);
}

function bindEvents() {
    const watchedEvents = [
        event_types.APP_READY,
        event_types.CHAT_CHANGED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_DELETED,
        event_types.USER_MESSAGE_RENDERED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.GENERATION_ENDED,
        event_types.GENERATION_STOPPED,
        event_types.SETTINGS_UPDATED,
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
    ];

    watchedEvents.filter(Boolean).forEach(eventName => onExtensionEvent(eventName, () => {
        if (eventName === event_types.CHAT_CHANGED) {
            latestPromptPacket = null;
            lastPromptProbeSignature = '';
        }
        ensureSettingsUi();
        scheduleRefresh();
        schedulePromptPacketProbe();
    }));
    onExtensionEvent(event_types.GENERATION_STARTED, (_type, _options, dryRun) => {
        if (!dryRun) {
            isRealGenerationRunning = true;
        }
    });
    onExtensionEvent(event_types.GENERATION_ENDED, () => {
        isRealGenerationRunning = false;
        if (promptProbePending) {
            promptProbePending = false;
            schedulePromptPacketProbe(PROMPT_PROBE_COOLDOWN);
        }
    });
    onExtensionEvent(event_types.GENERATION_STOPPED, () => {
        isRealGenerationRunning = false;
        if (promptProbePending) {
            promptProbePending = false;
            schedulePromptPacketProbe(PROMPT_PROBE_COOLDOWN);
        }
    });
    onExtensionEvent(event_types.GENERATE_AFTER_DATA, (generateData) => {
        cachePromptPacketFromGenerateData(generateData)
            .then(() => scheduleRefresh(0))
            .catch(error => console.warn(`[${MODULE_ID}] Failed to cache prompt packet`, error));
    });
    $(document).on('input', '#send_textarea', () => {
        scheduleRefresh(80);
        schedulePromptPacketProbe(PROMPT_PROBE_INPUT_DEBOUNCE);
    });
    window.addEventListener('resize', () => {
        syncPositionSliderLimits();
        scheduleRefresh(0);
    });
    window.addEventListener('orientationchange', () => {
        syncPositionSliderLimits();
        scheduleRefresh(0);
    });
}

jQuery(() => {
    ensureSettings();
    ensureSettingsUi();
    ensureWidget();
    bindEvents();
    scheduleRefresh(0);
    schedulePromptPacketProbe(1200);

    periodicTimer = setInterval(() => {
        scheduleRefresh(0);
    }, REFRESH_INTERVAL);
});
