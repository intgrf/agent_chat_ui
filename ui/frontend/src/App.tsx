import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

type Role = 'user' | 'agent' | 'system' | 'status'

type ChatMessage = {
  id: string
  role: Role
  label: string
  body: string
  widgets?: WidgetFrame[]
  streamPos: number
  done: boolean
}

type WidgetPayload = Record<string, unknown>
type WidgetFrame = {
  name: string
  arguments: {
    version?: number
    payload: WidgetPayload
  }
}

const LIST_WITH_SUBTITLES_WIDGET: WidgetPayload = {
  items: [
    {
      id: 'Deposit',
      type: 'product',
      data: {
        content: '500 000 Р',
        message: '123',
        subtitle: 'подзаголовок 1',
        title: 'Вариант 1',
        underContent: 'условие',
      },
    },
    {
      id: 'govBondFund',
      type: 'product',
      data: {
        content: '300 000 Р',
        deeplink: 'some_url',
        message: '123',
        subtitle: 'подзаголовок 2',
        title: 'Вариант 2',
        underContent: 'Условие ~5%',
      },
    },
    {
      id: 'rusStockFund',
      type: 'product',
      data: {
        content: '400 000 Р',
        deeplink: 'some_url',
        subtitle: 'подзаголовок 3',
        title: 'Вариант 3',
        underContent: 'Условие ~10%',
      },
    },
  ],
  uiSchema: {
    items: {
      'ui:options': {
        componentTypes: {
          product: {
            'ui:fields': [
              { key: 'title', 'ui:component': 'title', 'ui:position': 'left' },
              { key: 'subtitle', 'ui:component': 'subtitle', 'ui:position': 'left' },
              { key: 'content', 'ui:component': 'details', 'ui:position': 'top' },
              { key: 'underContent', 'ui:component': 'details', 'ui:position': 'bottom' },
            ],
            'ui:actions': [
              { type: 'message', payload: { text: '{{message}}' } },
              { type: 'deeplink', payload: { text: '{{deeplink}}' } },
            ],
            'ui:cell': { clickable: true, showDivider: true },
          },
        },
      },
    },
  },
}

const SAVE_GOAL_WIDGET: WidgetPayload = {
  title: 'Название',
  items: [
    { id: 'id1', type: 'goal', data: { title: 'Категория', description: 'Название категории' } },
    { id: 'id2', type: 'goal', data: { title: 'Сумма', description: '400 000 ₽' } },
    { id: 'id3', type: 'goal', data: { title: 'Срок', description: '1 год' } },
  ],
  uiSchema: {
    items: {
      'ui:options': {
        componentTypes: {
          goal: {
            'ui:fields': [
              { key: 'title', 'ui:component': 'title', 'ui:position': 'left' },
              { key: 'description', 'ui:component': 'details', 'ui:position': 'left' },
            ],
            'ui:cell': { clickable: false, showDivider: true },
          },
        },
      },
    },
  },
  globalActions: [
    {
      type: 'message',
      label: 'Создать',
      'ui:position': 'button',
      payload: { text: 'Создать' },
    },
  ],
}

const OPERATION_LIST_WIDGET: WidgetPayload = {
  title: 'Оплата ЖКХ',
  subtitle: 'Август 2025',
  limitPreviewOperations: 3,
  buttonText: 'Показать все',
  buttonHideText: 'Скрыть',
  operations: [
    {
      title: 'Газпром',
      subtitle: '5 августа, 09:15',
      detail: '3 200 ₽',
      iconUrl: '',
    },
    {
      title: 'МосЭнергоСбыт',
      subtitle: '6 августа, 10:30',
      detail: '4 800 ₽',
      iconUrl: '',
    },
  ],
}

