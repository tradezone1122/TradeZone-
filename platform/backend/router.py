"""Model routing to OpenAI-compatible upstreams (Splaude/Splash server, Kimi-compatible
servers, hosted APIs...). Routing: "<upstream>/<model>" prefix, else first upstream that
lists the model, else the default upstream."""
from __future__ import annotations
import json, os
import requests

class RouteError(Exception):
    def __init__(self, msg: str, status: int = 502):
        super().__init__(msg); self.status = status

class Router:
    def __init__(self, cfg: dict):
        self.ups = {u["name"]: u for u in cfg.get("upstreams", [])}
        self.default_model = cfg.get("default_model")

    def _headers(self, up: dict) -> dict:
        key = os.environ.get(up.get("api_key_env", ""), "") if up.get("api_key_env") else ""
        return {"Authorization": f"Bearer {key}"} if key else {}

    def resolve(self, model: str | None) -> tuple[dict, str]:
        if not self.ups:
            raise RouteError("no upstream configured (set upstreams in config/platform.json)", 503)
        model = model or self.default_model
        if model and "/" in model:
            name, rest = model.split("/", 1)
            if name in self.ups:
                return self.ups[name], rest
        for up in self.ups.values():
            ms = up.get("models", ["*"])
            if "*" in ms or (model and model in ms):
                return up, model or ""
        raise RouteError(f"no upstream serves model {model!r}", 404)

    def models(self) -> list[dict]:
        out = []
        for name, up in self.ups.items():
            try:
                r = requests.get(up["base_url"].rstrip("/") + "/models", headers=self._headers(up), timeout=5)
                r.raise_for_status()
                for m in r.json().get("data", []):
                    m = dict(m); m["id"] = f"{name}/{m.get('id','')}"
                    out.append(m)
            except Exception as e:  # upstream down: report, do not invent models
                out.append({"id": f"{name}/(unreachable)", "object": "model", "error": str(e)[:120]})
        return out

    def _post(self, payload: dict, stream: bool):
        up, model = self.resolve(payload.get("model"))
        body = dict(payload)
        if model:
            body["model"] = model
        else:
            body.pop("model", None)
        try:
            return requests.post(up["base_url"].rstrip("/") + "/chat/completions", json=body,
                                 headers=self._headers(up), stream=stream,
                                 timeout=(5, up.get("timeout", 300)))
        except requests.RequestException as e:
            raise RouteError(f"upstream {up['name']} unreachable: {e}") from e

    def complete(self, payload: dict) -> tuple[int, dict]:
        r = self._post({**payload, "stream": False}, False)
        try:
            return r.status_code, r.json()
        except ValueError:
            raise RouteError(f"upstream returned non-JSON ({r.status_code})")

    def stream(self, payload: dict):
        """Return (status, iterator of raw SSE bytes)."""
        r = self._post({**payload, "stream": True}, True)
        if r.status_code != 200:
            return r.status_code, iter([r.content])
        return 200, r.iter_content(chunk_size=None)
