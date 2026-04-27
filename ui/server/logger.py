import logging
import asyncio
from collections.abc import Mapping
from typing import Any, Optional, Sequence
import json

WidgetPayload = Mapping[str, Any]

class ChatLogger:
    _instance = None
    _loop: Optional[asyncio.AbstractEventLoop] = None
    _handler = None

    def __new__(cls, name):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self, name):
        if self._initialized:
            return

        self._initialized = True
        self._logger = logging.getLogger(name)
        self._logger.setLevel(logging.INFO)
        self._logger.addHandler(logging.NullHandler())

    @classmethod
    def setup(cls, loop: asyncio.AbstractEventLoop):
        """Инициализация с event loop"""
        if cls._instance is None:
            raise RuntimeError("Logger instance not created")

        cls._loop = loop

        from ui.server.handlers import WebSocketHandler
        cls._handler = WebSocketHandler(loop)
        cls._handler.setFormatter(logging.Formatter('%(message)s'))

        for handler in cls._instance._logger.handlers[:]:
            cls._instance._logger.removeHandler(handler)

        cls._instance._logger.addHandler(cls._handler)

    def _check_handler(self):
        """Проверяет, есть ли активный обработчик"""
        if not self._logger.handlers:
            return False
        return True

    @staticmethod
    def _normalize_widget_name(name: str) -> str:
        aliases = {
            "List widget": "list_view",
            "ListWidget": "list_view",
            "ListView": "list_view",
            "OperationList": "operation_list_widget",
            "OperationList": "operation_list_widget",
            "OperationList": "operation_list_widget",
            "operation_list_widget": "operation_list_widget",
            "SuggestionButtonList": "suggestion_button_list",
            "suggestion_button_list": "suggestion_button_list",
        }
        return aliases.get(name, name)

    @staticmethod
    def _normalize_widget(widget: WidgetPayload) -> dict[str, Any]:
        """Приводит старый payload и новый widget envelope к единому формату."""
        widget_data = dict(widget)
        arguments = widget_data.get("arguments")
        if isinstance(widget_data.get("name"), str) and isinstance(arguments, Mapping):
            payload = arguments.get("payload")
            if isinstance(payload, Mapping):
                normalized_arguments: dict[str, Any] = {"payload": dict(payload)}
                if "version" in arguments:
                    normalized_arguments["version"] = arguments["version"]
                return {
                    "name": ChatLogger._normalize_widget_name(widget_data["name"]),
                    "arguments": normalized_arguments,
                }

        widget_name = "operation_list_widget" if isinstance(widget_data.get("operations"), list) else "list_view"
        return {
            "name": widget_name,
            "arguments": {
                "payload": widget_data,
            },
        }

    @staticmethod
    def _suggestions_to_widget(suggestions: Sequence[str]) -> dict[str, Any]:
        return {
            "name": "suggestion_button_list",
            "arguments": {
                "payload": {
                    "buttonList": [{"text": text} for text in suggestions],
                },
            },
        }

    def message(
        self,
        username: str,
        msg: str,
        suggestions: Optional[Sequence[str]] = None,
        widget: Optional[WidgetPayload] = None,
    ):
        """Сообщение в чат. suggestions — список подсказок, widget — описание UI-виджета."""
        if not self._check_handler():
            return

        message_payload: dict[str, Any] = {
            "type": "message",
            "user": username,
            "text": msg,
        }
        widgets: list[dict[str, Any]] = []
        if widget is not None:
            widgets.append(self._normalize_widget(widget))
        if suggestions:
            widgets.append(self._suggestions_to_widget(list(suggestions)))
        if len(widgets) == 1:
            message_payload["widget"] = widgets[0]
        elif len(widgets) > 1:
            message_payload["widgets"] = widgets

        payload = json.dumps(
            message_payload,
            ensure_ascii=False,
        )
        record = self._logger.makeRecord(
            self._logger.name,
            logging.INFO,
            "(chat)",
            0,
            payload,
            None,
            None,
        )
        self._logger.handle(record)

    def widget(
        self,
        username: str,
        payload: WidgetPayload,
        msg: str = "",
        suggestions: Optional[Sequence[str]] = None,
    ):
        """Отправляет UI-виджет. Принимает новый envelope или legacy payload ListView."""
        self.message(username=username, msg=msg, suggestions=suggestions, widget=payload)

    def think(self, text: str = "", title: str = "Reasoning", content: Optional[str] = None):
        """Текст «размышления» для UI (reasoning), отдельно от основного ответа."""
        if not self._check_handler():
            return

        reasoning_content = text if content is None else content
        payload = json.dumps(
            {
                "type": "think",
                "title": title,
                "content": reasoning_content,
                "text": reasoning_content,
            },
            ensure_ascii=False,
        )
        record = self._logger.makeRecord(
            self._logger.name,
            logging.INFO,
            "(think)",
            0,
            payload,
            None,
            None,
        )
        self._logger.handle(record)

    def log_llm(self, username: str, msg):
        """Специальные сообщения в чат — принимает AIMessage, dict или str"""
        if not self._check_handler():
            return

        # Поддержка разных типов msg
        if isinstance(msg, str):
            try:
                msg_data = json.loads(msg)
                metadata = msg_data.get("response_metadata", {})
            except json.JSONDecodeError:
                metadata = {}
        elif hasattr(msg, "response_metadata"):  # Например, AIMessage
            metadata = getattr(msg, "response_metadata", {})
        elif isinstance(msg, dict):
            metadata = msg.get("response_metadata", {})
        else:
            metadata = {}

        token_usage = metadata.get('token_usage', {})

        def _tok(key: str) -> int:
            if isinstance(token_usage, dict):
                v = token_usage.get(key, 0)
            else:
                v = getattr(token_usage, key, 0)
            try:
                return int(v)
            except (TypeError, ValueError):
                return 0

        token_data = {
            'model_name': metadata.get('model_name', 'unknown'),
            'prompt_tokens': _tok('prompt_tokens'),
            'completion_tokens': _tok('completion_tokens'),
            'total_tokens': _tok('total_tokens'),
            'finish_reason': metadata.get('finish_reason', 'unknown')
        }

        formatted_msg = json.dumps(token_data, ensure_ascii=False, indent=2)

        record = self._logger.makeRecord(
            self._logger.name,
            logging.INFO,
            "(llm)", 0,
            f"{username}: {formatted_msg}",
            None, None, "(llm)"
        )
        self._logger.handle(record)

    def info(self, msg: str, *args, **kwargs):
        """Логирование информационных сообщений"""
        if not self._check_handler():
            return
        self._logger.info(msg, *args, **kwargs)

    def debug(self, msg: str, *args, **kwargs):
        if not self._check_handler():
            return
        self._logger.debug(msg, *args, **kwargs)

    def warning(self, msg: str, *args, **kwargs):
        if not self._check_handler():
            return
        self._logger.warning(msg, *args, **kwargs)

    def error(self, msg: str, *args, **kwargs):
        if not self._check_handler():
            return
        self._logger.error(msg, *args, **kwargs)
