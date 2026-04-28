from aiohttp import web
from ui.server.handlers import chat_websocket_handler, log_websocket_handler
import os

def get_frontend_path(*parts):
    return os.path.join(os.path.dirname(os.path.dirname(__file__)), 'frontend', *parts)


def get_dist_path():
    return get_frontend_path('dist')

async def index(request):
    react_index = get_frontend_path('dist', 'index.html')
    if os.path.exists(react_index):
        return web.FileResponse(react_index)
    return web.Response(text='Frontend build not found. Run npm run build in ui/frontend.', status=503)

async def start_server(loop):
    app = web.Application()

    dist_path = get_dist_path()

    app.add_routes([
        web.get('/chat', chat_websocket_handler),
        web.get('/log', log_websocket_handler),
        web.get('/', index),
    ])

    assets_path = os.path.join(dist_path, 'assets')
    if os.path.exists(assets_path):
        app.router.add_static('/assets', assets_path)

    public_app_path = os.path.join(dist_path, 'app')
    if os.path.exists(public_app_path):
        app.router.add_static('/app', public_app_path)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', 8080)
    await site.start()
    return site