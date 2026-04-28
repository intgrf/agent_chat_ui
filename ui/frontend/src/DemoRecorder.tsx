import { useCallback, useEffect, useRef, useState } from 'react'

type RecordingMode = 'html' | null

type DemoAction =
  | {
      type: 'click'
      at: number
      selector: string
      x: number
      y: number
    }
  | {
      type: 'input'
      at: number
      selector: string
      value: string
    }
  | {
      type: 'keydown'
      at: number
      selector: string
      key: string
    }
  | {
      type: 'scroll'
      at: number
      selector: string
      scrollTop: number
      scrollLeft: number
      bottomOffset?: number
      manual?: boolean
    }
  | {
      type: 'hover'
      at: number
      selector: string
      x: number
      y: number
    }
  | {
      type: 'hover-clear'
      at: number
    }

type DemoNetworkEvent = {
  at: number
  channel: 'chat' | 'log'
  direction: 'in' | 'out' | 'open' | 'close'
  data?: string
}

type DemoSnapshot = {
  at: number
  html: string
  scrolls: Array<{
    selector: string
    scrollTop: number
    scrollLeft: number
    bottomOffset?: number
    manual?: boolean
  }>
}

type DemoSession = {
  version: 1
  createdAt: string
  title: string
  durationMs: number
  viewport: {
    width: number
    height: number
    devicePixelRatio: number
  }
  url: string
  userAgent: string
  localStorage: Record<string, string>
  styles: string
  initialHtml: string
  actions: DemoAction[]
  network: DemoNetworkEvent[]
  snapshots: DemoSnapshot[]
}

type DemoNetworkDetail = Omit<DemoNetworkEvent, 'at'>

declare global {
  interface WindowEventMap {
    'demo:network': CustomEvent<DemoNetworkDetail>
  }
}

const RECORDER_SELECTOR = '.demo-recorder'
const ROOT_SELECTOR = '#root'
const SNAPSHOT_DEBOUNCE_MS = 180
const STREAM_SNAPSHOT_INTERVAL_MS = 36
const SCROLL_THROTTLE_MS = 48
const HOVER_THROTTLE_MS = 120
const MANUAL_SCROLL_WINDOW_MS = 900

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function getFileStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safeJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function cssString(value: string) {
  return value.replace(/<\/style/gi, '<\\/style')
}

function scriptString(value: string) {
  return value.replace(/<\/script/gi, '<\\/script')
}

function getLocalStorageSnapshot() {
  const snapshot: Record<string, string> = {}
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null) snapshot[key] = localStorage.getItem(key) ?? ''
    }
  } catch {
    /* ignore */
  }
  return snapshot
}

function getRootHtml() {
  const root = document.querySelector(ROOT_SELECTOR)
  if (!root) return ''
  const clone = root.cloneNode(true) as HTMLElement
  clone.querySelectorAll(RECORDER_SELECTOR).forEach((node) => node.remove())
  return clone.innerHTML
}

function getSelector(element: Element | null) {
  if (!element) return ROOT_SELECTOR
  const demoElement = element.closest<HTMLElement>('[data-demo-id]')
  if (demoElement?.dataset.demoId) return `[data-demo-id="${CSS.escape(demoElement.dataset.demoId)}"]`
  if (element.id) return `#${CSS.escape(element.id)}`

  const parts: string[] = []
  let current: Element | null = element
  while (current && current !== document.body && current !== document.documentElement && parts.length < 5) {
    const parent: Element | null = current.parentElement
    const tag = current.tagName.toLowerCase()
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const currentTagName = current.tagName
    const siblings = Array.from(parent.children).filter((node): node is Element => node.tagName === currentTagName)
    const index = siblings.indexOf(current) + 1
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag)
    current = parent
  }
  return parts.length ? parts.join(' > ') : ROOT_SELECTOR
}

function getScrollPayload(selector: string, element: HTMLElement, manual?: boolean) {
  return {
    selector,
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
    bottomOffset: Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop),
    ...(manual !== undefined ? { manual } : {}),
  }
}

function getTrackedScrolls(options: { messagesManual?: boolean } = {}) {
  return ['[data-demo-id="messages"]', '[data-demo-id="logs-body"]']
    .flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return []
      return [getScrollPayload(selector, element, selector === '[data-demo-id="messages"]' ? options.messagesManual : undefined)]
    })
}

