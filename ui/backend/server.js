const http = require('http')
const { WebSocketServer, WebSocket } = require('ws')

const PORT = Number(process.env.PORT || 5000)

const logClients = new Set()

function nowIso() {
  return new Date().toISOString()
}

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(payload)
}

function sendLog(line) {
  const text = `[${nowIso()}] ${line}`
  for (const client of logClients) {
    safeSend(client, text)
  }
  console.log(text)
}

function buildReasoning(userText) {
  const trimmed = userText.trim()
  return [
    `Анализ запроса: "${trimmed}".`,
    'Проверяю заглушки и подбираю формат ответа для UI.',
    'Возвращаю тестовый ответ в формате think -> message.',
  ].join('\n')
}

function buildAgentMessage(userText) {
  return `Это тестовый ответ из backend-заглушки.\n\nВы написали: **${userText.trim()}**`
}

function buildSuggestions() {
  return ['Показать виджеты', 'Сделай ответ короче', 'Добавь больше деталей', 'Покажи пример JSON ответа']
}

const LIST_VIEW_WIDGET = {
  title: 'Инвестиционные продукты',
  items: [
    {
      id: 'Deposit',
      type: 'product',
      data: {
        content: '500 000 Р',
        message: 'Выбрать Заголовок',
        subtitle: 'на 6 месяцев',
        title: 'Заголовок',
        underContent: 'ставка 20,5%',
      },
    },
    {
      id: 'govBondFund',
      type: 'product',
      data: {
        content: '300 000 Р',
        deeplink: 'https://example.com/fund',
        message: 'Выбрать фонд облигаций',
        subtitle: 'ОПИФ',
        title: 'Фонд Гос Облигаций',
        underContent: 'Доходность ~22%',
      },
    },
    {
      id: 'rusStockFund',
      type: 'product',
      data: {
        content: '400 000 Р',
        deeplink: 'https://example.com/stocks',
        subtitle: 'ОПИФ',
        title: 'Фонд Рос. Акций',
        underContent: 'Доходность ~30%',
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

const OPERATION_LIST_WIDGET = {
  title: 'Оплата ЖКХ',
  subtitle: 'Август 2025',
  limitPreviewOperations: 2,
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
    {
      title: 'Водоканал',
      subtitle: '8 августа, 14:05',
      detail: '1 250 ₽',
      iconUrl: '',
    },
  ],
}

function buildWidget(name, payload, version = 1) {
  return {
    name,
    arguments: {
      version,
      payload,
    },
  }
}

function isWidgetPreviewRequest(userText) {
  const normalized = userText.trim().toLowerCase()
  return normalized === '/widgets' || normalized === 'widgets' || normalized.includes('виджет')
}

function sendChatFrame(ws, frame) {
  safeSend(ws, JSON.stringify(frame))
}

function sendWidgetPreview(ws) {
  const demos = [
    {
      text: 'Так выглядит `ListView` (`name: "list_view"`).',
      widget: buildWidget('list_view', LIST_VIEW_WIDGET),
    },
    {
      text: 'Так выглядит `OperationList` (`name: "operation_list_widget"`).',
      widget: buildWidget('operation_list_widget', OPERATION_LIST_WIDGET),
    },
  ]

  demos.forEach((demo, index) => {
    setTimeout(() => {
      sendChatFrame(ws, {
        type: 'message',
        user: 'Agent',
        text: demo.text,
        suggestions: buildSuggestions(),
        widget: demo.widget,
      })
    }, index * 450)
  })
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, service: 'backend-stub' }))
    return
  }
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ error: 'Not found' }))
})

const chatWss = new WebSocketServer({ noServer: true })
const logWss = new WebSocketServer({ noServer: true })

chatWss.on('connection', (ws, req) => {
  sendLog(`chat connected from ${req.socket.remoteAddress || 'unknown'}`)

  ws.on('message', (raw) => {
    const userText = String(raw || '').trim()
    if (!userText) return

    sendLog(`chat <= ${userText}`)

    if (isWidgetPreviewRequest(userText)) {
      sendChatFrame(ws, {
        type: 'think',
        text: 'Готовлю демо поддерживаемых виджетов для отображения в чате.',
      })
      setTimeout(() => {
        sendWidgetPreview(ws)
        sendLog('chat => sent widget preview')
      }, 500)
      return
    }

    const thinkingText = buildReasoning(userText)
    sendChatFrame(ws, {
      type: 'think',
      text: thinkingText,
    })

    setTimeout(() => {
      sendChatFrame(ws, {
        type: 'message',
        user: 'Agent',
        text: buildAgentMessage(userText),
        suggestions: buildSuggestions(),
      })

      // UI забирает статистику токенов из логов по ключу "llm"
      sendLog(`llm ${JSON.stringify({ model_name: 'stub-model', prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 })}`)
      sendLog(`chat => sent stub response for "${userText}"`)
    }, 700)
  })

  ws.on('close', () => {
    sendLog('chat disconnected')
  })
})

logWss.on('connection', (ws, req) => {
  logClients.add(ws)
  safeSend(ws, `[${nowIso()}] log connected from ${req.socket.remoteAddress || 'unknown'}`)

  ws.on('close', () => {
    logClients.delete(ws)
  })
})

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/chat') {
    chatWss.handleUpgrade(req, socket, head, (ws) => {
      chatWss.emit('connection', ws, req)
    })
    return
  }

  if (req.url === '/log') {
    logWss.handleUpgrade(req, socket, head, (ws) => {
      logWss.emit('connection', ws, req)
    })
    return
  }

  socket.destroy()
})

server.listen(PORT, () => {
  console.log(`[backend-stub] listening on http://localhost:${PORT}`)
  console.log('[backend-stub] ws endpoints: /chat and /log')
})