type ChatPayload =
  | { type: 'message'; user: string; text: string; suggestions: string[]; widget?: WidgetFrame }
  | { type: 'think'; text: string }
  | { type: 'status'; text: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeWidgetName(name: string): string {
  if (name === 'List widget' || name === 'ListWidget' || name === 'ListView') return 'list_view'
  if (
    name === 'OperationList' ||
    name === 'OperationList' ||
    name === 'OperationList' ||
    name === 'operation_list_widget'
  ) {
    return 'operation_list_widget'
  }
  return name
}

function toWidgetFrame(value: unknown): WidgetFrame | undefined {
  if (!isRecord(value)) return undefined

  if (typeof value.name === 'string' && isRecord(value.arguments)) {
    const payload = isRecord(value.arguments.payload) ? value.arguments.payload : undefined
    if (!payload) return undefined
    const version = typeof value.arguments.version === 'number' ? value.arguments.version : undefined
    return {
      name: normalizeWidgetName(value.name),
      arguments: {
        ...(version !== undefined ? { version } : {}),
        payload,
      },
    }
  }

  if (Array.isArray(value.items)) {
    return {
      name: 'list_view',
      arguments: {
        payload: value,
      },
    }
  }

  if (Array.isArray(value.operations)) {
    return {
      name: 'operation_list_widget',
      arguments: {
        payload: value,
      },
    }
  }

  return undefined
}

function parseChatFrame(raw: string): ChatPayload {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>
    if (j.type === 'status' && typeof j.text === 'string') {
      return { type: 'status', text: j.text }
    }
    if (j.type === 'think' && typeof j.text === 'string') {
      return { type: 'think', text: j.text }
    }
    if (j.type === 'message' && typeof j.user === 'string' && typeof j.text === 'string') {
      const suggestions = Array.isArray(j.suggestions)
        ? (j.suggestions as unknown[]).filter((x): x is string => typeof x === 'string')
        : []
      const widget = toWidgetFrame(j.widget)
      return { type: 'message', user: j.user, text: j.text, suggestions, widget }
    }
    const widget = toWidgetFrame(j)
    if (widget) {
      return { type: 'message', user: 'Agent', text: '', suggestions: [], widget }
    }
  } catch {
    /* legacy */
  }
  const statusMatch = raw.match(/^\s*\[status\]\s*(.+)$/i)
  if (statusMatch?.[1]) {
    return { type: 'status', text: statusMatch[1].trim() }
  }
  const colon = raw.indexOf(':')
  if (colon > 0) {
    return {
      type: 'message',
      user: raw.slice(0, colon).trim(),
      text: raw.slice(colon + 1).trim(),
      suggestions: [],
    }
  }
  return { type: 'message', user: 'System', text: raw, suggestions: [] }
}

function toStatusLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\[status\]\s*/i, '').trim())
    .filter(Boolean)
}

function roleFromUser(user: string): Role {
  const u = user.toLowerCase()
  if (u === 'user') return 'user'
  if (u === 'system') return 'system'
  return 'agent'
}

function appendWidgetToLastAgent(messages: ChatMessage[], widget: WidgetFrame): ChatMessage[] | undefined {
  let index = -1
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'agent') {
      index = i
      break
    }
  }
  if (index === -1) return undefined
  const target = messages[index]
  const next = messages.slice()
  next[index] = {
    ...target,
    widgets: [...(target.widgets ?? []), widget],
  }
  return next
}

let idCounter = 0
function nextId() {
  idCounter += 1
  return `m-${Date.now()}-${idCounter}`
}

let logLineCounter = 0
function nextLogLineId() {
  logLineCounter += 1
  return `l-${Date.now()}-${logLineCounter}`
}

const LS_SHOW_LOGS = 'sb_show_logs'
const LS_SHOW_TOKENS = 'sb_show_tokens'
const LS_CHAT_LAYOUT = 'sb_chat_layout'
const LS_UI_THEME = 'sb_ui_theme'

type ChatLayout = 'mobile' | 'desktop'
type UiTheme = 'forest' | 'ocean' | 'dusk' | 'ember'

function readStoredBool(key: string, defaultValue: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    if (v === null) return defaultValue
    return v === '1' || v === 'true'
  } catch {
    return defaultValue
  }
}

function readStoredLayout(): ChatLayout {
  try {
    const v = localStorage.getItem(LS_CHAT_LAYOUT)
    if (v === 'desktop') return 'desktop'
    return 'mobile'
  } catch {
    return 'mobile'
  }
}

const UI_THEMES: UiTheme[] = ['forest', 'ocean', 'dusk', 'ember']

function readStoredTheme(): UiTheme {
  try {
    const v = localStorage.getItem(LS_UI_THEME)
    if (v && (UI_THEMES as readonly string[]).includes(v)) return v as UiTheme
    return 'forest'
  } catch {
    return 'forest'
  }
}

type AppTab = 'chat' | 'widgets' | 'settings'

type LogLine = { id: string; text: string; at: number }

type TokenStats = {
  totalTokens: number
  promptTokens: number
  completionTokens: number
  modelName: string
}

function parseLlmLog(logEntry: string): Partial<TokenStats> | null {
  const start = logEntry.indexOf('{')
  const end = logEntry.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(logEntry.slice(start, end + 1)) as Record<string, unknown>
    const out: Partial<TokenStats> = {}
    if (typeof parsed.model_name === 'string') out.modelName = parsed.model_name
    if (typeof parsed.prompt_tokens === 'number') out.promptTokens = parsed.prompt_tokens
    if (typeof parsed.completion_tokens === 'number') out.completionTokens = parsed.completion_tokens
    if (typeof parsed.total_tokens === 'number') out.totalTokens = parsed.total_tokens
    return out
  } catch {
    return null
  }
}

