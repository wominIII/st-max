import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../events.js';
import { itemizedPrompts } from '../../../itemized-prompts.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE_ID = 'context-token-meter';
const SEGMENT_COUNT = 3;
const REFRESH_INTERVAL = 2000;
const POSITION_GAP = 12;
const VIEWPORT_PADDING = 8;

const defaultSettings = {
    position: 'top',
};

const settings = structuredClone(defaultSettings);

let refreshTimer = null;
let periodicTimer = null;
let lastRenderKey = '';
let isGenerating = false;

function ensureSettings() {
    if (!extension_settings[MODULE_ID]) {
        extension_settings[MODULE_ID] = {};
    }

    Object.assign(settings, defaultSettings, extension_settings[MODULE_ID]);
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
                <div class="stctx-token-meter-title">Context Tokens</div>
                <span class="stctx-token-meter-percent" data-role="percent">0%</span>
            </div>
            <div class="stctx-token-meter-text">
                <span class="stctx-token-meter-value" data-role="value">0</span>
                <span class="stctx-token-meter-limit" data-role="limit">/ 0</span>
            </div>
            <div class="chart grid" data-role="chart" aria-hidden="true">
                <div class="exercise second" data-role="exercise"></div>
            </div>
            <div class="stctx-token-meter-note" data-role="note">等待上下文</div>
        </div>
    `;

    const exercise = widget.querySelector('[data-role="exercise"]');
    const colorClasses = ['navy', 'yellow', 'red'];
    for (let i = 0; i < SEGMENT_COUNT; i++) {
        const segment = document.createElement('div');
        segment.className = `bar lightGray-face ${colorClasses[i]}`;
        segment.dataset.index = String(i);
        segment.innerHTML = `
            <div class="face top"><div class="growing-bar"></div></div>
            <div class="face side-0"><div class="growing-bar"></div></div>
            <div class="face floor"><div class="growing-bar"></div></div>
            <div class="face side-a"></div>
            <div class="face side-b"></div>
            <div class="face side-1"><div class="growing-bar"></div></div>
        `;
        exercise.append(segment);
    }

    document.body.append(widget);
    applyWidgetPlacement(widget);
    return widget;
}

function ensureSettingsUi() {
    if (document.getElementById('stctx_token_meter_settings')) {
        return;
    }

    const host = document.getElementById('extensions_settings2');
    if (!host) {
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'stctx_token_meter_settings';
    panel.className = 'stctx-token-meter-settings';
    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>上下文 Token 条</b>
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
                </div>
                <div class="stctx-settings-help">组件会以最高层浮在聊天输入区附近，避免被发送按钮和别的浮层挡住。</div>
            </div>
        </div>
    `;

    host.prepend(panel);

    const positionSelect = /** @type {HTMLSelectElement | null} */ (panel.querySelector('#stctx_meter_position'));
    if (positionSelect) {
        positionSelect.value = settings.position;
        positionSelect.addEventListener('change', () => {
            saveSetting('position', positionSelect.value || defaultSettings.position);
        });
    }
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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

function getMaxContext(context, latestPrompt) {
    if (latestPrompt?.main_api === 'openai' || context.mainApi === 'openai') {
        const maxContext = Number(context.chatCompletionSettings?.openai_max_context || 0);
        const maxResponse = Number(context.chatCompletionSettings?.openai_max_tokens || 0);
        return Math.max(1, maxContext - maxResponse);
    }

    if (latestPrompt?.this_max_context) {
        return Math.max(1, Number(latestPrompt.this_max_context));
    }

    return Math.max(1, Number(context.maxContext || 0));
}

function getLatestPrompt() {
    if (!Array.isArray(itemizedPrompts) || itemizedPrompts.length === 0) {
        return null;
    }

    return itemizedPrompts[itemizedPrompts.length - 1] ?? null;
}

function getLastUserMessage(context) {
    const messages = Array.isArray(context.chat) ? context.chat : [];
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.is_user && !message?.is_system) {
            return String(message.mes || '').trim();
        }
    }

    return '';
}

