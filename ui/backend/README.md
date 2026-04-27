# Backend stub for UI testing

Simple websocket server for local UI tests.

## Endpoints

- `ws://localhost:5000/chat` - accepts user text and returns:
  1. `{"type":"think","text":"..."}`
  2. `{"type":"message","user":"Agent","text":"...","suggestions":[...]}`
- `ws://localhost:5000/log` - broadcast log lines
- `http://localhost:5000/health` - health check

## Run

```bash
cd ui/backend
npm install
npm start
```

## Use with frontend dev server

In `ui/frontend/vite.config.js`, enable proxy for websocket routes:

```js
proxy: {
  '/chat': { target: 'ws://localhost:5000', ws: true },
  '/log': { target: 'ws://localhost:5000', ws: true },
}
```
