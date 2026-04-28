import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_ID = 'context-token-meter';
const REFRESH_INTERVAL = 1600;
const POSITION_GAP = 12;
const VIEWPORT_PADDING = 8;

const defaultSettings = {
    position: 'top',
    maxTokens: 8192,
    contextMessages: 20,
};

const settings = structuredClone(defaultSettings);

let refreshTimer = null;
let periodicTimer = null;
let settingsUiRetryTimer = null;
let lastRenderKey = '';

function ensureSettings() {
    if (!extension_settings[MODULE_ID]) {
        extension_settings[MODULE_ID] = {};
    }

    Object.assign(settings, defaultSettings, extension_settings[MODULE_ID]);
    settings.maxTokens = sanitizeInteger(settings.maxTokens, defaultSettings.maxTokens, 1);
    settings.contextMessages = sanitizeInteger(settings.contextMessages, defaultSettings.contextMessages, 1);

    Object.assign(extension_settings[MODULE_ID], settings);
}

function saveSetting(key, value) {
    settings[key] = value;
    Object.assign(extension_settings[MODULE_ID], settings);
    saveSettingsDebounced();
    scheduleRefresh(0);
}

function scheduleRefresh(delay = 120) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshWidget().catch(error => console.warn(`[${MODULE_ID}] Refresh failed`, error));
    }, delay);
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
        applyWidgetPlacement(widget);
        return widget;
    }

    widget = document.createElement('div');
    widget.id = 'stctx_token_meter';
    widget.className = 'stctx-token-meter';
    widget.innerHTML = `
        <div class="stctx-token-meter-inner container">
            <div class="stctx-token-meter-header">
                <div class="stctx-token-meter-title">Token Progress</div>
                <span class="stctx-token-meter-percent" data-role="percent">0%</span>
            </div>
            <div class="chart grid" data-role="chart" aria-label="Token progress">
                <div class="exercise second">
                    <div class="stctx-stacked-progress" data-role="stack">
                        <div class="bar bar-track lightGray-face" aria-hidden="true">${createBarFaces()}</div>
                        <div class="bar bar-fill stctx-total-fill red" aria-hidden="true">${createBarFaces()}</div>
                        <div class="bar bar-fill stctx-context-fill navy" aria-hidden="true">${createBarFaces()}</div>
                        <div class="bar bar-fill stctx-input-fill yellow" aria-hidden="true">${createBarFaces()}</div>
                    </div>
                </div>
            </div>
            <div class="stctx-token-meter-legend">
                <div class="stctx-token-meter-row stctx-context-row">
                    <span>上下文</span>
                    <strong data-role="context-value">0</strong>
                </div>
                <div class="stctx-token-meter-row stctx-input-row">
                    <span>输入</span>
                    <strong data-role="input-value">0</strong>
                </div>
                <div class="stctx-token-meter-row stctx-total-row">
                    <span>合计</span>
                    <strong data-role="total-value">0</strong>
                </div>
            </div>
            <div class="stctx-token-meter-note" data-role="note">上限 8,192 · 最近 20 条</div>
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
                    <label for="stctx_meter_position">显示位置</label>
                    <select id="stctx_meter_position" class="text_pole">
                        <option value="top">上</option>
                        <option value="right">右</option>
                        <option value="bottom">下</option>
                        <option value="left">左</option>
                    </select>

                    <label for="stctx_meter_max_tokens">最高 token</label>
                    <input id="stctx_meter_max_tokens" class="text_pole" type="number" min="1" step="1">

                    <label for="stctx_meter_context_messages">读取最近消息数</label>
                    <input id="stctx_meter_context_messages" class="text_pole" type="number" min="1" step="1">
                </div>
                <div class="stctx-settings-help">同一个竖向 3D 柱里叠加显示：上下文、输入框、合计。百分比都按“最高 token”计算。</div>
            </div>
        </div>
    `;

    host.prepend(panel);

    const positionSelect = /** @type {HTMLSelectElement | null} */ (panel.querySelector('#stctx_meter_position'));
    const maxTokensInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_max_tokens'));
    const contextMessagesInput = /** @type {HTMLInputElement | null} */ (panel.querySelector('#stctx_meter_context_messages'));

    if (positionSelect) {
        positionSelect.value = settings.position;
        positionSelect.addEventListener('change', () => {
            saveSetting('position', positionSelect.value || defaultSettings.position);
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

async function buildStats() {
    const context = getContext();
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    const inputText = String(textarea?.value || '').trim();
    const maxTokens = sanitizeInteger(settings.maxTokens, defaultSettings.maxTokens, 1);
    const contextMessages = sanitizeInteger(settings.contextMessages, defaultSettings.contextMessages, 1);
    const contextText = getRecentContextText(context);

    const [contextTokens, inputTokens] = await Promise.all([
        countTokens(context, contextText),
        countTokens(context, inputText),
    ]);
    const totalTokens = contextTokens + inputTokens;
    const totalRatio = maxTokens > 0 ? totalTokens / maxTokens : 0;

    return {
        contextTokens,
        inputTokens,
        totalTokens,
        maxTokens,
        contextMessages,
        percent: Math.round(clamp(totalRatio, 0, 1) * 100),
        level: getUsageLevel(totalRatio),
        key: [
            context.chatId ?? 'no-chat',
            Array.isArray(context.chat) ? context.chat.length : 0,
            contextText.length,
            inputText,
            maxTokens,
            contextMessages,
            settings.position,
            contextTokens,
            inputTokens,
        ].join('|'),
    };
}

function paintStack(widget, stats) {
    const stack = widget.querySelector('[data-role="stack"]');
    if (!stack) {
        return;
    }

    const contextRatio = clamp(stats.contextTokens / stats.maxTokens, 0, 1);
    const inputRatio = clamp(stats.inputTokens / stats.maxTokens, 0, Math.max(0, 1 - contextRatio));
    const totalRatio = clamp(stats.totalTokens / stats.maxTokens, 0, 1);

    stack.style.setProperty('--stctx-context-scale', String(contextRatio));
    stack.style.setProperty('--stctx-input-scale', String(inputRatio));
    stack.style.setProperty('--stctx-input-bottom', `${contextRatio * 14}em`);
    stack.style.setProperty('--stctx-total-scale', String(totalRatio));

    stack.querySelector('.stctx-context-fill')?.classList.toggle('is-active', contextRatio > 0);
    stack.querySelector('.stctx-input-fill')?.classList.toggle('is-active', inputRatio > 0);
    stack.querySelector('.stctx-total-fill')?.classList.toggle('is-active', totalRatio > 0);
    stack.querySelector('.stctx-total-fill')?.classList.toggle('is-full', totalRatio >= 0.999);
}

function applyWidgetPlacement(widget) {
    const sendForm = document.getElementById('send_form');
    if (!sendForm) {
        widget.style.top = `${VIEWPORT_PADDING}px`;
        widget.style.right = `${VIEWPORT_PADDING}px`;
        widget.style.left = 'auto';
        return;
    }

    const rect = sendForm.getBoundingClientRect();
    const width = widget.offsetWidth || 180;
    const height = widget.offsetHeight || 210;

    let left = rect.left + ((rect.width - width) / 2);
    let top = rect.top - height - POSITION_GAP;

    switch (settings.position) {
        case 'right':
            left = rect.right + POSITION_GAP;
            top = rect.top + ((rect.height - height) / 2);
            break;
        case 'bottom':
            left = rect.left + ((rect.width - width) / 2);
            top = rect.bottom + POSITION_GAP;
            break;
        case 'left':
            left = rect.left - width - POSITION_GAP;
            top = rect.top + ((rect.height - height) / 2);
            break;
        case 'top':
        default:
            left = rect.left + ((rect.width - width) / 2);
            top = rect.top - height - POSITION_GAP;
            break;
    }

    left = clamp(left, VIEWPORT_PADDING, window.innerWidth - width - VIEWPORT_PADDING);
    top = clamp(top, VIEWPORT_PADDING, window.innerHeight - height - VIEWPORT_PADDING);

    widget.style.left = `${Math.round(left)}px`;
    widget.style.top = `${Math.round(top)}px`;
}

function renderStats(widget, stats) {
    if (lastRenderKey === stats.key && widget.dataset.level === stats.level) {
        applyWidgetPlacement(widget);
        return;
    }

    widget.dataset.level = stats.level;
    widget.querySelector('[data-role="context-value"]').textContent = formatNumber(stats.contextTokens);
    widget.querySelector('[data-role="input-value"]').textContent = formatNumber(stats.inputTokens);
    widget.querySelector('[data-role="total-value"]').textContent = `${formatNumber(stats.totalTokens)} / ${formatNumber(stats.maxTokens)}`;
    widget.querySelector('[data-role="percent"]').textContent = `${stats.percent}%`;
    widget.querySelector('[data-role="note"]').textContent = `上限 ${formatNumber(stats.maxTokens)} · 最近 ${formatNumber(stats.contextMessages)} 条`;
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

    watchedEvents.filter(Boolean).forEach(eventName => eventSource.on(eventName, () => {
        ensureSettingsUi();
        scheduleRefresh();
    }));
    $(document).on('input', '#send_textarea', () => scheduleRefresh(80));
    window.addEventListener('resize', () => scheduleRefresh(0));
    window.addEventListener('orientationchange', () => scheduleRefresh(0));
}

jQuery(() => {
    ensureSettings();
    ensureSettingsUi();
    ensureWidget();
    bindEvents();
    scheduleRefresh(0);

    periodicTimer = setInterval(() => {
        scheduleRefresh(0);
    }, REFRESH_INTERVAL);
});