async function getFallbackTokenCount(context, draft) {
    const messages = (Array.isArray(context.chat) ? context.chat : [])
        .filter(message => message?.mes && !message?.is_system)
        .map(message => String(message.mes));

    const lastUserMessage = getLastUserMessage(context);
    if (draft && draft !== lastUserMessage) {
        messages.push(draft);
    }

    const text = messages.join('\n');
    return text ? await context.getTokenCountAsync(text) : 0;
}

async function buildStats() {
    const context = getContext();
    const latestPrompt = getLatestPrompt();
    const textarea = /** @type {HTMLTextAreaElement | null} */ (document.getElementById('send_textarea'));
    const draft = String(textarea?.value || '').trim();
    const maxTokens = getMaxContext(context, latestPrompt);

    let usedTokens = 0;
    let note = '按最近一次实际上下文计算';
    let source = 'prompt-cache';

    if (latestPrompt) {
        if (latestPrompt.main_api === 'openai') {
            usedTokens = Number(latestPrompt.oaiTotalTokens || 0);
        } else if (latestPrompt.finalPrompt) {
            usedTokens = await context.getTokenCountAsync(String(latestPrompt.finalPrompt));
        }
    }

    if (!usedTokens) {
        usedTokens = await getFallbackTokenCount(context, draft);
        note = '按当前聊天内容估算';
        source = 'chat-fallback';
    }

    let draftTokens = 0;
    const lastUserMessage = getLastUserMessage(context);
    if (!isGenerating && draft && draft !== lastUserMessage) {
        draftTokens = await context.getTokenCountAsync(draft);
        usedTokens += draftTokens;
        note = latestPrompt ? `包含当前输入预估 +${draftTokens}` : '聊天内容 + 当前输入估算';
        source += '+draft';
    }

    const ratio = clamp(maxTokens > 0 ? usedTokens / maxTokens : 0, 0, 1.25);
    const percent = Math.round(clamp(ratio, 0, 1) * 100);

    return {
        usedTokens,
        maxTokens,
        percent,
        note,
        source,
        level: getUsageLevel(ratio),
        key: [
            latestPrompt?.mesId ?? 'none',
            latestPrompt?.oaiTotalTokens ?? 'no-oai-total',
            latestPrompt?.finalPrompt?.length ?? 'no-final',
            draft,
            maxTokens,
            usedTokens,
            source,
            settings.position,
        ].join('|'),
    };
}

function paintSegments(widget, ratio) {
    const segments = widget.querySelectorAll('.bar');
    segments.forEach((segment, index) => {
        const segmentStart = index / SEGMENT_COUNT;
        const segmentFill = clamp((ratio - segmentStart) * SEGMENT_COUNT, 0, 1);
        segment.style.setProperty('--stctx-fill', `${Math.round(segmentFill * 100)}%`);
        segment.classList.toggle('is-active', segmentFill > 0);
        segment.classList.toggle('is-full', segmentFill >= 0.999);
    });
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
    const width = widget.offsetWidth || 132;
    const height = widget.offsetHeight || 118;

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
    widget.querySelector('[data-role="value"]').textContent = formatNumber(stats.usedTokens);
    widget.querySelector('[data-role="limit"]').textContent = `/ ${formatNumber(stats.maxTokens)}`;
    widget.querySelector('[data-role="percent"]').textContent = `${stats.percent}%`;
    widget.querySelector('[data-role="note"]').textContent = stats.note;
    paintSegments(widget, stats.maxTokens > 0 ? stats.usedTokens / stats.maxTokens : 0);
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
        event_types.GENERATION_STARTED,
        event_types.GENERATION_ENDED,
        event_types.GENERATION_STOPPED,
        event_types.SETTINGS_UPDATED,
        event_types.MAIN_API_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED,
        event_types.CHATCOMPLETION_MODEL_CHANGED,
    ];

    watchedEvents.forEach(eventName => eventSource.on(eventName, () => scheduleRefresh()));
    eventSource.on(event_types.GENERATION_STARTED, () => {
        isGenerating = true;
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        isGenerating = false;
    });
    eventSource.on(event_types.GENERATION_STOPPED, () => {
        isGenerating = false;
    });

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