async function collectStyles() {
  const chunks: string[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n')
      if (rules) {
        chunks.push(rules)
        continue
      }
    } catch {
      const href = sheet.href
      if (!href) continue
      try {
        const response = await fetch(href)
        if (response.ok) chunks.push(await response.text())
      } catch {
        /* ignore cross-origin styles */
      }
    }
  }
  return chunks.join('\n\n')
}

function buildReplayHtml(session: DemoSession) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Demo replay ${new Date(session.createdAt).toLocaleString('ru-RU')}</title>
  <style>
${cssString(session.styles)}
    .demo-recorder { display: none !important; }
    .messages .bubble,
    .messages .status-line,
    .messages .reasoning-shimmer {
      animation: none !important;
      transition: none !important;
    }
    .demo-replay-controls {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 999999;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 999px;
      color: rgba(255, 255, 255, 0.86);
      background: rgba(0, 0, 0, 0.42);
      border: 1px solid rgba(255, 255, 255, 0.14);
      backdrop-filter: blur(12px);
      font: 12px/1.2 system-ui, sans-serif;
    }
    .demo-replay-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #8cffc1;
      box-shadow: 0 0 12px rgba(140, 255, 193, 0.78);
    }
    .demo-replay-click {
      position: fixed;
      z-index: 999998;
      width: 34px;
      height: 34px;
      margin: -17px 0 0 -17px;
      border-radius: 50%;
      border: 2px solid rgba(140, 255, 193, 0.88);
      pointer-events: none;
      animation: demoReplayClick 420ms ease-out forwards;
    }
    @keyframes demoReplayClick {
      from { transform: scale(0.35); opacity: 0.95; }
      to { transform: scale(1.45); opacity: 0; }
    }
    .demo-replay-press {
      animation: demoReplayPress 260ms ease-out !important;
    }
    .demo-recorder-btn.demo-replay-hover:not(:disabled) {
      transform: translateY(-1px);
      background: color-mix(in srgb, var(--accent) 24%, transparent);
    }
    .page-toggle-btn.demo-replay-hover,
    .segmented button.demo-replay-hover {
      color: var(--text) !important;
    }
    .page-toggle-btn.demo-replay-hover {
      transform: translateY(-1px);
    }
    .theme-option.demo-replay-hover {
      border-color: var(--t-35) !important;
    }
    .logs-clear-btn.demo-replay-hover {
      background: var(--accent-dim) !important;
    }
    .list-widget-cell.left:not(:disabled).demo-replay-hover span:first-child {
      color: var(--accent) !important;
    }
    .list-widget-action.demo-replay-hover {
      filter: brightness(1.06) !important;
      transform: translateY(-1px);
    }
    .suggest-chip.demo-replay-hover {
      border-color: var(--t-35) !important;
      background: color-mix(in srgb, var(--accent) 15%, transparent) !important;
      transform: translateY(-2px);
    }
    .send-btn.demo-replay-hover {
      filter: brightness(1.07) !important;
      transform: translateY(-1px) scale(1.02) !important;
    }
    @keyframes demoReplayPress {
      0% { transform: translateY(0) scale(1); filter: none; }
      45% { transform: translateY(-1px) scale(0.97); filter: brightness(1.16); }
      100% { transform: translateY(0) scale(1); filter: none; }
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <div class="demo-replay-controls" aria-label="Demo replay status">
    <span class="demo-replay-dot" aria-hidden="true"></span>
    <span id="demo-replay-status">Replay starting...</span>
  </div>
  <script>
${scriptString(`
    const session = ${safeJson(session)};
    const root = document.getElementById('root');
    const status = document.getElementById('demo-replay-status');
    let timers = [];
    const textAnimations = new WeakMap();
    const scrollAnimations = new WeakMap();
    let messagesAutoFollow = true;

    try {
      for (const [key, value] of Object.entries(session.localStorage || {})) {
        localStorage.setItem(key, value);
      }
    } catch {
      // Local files can run with restricted storage in some browsers.
    }

    const theme = session.localStorage && session.localStorage.sb_ui_theme;
    if (theme && theme !== 'forest') {
      document.documentElement.setAttribute('data-theme', theme);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }

    function query(selector) {
      try {
        return document.querySelector(selector);
      } catch {
        return null;
      }
    }

    function setStatus(text) {
      status.textContent = text;
    }

    function applyScrolls(scrolls) {
      for (const item of scrolls || []) {
        const element = query(item.selector);
        if (element) {
          if (item.selector === '[data-demo-id="messages"]') {
            applyMessagesScroll(element, item, 360);
          } else {
            element.scrollTop = resolveScrollTop(element, item);
            element.scrollLeft = item.scrollLeft || 0;
          }
        }
      }
    }

    function easeInOutCubic(value) {
      return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
    }

    function animateScroll(element, top, left, duration) {
      const previousAnimation = scrollAnimations.get(element);
      if (
        previousAnimation &&
        Math.abs(previousAnimation.targetTop - top) < 1 &&
        Math.abs(previousAnimation.targetLeft - left) < 1
      ) {
        return;
      }
      if (previousAnimation) window.cancelAnimationFrame(previousAnimation.frameId);

      const startTop = element.scrollTop;
      const startLeft = element.scrollLeft;
      const deltaTop = top - startTop;
      const deltaLeft = left - startLeft;
      if (Math.abs(deltaTop) < 1 && Math.abs(deltaLeft) < 1) return;

      const startedAt = performance.now();
      const distance = Math.abs(deltaTop);
      const resolvedDuration = Math.max(160, Math.min(duration, 120 + distance * 0.35));

      const tick = (now) => {
        const progress = Math.min(1, (now - startedAt) / resolvedDuration);
        const eased = easeInOutCubic(progress);
        element.scrollTop = startTop + deltaTop * eased;
        element.scrollLeft = startLeft + deltaLeft * eased;
        if (progress < 1) {
          const frameId = window.requestAnimationFrame(tick);
          scrollAnimations.set(element, {
            frameId,
            targetTop: top,
            targetLeft: left,
          });
        } else {
          element.scrollTop = top;
          element.scrollLeft = left;
          scrollAnimations.delete(element);
        }
      };

      const frameId = window.requestAnimationFrame(tick);
      scrollAnimations.set(element, {
        frameId,
        targetTop: top,
        targetLeft: left,
      });
    }

    function setScrollPosition(element, top, left) {
      const previousAnimation = scrollAnimations.get(element);
      if (previousAnimation) {
        window.cancelAnimationFrame(previousAnimation.frameId);
        scrollAnimations.delete(element);
      }
      element.scrollTop = top;
      element.scrollLeft = left;
    }

    function stickMessagesToBottom(element, left) {
      setScrollPosition(element, Math.max(0, element.scrollHeight - element.clientHeight), left || 0);
    }

    function isNearBottom(element, offset) {
      return element.scrollHeight - element.clientHeight - element.scrollTop <= offset;
    }

    function isScrollTopNearBottom(element, scrollTop, offset) {
      return element.scrollHeight - element.clientHeight - scrollTop <= offset;
    }

    function isRecordedNearBottom(element, item, offset) {
      if (Number.isFinite(item.bottomOffset)) return item.bottomOffset <= offset;
      return isScrollTopNearBottom(element, item.scrollTop || 0, offset);
    }

    function resolveScrollTop(element, item) {
      const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Number.isFinite(item.bottomOffset)) {
        if (item.bottomOffset <= 24) return maxTop;
      }
      return Math.max(0, Math.min(maxTop, item.scrollTop || 0));
    }

    function applyMessagesScroll(element, item, duration) {
      const recordedNearBottom = isRecordedNearBottom(element, item, 24);
      const targetTop = resolveScrollTop(element, item);
      const isUpwardScroll = targetTop < element.scrollTop - 1;
      const treatAsManual = item.manual === true || (item.manual === undefined && !recordedNearBottom && isUpwardScroll);
      if (treatAsManual) {
        messagesAutoFollow = recordedNearBottom;
        animateScroll(element, targetTop, item.scrollLeft || 0, duration);
        return;
      }

      if (messagesAutoFollow || recordedNearBottom) {
        messagesAutoFollow = true;
        stickMessagesToBottom(element, item.scrollLeft);
      }
    }

    function scrollMessagesToBottom() {
      const messages = query('[data-demo-id="messages"]');
      if (!messages || !messagesAutoFollow) return;
      stickMessagesToBottom(messages, messages.scrollLeft);
    }

    function scheduleMessagesAutoFollow() {
      requestAnimationFrame(() => {
        scrollMessagesToBottom();
        window.setTimeout(scrollMessagesToBottom, 90);
        window.setTimeout(scrollMessagesToBottom, 240);
      });
    }

    function updateRegion(nextRoot, selector) {
      const current = query(selector);
      const next = nextRoot.querySelector(selector);
      if (!current || !next) return false;
      if (current.innerHTML !== next.innerHTML) {
        current.innerHTML = next.innerHTML;
      }
      return true;
    }

    function stopTextAnimation(element) {
      const frame = textAnimations.get(element);
      if (frame) window.cancelAnimationFrame(frame);
      textAnimations.delete(element);
    }

    function animateText(element, targetText) {
      const startText = element.textContent || '';
      if (startText === targetText) return true;
      if (!targetText.startsWith(startText)) return false;

      stopTextAnimation(element);
      const startedAt = performance.now();
      const charsPerMs = 2 / 18;
      const missing = targetText.length - startText.length;

      const tick = (now) => {
        const nextLength = Math.min(targetText.length, startText.length + Math.max(1, Math.floor((now - startedAt) * charsPerMs)));
        element.textContent = targetText.slice(0, nextLength);
        if (messagesAutoFollow) scrollMessagesToBottom();
        if (nextLength < targetText.length) {
          textAnimations.set(element, window.requestAnimationFrame(tick));
        } else {
          textAnimations.delete(element);
        }
      };

      if (missing > 0) {
        textAnimations.set(element, window.requestAnimationFrame(tick));
      }
      return true;
    }

    function syncStreamingText(currentItem, nextItem) {
      const currentText = currentItem.querySelector('.stream-plain, .reasoning-text, .status-text');
      const nextText = nextItem.querySelector('.stream-plain, .reasoning-text, .status-text');
      if (!currentText || !nextText) return false;
      if (currentText.className !== nextText.className) return false;

      const currentClone = currentItem.cloneNode(true);
      const nextClone = nextItem.cloneNode(true);
      const currentCloneText = currentClone.querySelector('.stream-plain, .reasoning-text, .status-text');
      const nextCloneText = nextClone.querySelector('.stream-plain, .reasoning-text, .status-text');
      if (!currentCloneText || !nextCloneText) return false;
      currentCloneText.textContent = '';
      nextCloneText.textContent = '';
      if (currentClone.innerHTML !== nextClone.innerHTML) return false;

      return animateText(currentText, nextText.textContent || '');
    }

    function syncMessageList(nextRoot) {
      const current = query('[data-demo-id="messages"]');
      const next = nextRoot.querySelector('[data-demo-id="messages"]');
      if (!current || !next) return false;

      const currentItems = Array.from(current.children);
      const nextItems = Array.from(next.children);
      const previousScrollHeight = current.scrollHeight;
      const previousCount = currentItems.length;

      for (let index = 0; index < nextItems.length; index += 1) {
        const currentItem = currentItems[index];
        const nextItem = nextItems[index];
        if (!currentItem) {
          current.appendChild(nextItem.cloneNode(true));
          continue;
        }
        if (currentItem.className !== nextItem.className) {
          currentItem.replaceWith(nextItem.cloneNode(true));
          continue;
        }
        if (currentItem.innerHTML !== nextItem.innerHTML) {
          if (!syncStreamingText(currentItem, nextItem)) {
            currentItem.innerHTML = nextItem.innerHTML;
          }
        }
      }

      for (let index = current.children.length - 1; index >= nextItems.length; index -= 1) {
        current.children[index].remove();
      }

      if (messagesAutoFollow && (nextItems.length > previousCount || current.scrollHeight > previousScrollHeight)) {
        scheduleMessagesAutoFollow();
      }

      return true;
    }

    function updateAttributeRegion(nextRoot, selector) {
      const current = query(selector);
      const next = nextRoot.querySelector(selector);
      if (!current || !next) return false;
      current.className = next.className;
      current.setAttribute('aria-selected', next.getAttribute('aria-selected') || '');
      current.setAttribute('aria-pressed', next.getAttribute('aria-pressed') || '');
      return true;
    }

    function applySnapshot(snapshot) {
      if (!root.innerHTML) {
        root.innerHTML = snapshot.html;
        requestAnimationFrame(() => applyScrolls(snapshot.scrolls));
        return;
      }

      const template = document.createElement('template');
      template.innerHTML = snapshot.html;
      const nextRoot = template.content;
      const currentStage = query('.main-stage, .widgets-page, .settings-page');
      const nextStage = nextRoot.querySelector('.main-stage, .widgets-page, .settings-page');
      const stageChanged = !currentStage || !nextStage || currentStage.className !== nextStage.className;

      if (stageChanged) {
        root.innerHTML = snapshot.html;
      } else {
        syncMessageList(nextRoot);
        updateRegion(nextRoot, '[data-demo-id="logs-body"]');
        updateRegion(nextRoot, '.token-pill');
        updateRegion(nextRoot, '.input-row');
        updateAttributeRegion(nextRoot, '[data-demo-id="tab-chat"]');
        updateAttributeRegion(nextRoot, '[data-demo-id="tab-widgets"]');
        updateAttributeRegion(nextRoot, '[data-demo-id="tab-settings"]');
      }

      requestAnimationFrame(() => applyScrolls(snapshot.scrolls));
    }

    function clickPulse(action) {
      const pulse = document.createElement('span');
      pulse.className = 'demo-replay-click';
      pulse.style.left = action.x + 'px';
      pulse.style.top = action.y + 'px';
      document.body.appendChild(pulse);
      window.setTimeout(() => pulse.remove(), 460);
    }

    function pressElement(element) {
      element.classList.remove('demo-replay-press');
      // Force animation restart when the same button is clicked several times.
      void element.offsetWidth;
      element.classList.add('demo-replay-press');
      window.setTimeout(() => element.classList.remove('demo-replay-press'), 280);
    }

    function applyAction(action) {
      const element = query(action.selector);
      if (!element) return;
      if (action.type === 'input') {
        element.value = action.value;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: action.value }));
      } else if (action.type === 'keydown') {
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: action.key }));
      } else if (action.type === 'click') {
        clickPulse(action);
        pressElement(element);
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: action.x, clientY: action.y }));
      } else if (action.type === 'hover') {
        document.querySelectorAll('.demo-replay-hover').forEach((node) => node.classList.remove('demo-replay-hover'));
        element.classList.add('demo-replay-hover');
        element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: action.x, clientY: action.y }));
        element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, clientX: action.x, clientY: action.y }));
      } else if (action.type === 'hover-clear') {
        document.querySelectorAll('.demo-replay-hover').forEach((node) => node.classList.remove('demo-replay-hover'));
      } else if (action.type === 'scroll') {
        if (action.selector === '[data-demo-id="messages"]') {
          applyMessagesScroll(element, action, 420);
        } else {
          element.scrollTop = resolveScrollTop(element, action);
          element.scrollLeft = action.scrollLeft;
        }
      }
    }

    function startReplay() {
      timers.forEach(clearTimeout);
      timers = [];
      applySnapshot({ html: session.initialHtml, scrolls: [] });
      setStatus('Replay 0.0s');

      for (const snapshot of session.snapshots) {
        timers.push(window.setTimeout(() => applySnapshot(snapshot), snapshot.at));
      }
      for (const action of session.actions) {
        timers.push(window.setTimeout(() => applyAction(action), action.at));
      }

      const ticker = window.setInterval(() => {
        const elapsed = Math.min(session.durationMs, performance.now() - startedAt);
        setStatus('Replay ' + (elapsed / 1000).toFixed(1) + 's');
        if (elapsed >= session.durationMs) {
          window.clearInterval(ticker);
          setStatus('Replay complete');
        }
      }, 120);
      timers.push(ticker);
    }

    const startedAt = performance.now();
    startReplay();
`)}
  </script>
</body>
</html>`
}

export function DemoRecorder() {
  const [mode, setMode] = useState<RecordingMode>(null)
  const [message, setMessage] = useState('Готово к записи демо')
  const startedAtRef = useRef(0)
  const actionsRef = useRef<DemoAction[]>([])
  const networkRef = useRef<DemoNetworkEvent[]>([])
  const snapshotsRef = useRef<DemoSnapshot[]>([])
  const initialHtmlRef = useRef('')
  const stylesRef = useRef('')
  const localStorageRef = useRef<Record<string, string>>({})
  const observerRef = useRef<MutationObserver | null>(null)
  const snapshotTimerRef = useRef<number | null>(null)
  const streamSnapshotIntervalRef = useRef<number | null>(null)
  const lastSnapshotRef = useRef('')
  const lastScrollAtRef = useRef(0)
  const lastMessagesScrollTopRef = useRef(0)
  const manualMessagesScrollUntilRef = useRef(0)
  const messagesManualScrollRef = useRef(false)
  const lastHoverAtRef = useRef(0)
  const lastHoverSelectorRef = useRef('')

  const elapsed = useCallback(() => Math.max(0, Math.round(performance.now() - startedAtRef.current)), [])

  const pushSnapshot = useCallback(() => {
    const html = getRootHtml()
    if (!html || html === lastSnapshotRef.current) return
    lastSnapshotRef.current = html
    snapshotsRef.current.push({
      at: elapsed(),
      html,
      scrolls: getTrackedScrolls({ messagesManual: messagesManualScrollRef.current }),
    })
  }, [elapsed])

  const scheduleSnapshot = useCallback(() => {
    window.clearTimeout(snapshotTimerRef.current ?? undefined)
    snapshotTimerRef.current = window.setTimeout(pushSnapshot, SNAPSHOT_DEBOUNCE_MS)
  }, [pushSnapshot])

  const stopHtmlRecording = useCallback(async () => {
    window.clearTimeout(snapshotTimerRef.current ?? undefined)
    window.clearInterval(streamSnapshotIntervalRef.current ?? undefined)
    streamSnapshotIntervalRef.current = null
    observerRef.current?.disconnect()
    observerRef.current = null
    pushSnapshot()

    const session: DemoSession = {
      version: 1,
      createdAt: new Date().toISOString(),
      title: document.title || 'Demo replay',
      durationMs: elapsed(),
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      url: window.location.href,
      userAgent: navigator.userAgent,
      localStorage: localStorageRef.current,
      styles: stylesRef.current,
      initialHtml: initialHtmlRef.current,
      actions: actionsRef.current,
      network: networkRef.current,
      snapshots: snapshotsRef.current,
    }
    const stamp = getFileStamp()
    downloadBlob(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json;charset=utf-8' }), `demo-session-${stamp}.json`)
    downloadBlob(new Blob([buildReplayHtml(session)], { type: 'text/html;charset=utf-8' }), `demo-replay-${stamp}.html`)
    setMode(null)
    setMessage(`HTML replay сохранён: ${session.actions.length} действий, ${session.snapshots.length} кадров`)
  }, [elapsed, pushSnapshot])

  const startHtmlRecording = useCallback(async () => {
    startedAtRef.current = performance.now()
    actionsRef.current = []
    networkRef.current = []
    snapshotsRef.current = []
    lastSnapshotRef.current = ''
    messagesManualScrollRef.current = false
    lastMessagesScrollTopRef.current = 0
    initialHtmlRef.current = getRootHtml()
    localStorageRef.current = getLocalStorageSnapshot()
    stylesRef.current = await collectStyles()

    const root = document.querySelector(ROOT_SELECTOR)
    if (root) {
      observerRef.current = new MutationObserver(scheduleSnapshot)
      observerRef.current.observe(root, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      })
    }
    streamSnapshotIntervalRef.current = window.setInterval(pushSnapshot, STREAM_SNAPSHOT_INTERVAL_MS)

    setMode('html')
    setMessage('Идёт HTML replay-запись: действия, DOM и ответы чата сохраняются.')
  }, [pushSnapshot, scheduleSnapshot])

  const recordAction = useCallback(
    (action: DemoAction) => {
      if (mode !== 'html') return
      actionsRef.current.push(action)
    },
    [mode],
  )

  useEffect(() => {
    if (mode !== 'html') return undefined

    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(RECORDER_SELECTOR)) return
      recordAction({
        type: 'click',
        at: elapsed(),
        selector: getSelector(target),
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      })
    }

    const onInput = (event: Event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return
      if (target.closest(RECORDER_SELECTOR)) return
      recordAction({
        type: 'input',
        at: elapsed(),
        selector: getSelector(target),
        value: target.value,
      })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(RECORDER_SELECTOR)) return
      if (
        target?.closest('[data-demo-id="messages"]') &&
        ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      ) {
        manualMessagesScrollUntilRef.current = performance.now() + MANUAL_SCROLL_WINDOW_MS
      }
      recordAction({
        type: 'keydown',
        at: elapsed(),
        selector: getSelector(target),
        key: event.key,
      })
    }

    const onScroll = (event: Event) => {
      const now = performance.now()
      if (now - lastScrollAtRef.current < SCROLL_THROTTLE_MS) return
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (target.closest(RECORDER_SELECTOR)) return
      const selector = getSelector(target)
      const isMessagesScroll = selector === '[data-demo-id="messages"]'
      const isNearBottom = isMessagesScroll ? target.scrollHeight - target.clientHeight - target.scrollTop <= 24 : false
      const likelyManualByInput = isMessagesScroll && now <= manualMessagesScrollUntilRef.current
      let manual = isMessagesScroll && likelyManualByInput
      if (selector === '[data-demo-id="messages"]') {
        const moved = Math.abs(target.scrollTop - lastMessagesScrollTopRef.current) > 1
        const likelyManualByDirection = target.scrollTop < lastMessagesScrollTopRef.current - 1
        if (!isNearBottom && moved && (likelyManualByInput || messagesManualScrollRef.current || likelyManualByDirection)) {
          manual = true
          messagesManualScrollRef.current = true
        } else if (manual) {
          messagesManualScrollRef.current = !isNearBottom
        } else if (isNearBottom) {
          messagesManualScrollRef.current = false
        }
        lastMessagesScrollTopRef.current = target.scrollTop
      }
      lastScrollAtRef.current = now
      recordAction({
        type: 'scroll',
        at: elapsed(),
        selector,
        scrollTop: target.scrollTop,
        scrollLeft: target.scrollLeft,
        bottomOffset: Math.max(0, target.scrollHeight - target.clientHeight - target.scrollTop),
        manual,
      })
    }

    const markManualMessagesScroll = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('[data-demo-id="messages"]')) return
      manualMessagesScrollUntilRef.current = performance.now() + MANUAL_SCROLL_WINDOW_MS
    }

    const onPointerMove = (event: PointerEvent) => {
      const now = performance.now()
      if (now - lastHoverAtRef.current < HOVER_THROTTLE_MS) return
      const target = event.target instanceof Element ? event.target : null
      const hoverTarget = target?.closest<HTMLElement>('button, a, input, textarea, select, [role="button"], [role="tab"], [role="switch"]')
      if (!hoverTarget || hoverTarget.closest(RECORDER_SELECTOR)) {
        if (lastHoverSelectorRef.current) {
          lastHoverAtRef.current = now
          lastHoverSelectorRef.current = ''
          recordAction({
            type: 'hover-clear',
            at: elapsed(),
          })
        }
        return
      }
      const selector = getSelector(hoverTarget)
      if (selector === lastHoverSelectorRef.current) return
      lastHoverAtRef.current = now
      lastHoverSelectorRef.current = selector
      recordAction({
        type: 'hover',
        at: elapsed(),
        selector,
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      })
    }

    const onNetwork = (event: CustomEvent<DemoNetworkDetail>) => {
      networkRef.current.push({
        at: elapsed(),
        ...event.detail,
      })
    }

    document.addEventListener('click', onClick, true)
    document.addEventListener('input', onInput, true)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('wheel', markManualMessagesScroll, true)
    document.addEventListener('touchstart', markManualMessagesScroll, true)
    document.addEventListener('pointerdown', markManualMessagesScroll, true)
    document.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('demo:network', onNetwork)

    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('input', onInput, true)
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('wheel', markManualMessagesScroll, true)
      document.removeEventListener('touchstart', markManualMessagesScroll, true)
      document.removeEventListener('pointerdown', markManualMessagesScroll, true)
      document.removeEventListener('pointermove', onPointerMove, true)
      window.removeEventListener('demo:network', onNetwork)
    }
  }, [elapsed, mode, recordAction])

  useEffect(() => {
    return () => {
      window.clearTimeout(snapshotTimerRef.current ?? undefined)
      window.clearInterval(streamSnapshotIntervalRef.current ?? undefined)
      observerRef.current?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (mode === null) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void stopHtmlRecording()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mode, stopHtmlRecording])

  return (
    <div className={`demo-recorder${mode ? ' recording' : ''}`} aria-label="Запись демо">
      <span className="demo-recorder-status">{mode === 'html' ? 'HTML запись' : 'Демо'}</span>
      <div className="demo-recorder-actions">
        {mode === 'html' ? (
          <button type="button" className="demo-recorder-btn stop" onClick={stopHtmlRecording}>
            Стоп HTML
          </button>
        ) : (
          <button type="button" className="demo-recorder-btn" disabled={mode !== null} onClick={startHtmlRecording}>
            HTML
          </button>
        )}
      </div>
      <span className="demo-recorder-hint">{message}</span>
    </div>
  )
}