function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  )
}

type ListViewProps = {
  title?: string
  subtitle?: string
  items: readonly ListViewItem[]
  payload?: WidgetPayload
  onAction?: (text: string) => void
}

type ListViewItem = ReactNode | readonly [ReactNode, ReactNode]

type ListViewAction = {
  type: string
  label?: string
  text: string
}

type RenderListViewItem =
  | { kind: 'single'; key: string; content: ReactNode }
  | {
      kind: 'pair'
      key: string
      left: ReactNode
      leftSubtitle?: ReactNode
      right?: ReactNode
      rightSubtitle?: ReactNode
      action?: ListViewAction
      clickable: boolean
    }

function isListViewPair(item: ListViewItem): item is readonly [ReactNode, ReactNode] {
  return Array.isArray(item) && item.length === 2
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function resolveTemplate(value: unknown, data: Record<string, unknown>): string | undefined {
  const template = stringFromUnknown(value)
  if (!template) return undefined
  const resolved = template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => stringFromUnknown(data[key]) ?? '')
  return resolved.trim() ? resolved : undefined
}

function getPayloadActions(value: unknown, data: Record<string, unknown>): ListViewAction[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((rawAction) => {
    if (!isRecord(rawAction)) return []
    const actionPayload = isRecord(rawAction.payload) ? rawAction.payload : {}
    const text = resolveTemplate(actionPayload.text, data)
    const type = stringFromUnknown(rawAction.type)
    if (!text || !type) return []
    return [{ type, label: stringFromUnknown(rawAction.label), text }]
  })
}

function getPayloadFields(payload: WidgetPayload, type: string) {
  const uiSchema = isRecord(payload.uiSchema) ? payload.uiSchema : {}
  const itemsSchema = isRecord(uiSchema.items) ? uiSchema.items : {}
  const options = isRecord(itemsSchema['ui:options']) ? itemsSchema['ui:options'] : {}
  const componentTypes = isRecord(options.componentTypes) ? options.componentTypes : {}
  const componentType = isRecord(componentTypes[type]) ? componentTypes[type] : {}
  const fields = Array.isArray(componentType['ui:fields']) ? componentType['ui:fields'].filter(isRecord) : []
  const actions = componentType['ui:actions']
  const cell = isRecord(componentType['ui:cell']) ? componentType['ui:cell'] : {}
  return { fields, actions, cell }
}

function pickPayloadField(
  fields: Record<string, unknown>[],
  data: Record<string, unknown>,
  predicate: (field: Record<string, unknown>) => boolean,
) {
  const field = fields.find(predicate)
  return field ? stringFromUnknown(data[stringFromUnknown(field.key) ?? '']) : undefined
}

function toRenderListItems(items: readonly ListViewItem[], payload?: WidgetPayload): RenderListViewItem[] {
  if (payload && Array.isArray(payload.items)) {
    return payload.items.flatMap((rawItem, index) => {
      if (!isRecord(rawItem)) return []
      const type = stringFromUnknown(rawItem.type) ?? ''
      const data = isRecord(rawItem.data) ? rawItem.data : {}
      const { fields, actions, cell } = getPayloadFields(payload, type)
      const leftTitle =
        pickPayloadField(fields, data, (field) => field['ui:component'] === 'title' && field['ui:position'] === 'left') ??
        stringFromUnknown(data.title) ??
        stringFromUnknown(rawItem.id) ??
        `item-${index + 1}`
      const leftSubtitle =
        pickPayloadField(fields, data, (field) => field['ui:component'] === 'subtitle' && field['ui:position'] === 'left') ??
        pickPayloadField(fields, data, (field) => field['ui:component'] === 'details' && field['ui:position'] === 'left')
      const right = pickPayloadField(fields, data, (field) => field['ui:position'] === 'top') ?? stringFromUnknown(data.content)
      const rightSubtitle =
        pickPayloadField(fields, data, (field) => field['ui:position'] === 'bottom') ?? stringFromUnknown(data.underContent)
      const action = getPayloadActions(actions, data)[0]
      return [
        {
          kind: 'pair',
          key: stringFromUnknown(rawItem.id) ?? `${type}-${index}`,
          left: leftTitle,
          leftSubtitle,
          right,
          rightSubtitle,
          action,
          clickable: cell.clickable === true && Boolean(action),
        },
      ]
    })
  }

  return items.map((item, index) => {
    if (isListViewPair(item)) {
      return { kind: 'pair', key: String(index), left: item[0], right: item[1], clickable: false }
    }
    return { kind: 'single', key: String(index), content: item }
  })
}

