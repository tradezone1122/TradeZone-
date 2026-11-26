"""
Independent Python implementation of an MCP (Model Context Protocol) client.
Connects to any MCP server over stdio or HTTP/SSE.
Zero Anthropic dependency — built from the open MCP specification.

MCP spec: https://spec.modelcontextprotocol.io/

Usage (stdio):
    client = McpClient.from_stdio(["python", "my_mcp_server.py"])
    tools = client.list_tools()
    result = client.call_tool("my_tool", {"arg": "value"})

Usage (HTTP/SSE):
    client = McpClient.from_http("http://localhost:3001")
    tools = client.list_tools()
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field
from typing import Any


# ── MCP message types (from spec) ─────────────────────────────────────────────

@dataclass
class McpTool:
    name: str
    description: str
    input_schema: dict

    def to_openai(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.input_schema,
            },
        }


@dataclass
class McpServer:
    name: str
    command: list[str]
    args: list[str] = field(default_factory=list)
    env: dict = field(default_factory=dict)
    url: str = ""


@dataclass
class McpConfig:
    """Mirrors .mcp.json schema."""
    servers: dict[str, McpServer] = field(default_factory=dict)

    @classmethod
    def from_file(cls, path: str) -> "McpConfig":
        import json
        from pathlib import Path
        p = Path(path)
        if not p.exists():
            return cls()
        raw = json.loads(p.read_text())
        servers = {}
        for name, cfg in raw.get("mcpServers", {}).items():
            if "url" in cfg:
                servers[name] = McpServer(name=name, command=[], url=cfg["url"],
                                          env=cfg.get("env", {}))
            else:
                servers[name] = McpServer(
                    name=name,
                    command=[cfg.get("command", "node")],
                    args=cfg.get("args", []),
                    env=cfg.get("env", {}),
                )
        return cls(servers=servers)


# ── Stdio transport ───────────────────────────────────────────────────────────

class StdioTransport:
    """Communicates with an MCP server over stdin/stdout (JSON-RPC)."""

    def __init__(self, cmd: list[str], env: dict | None = None):
        import os
        process_env = os.environ.copy()
        process_env.update(env or {})
        self._proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=process_env,
        )
        self._id = 0
        self._lock = threading.Lock()

    def _next_id(self) -> int:
        with self._lock:
            self._id += 1
            return self._id

    def request(self, method: str, params: dict | None = None) -> Any:
        req_id = self._next_id()
        msg = {
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params or {},
        }
        line = json.dumps(msg) + "\n"
        assert self._proc.stdin
        self._proc.stdin.write(line)
        self._proc.stdin.flush()

        assert self._proc.stdout
        response_line = self._proc.stdout.readline()
        if not response_line:
            raise RuntimeError("MCP server closed stdout")
        resp = json.loads(response_line)
        if "error" in resp:
            raise RuntimeError(f"MCP error: {resp['error']}")
        return resp.get("result")

    def close(self) -> None:
        if self._proc.poll() is None:
            self._proc.terminate()
            try:
                self._proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self._proc.kill()


# ── HTTP transport ────────────────────────────────────────────────────────────

class HttpTransport:
    """Communicates with an MCP server over HTTP (JSON-RPC POST)."""

    def __init__(self, base_url: str):
        self._url = base_url.rstrip("/") + "/mcp"
        self._id = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def request(self, method: str, params: dict | None = None) -> Any:
        req_id = self._next_id()
        body = json.dumps({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": method,
            "params": params or {},
        }).encode()
        req = urllib.request.Request(
            self._url,
            data=body,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f"HTTP {exc.code}: {exc.reason}")
        if "error" in data:
            raise RuntimeError(f"MCP error: {data['error']}")
        return data.get("result")

    def close(self) -> None:
        pass


# ── McpClient ─────────────────────────────────────────────────────────────────

class McpClient:
    """High-level MCP client."""

    def __init__(self, transport):
        self._t = transport
        self._initialized = False

    @classmethod
    def from_stdio(cls, cmd: list[str], env: dict | None = None) -> "McpClient":
        transport = StdioTransport(cmd, env)
        client = cls(transport)
        client._init()
        return client

    @classmethod
    def from_http(cls, base_url: str) -> "McpClient":
        transport = HttpTransport(base_url)
        client = cls(transport)
        client._init()
        return client

    def _init(self) -> None:
        """MCP initialize handshake."""
        try:
            self._t.request("initialize", {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "clientInfo": {"name": "ai-platform", "version": "1.0"},
            })
            self._t.request("notifications/initialized")
            self._initialized = True
        except Exception:
            self._initialized = False

    def list_tools(self) -> list[McpTool]:
        result = self._t.request("tools/list")
        tools = []
        for t in result.get("tools", []):
            tools.append(McpTool(
                name=t["name"],
                description=t.get("description", ""),
                input_schema=t.get("inputSchema", {"type": "object", "properties": {}}),
            ))
        return tools

    def call_tool(self, name: str, arguments: dict) -> str:
        result = self._t.request("tools/call", {"name": name, "arguments": arguments})
        content = result.get("content", [])
        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
        return "\n".join(texts)

    def list_resources(self) -> list[dict]:
        try:
            result = self._t.request("resources/list")
            return result.get("resources", [])
        except Exception:
            return []

    def read_resource(self, uri: str) -> str:
        result = self._t.request("resources/read", {"uri": uri})
        contents = result.get("contents", [])
        texts = [c.get("text", "") for c in contents if "text" in c]
        return "\n".join(texts)

    def close(self) -> None:
        self._t.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# ── McpRegistry ───────────────────────────────────────────────────────────────

class McpRegistry:
    """
    Manages multiple MCP server connections. Loads config from .mcp.json.
    Exposes all server tools through a unified interface.
    """

    def __init__(self):
        self._clients: dict[str, McpClient] = {}
        self._tool_index: dict[str, tuple[str, McpTool]] = {}

    def load_config(self, config_path: str = ".mcp.json") -> None:
        cfg = McpConfig.from_file(config_path)
        for name, server in cfg.servers.items():
            try:
                if server.url:
                    client = McpClient.from_http(server.url)
                else:
                    cmd = server.command + server.args
                    client = McpClient.from_stdio(cmd, server.env)
                self._clients[name] = client
                for tool in client.list_tools():
                    self._tool_index[tool.name] = (name, tool)
            except Exception as exc:
                import logging
                logging.getLogger("mcp_registry").warning("Could not connect to MCP server %s: %s", name, exc)

    def add_client(self, name: str, client: McpClient) -> None:
        self._clients[name] = client
        for tool in client.list_tools():
            self._tool_index[tool.name] = (name, tool)

    def list_tools(self) -> list[dict]:
        return [tool.to_openai() for _, tool in self._tool_index.values()]

    def call_tool(self, name: str, arguments: dict) -> str:
        entry = self._tool_index.get(name)
        if entry is None:
            return f"MCP tool '{name}' not found"
        server_name, _ = entry
        client = self._clients[server_name]
        return client.call_tool(name, arguments)

    def close_all(self) -> None:
        for client in self._clients.values():
            try:
                client.close()
            except Exception:
                pass
        self._clients.clear()
        self._tool_index.clear()