function getGlobalWidgetActions(payload?: WidgetPayload): ListViewAction[] {
  return getPayloadActions(payload?.globalActions, {})
}

function ListView({ title, subtitle, items, payload, onAction }: ListViewProps) {
  const widgetTitle = stringFromUnknown(payload?.title) ?? title
  const widgetSubtitle = stringFromUnknown(payload?.subtitle) ?? subtitle
  const renderItems = toRenderListItems(items, payload)
  const globalActions = getGlobalWidgetActions(payload)

  const handleAction = (action: ListViewAction) => {
    if (action.type === 'deeplink') {
      window.open(action.text, '_blank', 'noopener,noreferrer')
      return
    }
    onAction?.(action.text)
  }

  return (
    <section className="list-widget" aria-label={widgetTitle ?? 'Список'}>
      {widgetTitle || widgetSubtitle ? (
        <div className="list-widget-head">
          {widgetTitle ? <h3 className="list-widget-title">{widgetTitle}</h3> : null}
          {widgetSubtitle ? <p className="list-widget-subtitle">{widgetSubtitle}</p> : null}
        </div>
      ) : null}
      <ul className="list-widget-items">
        {renderItems.map((item) => {
          return (
            <li key={item.key} className={`list-widget-item${item.kind === 'pair' ? ' pair' : ''}`}>
              {item.kind === 'pair' ? (
                <>
                  <button
                    type="button"
                    className="list-widget-cell left"
                    disabled={!item.clickable}
                    onClick={item.action ? () => handleAction(item.action!) : undefined}
                  >
                    <span>{item.left}</span>
                    {item.leftSubtitle ? <span className="list-widget-item-subtitle">{item.leftSubtitle}</span> : null}
                  </button>
                  <span className="list-widget-cell right">
                    {item.right ? <span>{item.right}</span> : null}
                    {item.rightSubtitle ? <span className="list-widget-item-subtitle">{item.rightSubtitle}</span> : null}
                  </span>
                </>
              ) : (
                item.content
              )}
            </li>
          )
        })}
      </ul>
      {globalActions.length > 0 ? (
        <div className="list-widget-actions">
          {globalActions.map((action) => (
            <button key={`${action.type}-${action.text}`} type="button" className="list-widget-action" onClick={() => handleAction(action)}>
              {action.label ?? action.text}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  )
}

type OperationListItem = {
  key: string
  title: string
  subtitle?: string
  detail?: string
  iconUrl?: string
}

function toOperationListItems(payload: WidgetPayload): OperationListItem[] {
  if (!Array.isArray(payload.operations)) return []
  return payload.operations.flatMap((rawOperation, index) => {
    if (!isRecord(rawOperation)) return []
    const title = stringFromUnknown(rawOperation.title)
    if (!title) return []
    return [
      {
        key: stringFromUnknown(rawOperation.id) ?? `${title}-${index}`,
        title,
        subtitle: stringFromUnknown(rawOperation.subtitle),
        detail: stringFromUnknown(rawOperation.detail),
        iconUrl: stringFromUnknown(rawOperation.iconUrl),
      },
    ]
  })
}

function OperationList({ payload }: { payload: WidgetPayload }) {
  const [expanded, setExpanded] = useState(false)
  const title = stringFromUnknown(payload.title)
  const subtitle = stringFromUnknown(payload.subtitle)
  const operations = toOperationListItems(payload)
  const limitPreviewOperations =
    typeof payload.limitPreviewOperations === 'number' && payload.limitPreviewOperations > 0 ? payload.limitPreviewOperations : operations.length
  const visibleOperations = expanded ? operations : operations.slice(0, limitPreviewOperations)
  const canToggle = operations.length > limitPreviewOperations
  const buttonText = stringFromUnknown(payload.buttonText) ?? 'Показать все'
  const buttonHideText = stringFromUnknown(payload.buttonHideText) ?? 'Скрыть'

  return (
    <section className="list-widget" aria-label={title ?? 'Операции'}>
      {title || subtitle ? (
        <div className="list-widget-head">
          {title ? <h3 className="list-widget-title">{title}</h3> : null}
          {subtitle ? <p className="list-widget-subtitle">{subtitle}</p> : null}
        </div>
      ) : null}
      <ul className="operation-list-items">
        {visibleOperations.map((operation) => (
          <li key={operation.key} className="operation-list-item">
            {operation.iconUrl ? (
              <img className="operation-list-icon" src={operation.iconUrl} alt="" aria-hidden />
            ) : (
              <span className="operation-list-icon" aria-hidden>
                {operation.title.slice(0, 1)}
              </span>
            )}
            <span className="operation-list-main">
              <span>{operation.title}</span>
              {operation.subtitle ? <span className="list-widget-item-subtitle">{operation.subtitle}</span> : null}
            </span>
            {operation.detail ? <span className="operation-list-detail">{operation.detail}</span> : null}
          </li>
        ))}
      </ul>
      {canToggle ? (
        <div className="list-widget-actions">
          <button type="button" className="list-widget-action" onClick={() => setExpanded((value) => !value)}>
            {expanded ? buttonHideText : buttonText}
          </button>
        </div>
      ) : null}
    </section>
  )
}

function WidgetRenderer({ widget, onAction }: { widget: WidgetFrame; onAction?: (text: string) => void }) {
  switch (widget.name) {
    case 'list_view':
      return <ListView items={[]} payload={widget.arguments.payload} onAction={onAction} />
    case 'operation_list_widget':
      return <OperationList payload={widget.arguments.payload} />
    default:
      return (
        <section className="list-widget" aria-label="Неподдерживаемый виджет">
          <div className="list-widget-head">
            <h3 className="list-widget-title">Неподдерживаемый виджет</h3>
            <p className="list-widget-subtitle">{widget.name}</p>
          </div>
        </section>
      )
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('chat')
  const [showLogs, setShowLogs] = useState(() => readStoredBool(LS_SHOW_LOGS, false))
  const [showTokens, setShowTokens] = useState(() => readStoredBool(LS_SHOW_TOKENS, true))
  const [chatLayout, setChatLayout] = useState<ChatLayout>(() => readStoredLayout())
  const [uiTheme, setUiTheme] = useState<UiTheme>(() => readStoredTheme())

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [chatConnected, setChatConnected] = useState(false)
  const [tokens, setTokens] = useState<TokenStats>({
    totalTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    modelName: '—',
  })
  const [logLines, setLogLines] = useState<LogLine[]>([])

  const chatRef = useRef<WebSocket | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const logsScrollRef = useRef<HTMLDivElement | null>(null)
  const showLogsRef = useRef(showLogs)

  useEffect(() => {
    showLogsRef.current = showLogs
  }, [showLogs])

  useLayoutEffect(() => {
    if (uiTheme === 'forest') {
      document.documentElement.removeAttribute('data-theme')
    } else {
      document.documentElement.setAttribute('data-theme', uiTheme)
    }
  }, [uiTheme])

  useEffect(() => {
    if (!showLogs) return
    const el = logsScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [logLines, showLogs])

  const scrollToBottom = useCallback(() => {
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  useEffect(() => {
    const t = window.setInterval(() => {
      setMessages((prev) => {
        let changed = false
        const next = prev.map((m) => {
          if (m.done || m.streamPos >= m.body.length) return m
          changed = true
          const np = Math.min(m.body.length, m.streamPos + 2)
          return { ...m, streamPos: np, done: np >= m.body.length }
        })
        return changed ? next : prev
      })
    }, 18)
    return () => window.clearInterval(t)
  }, [])

  const appendUserMessage = useCallback((text: string) => {
    setSuggestions([])
    setMessages((prev) => [
      ...prev,
      {
        id: nextId(),
        role: 'user',
        label: 'You',
        body: text,
        streamPos: text.length,
        done: true,
      },
    ])
  }, [])

  const handleIncoming = useCallback(
    (raw: string) => {
      const payload = parseChatFrame(raw)
      if (payload.type === 'think' || payload.type === 'status') {
        const statusLines = toStatusLines(payload.text)
        if (statusLines.length === 0) return
        setMessages((prev) => {
          const withCompletedStatuses = prev.map((message) =>
            message.role === 'status' && !message.done
              ? { ...message, streamPos: message.body.length, done: true }
              : message,
          )
          const nextStatuses = statusLines.map((text, index) => {
            const isLast = index === statusLines.length - 1
            return {
              id: nextId(),
              role: 'status' as const,
              label: 'Status',
              body: text,
              streamPos: text.length,
              done: !isLast,
            }
          })
          return [
            ...withCompletedStatuses,
            ...nextStatuses,
          ]
        })
        return
      }
      const role = roleFromUser(payload.user)
      if (role === 'user') {
        appendUserMessage(payload.text)
        return
      }
      const sug = payload.suggestions ?? []
      setMessages((prev) => {
        const withoutStatuses = prev.filter((message) => message.role !== 'status')
        if (payload.widget && payload.text.trim() === '') {
          const withAttachedWidget = appendWidgetToLastAgent(withoutStatuses, payload.widget)
          if (withAttachedWidget) return withAttachedWidget
        }
        return [
          ...withoutStatuses,
          {
            id: nextId(),
            role,
            label: payload.user,
            body: payload.text,
            widgets: payload.widget ? [payload.widget] : undefined,
            streamPos: 0,
            done: payload.text.length === 0,
          },
        ]
      })
      setSuggestions(sug.length ? sug : [])
    },
    [appendUserMessage],
  )

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    const chat = new WebSocket(`${proto}://${host}/chat`)
    chatRef.current = chat
    chat.onopen = () => {
      setChatConnected(true)
      setMessages((p) => [
        ...p,
        {
          id: nextId(),
          role: 'system',
          label: 'System',
          body: 'Соединение установлено.',
          streamPos: 0,
          done: false,
        },
      ])
    }
    chat.onclose = () => setChatConnected(false)
    chat.onmessage = (ev) => handleIncoming(String(ev.data))
    return () => chat.close()
  }, [handleIncoming])

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = window.location.host
    const log = new WebSocket(`${proto}://${host}/log`)
    log.onmessage = (ev) => {
      const logEntry = String(ev.data)
      if (logEntry.toLowerCase().includes('llm')) {
        const patch = parseLlmLog(logEntry)
        if (patch) {
          setTokens((prev) => ({
            modelName: patch.modelName ?? prev.modelName,
            promptTokens: patch.promptTokens ?? prev.promptTokens,
            completionTokens: patch.completionTokens ?? prev.completionTokens,
            totalTokens: prev.totalTokens + (patch.totalTokens ?? 0),
          }))
        }
      }
      if (showLogsRef.current) {
        setLogLines((prev) => {
          const next = [
            ...prev,
            { id: nextLogLineId(), text: logEntry, at: Date.now() },
          ]
          return next.length > 500 ? next.slice(-500) : next
        })
      }
    }
    return () => log.close()
  }, [])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text || !chatRef.current || chatRef.current.readyState !== WebSocket.OPEN) return
    appendUserMessage(text)
    chatRef.current.send(text)
    setInput('')
  }, [input, appendUserMessage])

  const sendSuggest = useCallback(
    (text: string) => {
      if (!chatRef.current || chatRef.current.readyState !== WebSocket.OPEN) return
      appendUserMessage(text)
      chatRef.current.send(text)
      setSuggestions([])
    },
    [appendUserMessage],
  )

  const sendWidgetAction = useCallback(
    (text: string) => {
      if (!chatRef.current || chatRef.current.readyState !== WebSocket.OPEN) return
      appendUserMessage(text)
      chatRef.current.send(text)
    },
    [appendUserMessage],
  )

  const setLogsEnabled = useCallback((value: boolean) => {
    setShowLogs(value)
    try {
      localStorage.setItem(LS_SHOW_LOGS, value ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const setTokensPanelEnabled = useCallback((value: boolean) => {
    setShowTokens(value)
    try {
      localStorage.setItem(LS_SHOW_TOKENS, value ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const clearLogs = useCallback(() => setLogLines([]), [])

  const persistChatLayout = useCallback((mode: ChatLayout) => {
    setChatLayout(mode)
    try {
      localStorage.setItem(LS_CHAT_LAYOUT, mode)
    } catch {
      /* ignore */
    }
  }, [])

  const persistUiTheme = useCallback((theme: UiTheme) => {
    setUiTheme(theme)
    try {
      localStorage.setItem(LS_UI_THEME, theme)
    } catch {
      /* ignore */
    }
  }, [])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-row">
          <div className="brand">
            <span className="brand-title">Companion</span>
            <span className="brand-sub">Assistant</span>
          </div>
          <div className="header-actions">
            {showTokens ? (
              <div className="token-pill">
                <div>
                  Токены: <strong>{tokens.totalTokens.toLocaleString()}</strong>
                </div>
                <div>
                  prompt {tokens.promptTokens} · completion {tokens.completionTokens}
                </div>
                <div>
                  модель <strong>{tokens.modelName}</strong>
                </div>
              </div>
            ) : null}
            <nav className="page-toggle" role="tablist" aria-label="Разделы">
              <button
                type="button"
                role="tab"
                aria-label="Чат"
                aria-selected={activeTab === 'chat'}
                title="Чат"
                className={`page-toggle-btn${activeTab === 'chat' ? ' active' : ''}`}
                onClick={() => setActiveTab('chat')}
              >
                <span aria-hidden>💬</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-label="Настройки"
                aria-selected={activeTab === 'settings'}
                title="Настройки"
                className={`page-toggle-btn${activeTab === 'settings' ? ' active' : ''}`}
                onClick={() => setActiveTab('settings')}
              >
                <span aria-hidden>⚙</span>
              </button>
            </nav>
          </div>
        </div>
      </header>

      {activeTab === 'chat' ? (
        <div className={`main-stage${showLogs ? ' with-logs' : ''} layout-${chatLayout}`}>
          <div className="phone-wrap">
            <div className="phone">
              <div className="phone-notch">
                <span />
              </div>
              <div className="phone-header">
                <img className="chat-logo" src="/app/chat_icon.png" alt="Чат" draggable={false} />
                <div className={`status-dot${chatConnected ? '' : ' off'}`} title={chatConnected ? 'online' : 'offline'} />
              </div>

              <div className="messages" ref={messagesScrollRef}>
                {messages.map((m) => (
                  <div key={m.id} className={`bubble ${m.role}`}>
                    {m.role === 'status' ? (
                      <>
                        <div className={`status-line${m.done ? ' done' : ' loading'}`}>
                          <span className={`status-icon${m.done ? ' done' : ''}`} aria-hidden>
                            {m.done ? '✓' : ''}
                          </span>
                          <span className="status-text">{m.body}</span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="bubble-meta">{m.label}</div>
                        {!m.done ? (
                          <div className="stream-plain">{m.body.slice(0, m.streamPos)}</div>
                        ) : m.body ? (
                          <MarkdownBody text={m.body} />
                        ) : null}
                        {m.done && m.widgets?.map((widget, index) => (
                          <WidgetRenderer key={`${widget.name}-${index}`} widget={widget} onAction={sendWidgetAction} />
                        ))}
                      </>
                    )}
                  </div>
                ))}
              </div>

              {suggestions.length > 0 ? (
                <div className="suggest-strip">
                  <h3>Спросить ещё</h3>
                  <div className="suggest-scroll">
                    {suggestions.map((s) => (
                      <button key={s} type="button" className="suggest-chip" onClick={() => sendSuggest(s)}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="input-row">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Сообщение…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') send()
                  }}
                />
                <button type="button" className="send-btn" disabled={!chatConnected} onClick={send} aria-label="Отправить">
                  →
                </button>
              </div>
            </div>
          </div>

          {showLogs ? (
            <aside className="logs-panel" aria-label="Логи приложения">
              <div className="logs-panel-head">
                <span className="logs-panel-title">Логи</span>
                <button type="button" className="logs-clear-btn" onClick={clearLogs}>
                  Очистить
                </button>
              </div>
              <div className="logs-panel-body" ref={logsScrollRef}>
                {logLines.length === 0 ? (
                  <p className="logs-empty">Пока нет записей. Логи появятся здесь по мере работы сервера.</p>
                ) : (
                  logLines.map((line) => (
                    <pre key={line.id} className={`log-line${line.text.toLowerCase().includes('llm') ? ' llm' : ''}`}>
                      {line.text}
                    </pre>
                  ))
                )}
              </div>
            </aside>
          ) : null}
        </div>
      ) : activeTab === 'widgets' ? (
        <div className="settings-page widgets-page">
          <h2 className="settings-title">Виджеты</h2>
          <p className="settings-lead">Примеры поддерживаемых ListView форматов и итогового отображения в чате.</p>

          <section className="chat-widget-preview" aria-label="Превью сообщения агента с виджетом">
            <div className="chat-widget-preview-head">
              <h3>Сообщение агента + виджет</h3>
              <p>Так будет выглядеть финальный ответ, когда агент отправляет текст и следом за ним widget payload.</p>
            </div>
            <div className="chat-widget-preview-stage">
              <div className="bubble agent">
                <div className="bubble-meta">Agent</div>
                <MarkdownBody text="Подобрал несколько вариантов для вашей цели. Можно выбрать продукт из списка ниже." />
                <WidgetRenderer
                  widget={{
                    name: 'list_view',
                    arguments: { version: 1, payload: LIST_WITH_SUBTITLES_WIDGET },
                  }}
                  onAction={sendWidgetAction}
                />
              </div>
            </div>
          </section>

          <ListView
            title="Транзакции"
            subtitle="Пример списка из tuple-элементов с двумя колонками."
            items={[
              ['Пополнение баланса', '+ 12 500 ₽'],
              ['Подписка Pro', '- 1 990 ₽'],
              ['Возврат платежа', '+ 650 ₽'],
            ]}
          />

          <ListView
            title="Инвестиционные продукты"
            subtitle="Payload с подзаголовками у item и правой колонкой."
            items={[]}
            payload={LIST_WITH_SUBTITLES_WIDGET}
            onAction={sendWidgetAction}
          />

          <ListView
            subtitle="Payload с общей кнопкой внизу виджета."
            items={[]}
            payload={SAVE_GOAL_WIDGET}
            onAction={sendWidgetAction}
          />

          <WidgetRenderer
            widget={{
              name: 'operation_list_widget',
              arguments: { version: 1, payload: OPERATION_LIST_WIDGET },
            }}
          />
        </div>
      ) : (
        <div className="settings-page">
          <h2 className="settings-title">Настройки</h2>
          <p className="settings-lead">Параметры сохраняются в этом браузере.</p>

          <div className="setting-card setting-card-stack">
            <div className="setting-text">
              <div className="setting-name">Цветовая гамма</div>
              <div className="setting-desc">Акцентные цвета, фон и подсветка интерфейса пересчитываются под выбранную тему.</div>
            </div>
            <div className="theme-grid" role="group" aria-label="Цветовая гамма">
              <button
                type="button"
                className={`theme-option${uiTheme === 'forest' ? ' active' : ''}`}
                aria-pressed={uiTheme === 'forest'}
                onClick={() => persistUiTheme('forest')}
              >
                <span className="theme-swatch theme-swatch-forest" aria-hidden />
                <span className="theme-label">Лес</span>
                <span className="theme-hint">мята</span>
              </button>
              <button
                type="button"
                className={`theme-option${uiTheme === 'ocean' ? ' active' : ''}`}
                aria-pressed={uiTheme === 'ocean'}
                onClick={() => persistUiTheme('ocean')}
              >
                <span className="theme-swatch theme-swatch-ocean" aria-hidden />
                <span className="theme-label">Океан</span>
                <span className="theme-hint">синий</span>
              </button>
              <button
                type="button"
                className={`theme-option${uiTheme === 'dusk' ? ' active' : ''}`}
                aria-pressed={uiTheme === 'dusk'}
                onClick={() => persistUiTheme('dusk')}
              >
                <span className="theme-swatch theme-swatch-dusk" aria-hidden />
                <span className="theme-label">Сумерки</span>
                <span className="theme-hint">фиолет</span>
              </button>
              <button
                type="button"
                className={`theme-option${uiTheme === 'ember' ? ' active' : ''}`}
                aria-pressed={uiTheme === 'ember'}
                onClick={() => persistUiTheme('ember')}
              >
                <span className="theme-swatch theme-swatch-ember" aria-hidden />
                <span className="theme-label">Угли</span>
                <span className="theme-hint">янтарь</span>
              </button>
            </div>
          </div>

          <div className="setting-card">
            <div className="setting-text">
              <div className="setting-name">Логи рядом с чатом</div>
              <div className="setting-desc">Отдельная панель справа от телефона (на узком экране — под чатом).</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showLogs}
              className={`switch${showLogs ? ' on' : ''}`}
              onClick={() => setLogsEnabled(!showLogs)}
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="setting-card">
            <div className="setting-text">
              <div className="setting-name">Панель токенов</div>
              <div className="setting-desc">Сводка по LLM в шапке (prompt / completion / модель).</div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={showTokens}
              className={`switch${showTokens ? ' on' : ''}`}
              onClick={() => setTokensPanelEnabled(!showTokens)}
            >
              <span className="switch-knob" />
            </button>
          </div>

          <div className="setting-card setting-card-stack">
            <div className="setting-text">
              <div className="setting-name">Вид чата</div>
              <div className="setting-desc">
                Телефон — компактное окно как на мобильном. ПК — широкая панель диалога на весь доступный размер.
              </div>
            </div>
            <div className="segmented segmented-wide" role="group" aria-label="Вид чата">
              <button
                type="button"
                className={chatLayout === 'mobile' ? 'active' : ''}
                aria-pressed={chatLayout === 'mobile'}
                onClick={() => persistChatLayout('mobile')}
              >
                Телефон
              </button>
              <button
                type="button"
                className={chatLayout === 'desktop' ? 'active' : ''}
                aria-pressed={chatLayout === 'desktop'}
                onClick={() => persistChatLayout('desktop')}
              >
                ПК
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}