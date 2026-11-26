"""
Minimal OpenAI-compatible inference server for self-hosted models.
Wraps any HuggingFace transformers model at /v1/models + /v1/chat/completions.

Usage:
    python -m backend.model_server --model ./weights --port 8080
    python -m backend.model_server --model moonshotai/Kimi-K3-Instruct --port 8080

Then point platform config at http://localhost:8080/v1 with no API key.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import uuid
from pathlib import Path

log = logging.getLogger("model_server")


def _lazy_imports():
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        return torch, AutoModelForCausalLM, AutoTokenizer
    except ImportError:
        print("Install pytorch + transformers: pip install torch transformers accelerate", file=sys.stderr)
        sys.exit(1)


def serve(model_path: str, port: int = 8080, host: str = "0.0.0.0", device: str = "auto") -> None:
    torch, AutoModelForCausalLM, AutoTokenizer = _lazy_imports()

    log.info("Loading tokenizer from %s ...", model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)

    log.info("Loading model (device_map=%s) ...", device)
    model = AutoModelForCausalLM.from_pretrained(
        model_path, device_map=device, trust_remote_code=True,
        torch_dtype=torch.bfloat16,
    )
    model.eval()
    model_name = Path(model_path).name or model_path

    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse, StreamingResponse
    from starlette.routing import Route
    import uvicorn

    def _apply_chat_template(messages):
        try:
            return tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        except Exception:
            return "\n".join(f"{m['role'].upper()}: {m.get('content','')}" for m in messages) + "\nASSISTANT: "

    def _generate(prompt, max_tokens=2048, temperature=0.7, top_p=0.9):
        inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=max_tokens, temperature=temperature,
                                 top_p=top_p, do_sample=temperature > 0, pad_token_id=tokenizer.eos_token_id)
        generated = out[0][inputs["input_ids"].shape[-1]:]
        return tokenizer.decode(generated, skip_special_tokens=True)

    async def v1_models(request):
        return JSONResponse({"object": "list", "data": [
            {"id": model_name, "object": "model", "created": int(time.time()), "owned_by": "local"}
        ]})

    async def v1_chat(request):
        body = await request.json()
        messages = body.get("messages", [])
        max_tokens = int(body.get("max_tokens", 2048))
        temperature = float(body.get("temperature", 0.7))
        top_p = float(body.get("top_p", 0.9))
        stream = body.get("stream", False)
        prompt = _apply_chat_template(messages)
        cid = f"chatcmpl-{uuid.uuid4().hex[:12]}"
        created = int(time.time())
        if not stream:
            text = _generate(prompt, max_tokens, temperature, top_p)
            return JSONResponse({"id": cid, "object": "chat.completion", "created": created,
                                 "model": model_name,
                                 "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                                 "usage": {"prompt_tokens": -1, "completion_tokens": -1, "total_tokens": -1}})
        def _stream_gen():
            inputs = tokenizer(prompt, return_tensors="pt").to(model.device)
            generated_ids = inputs["input_ids"]
            for _ in range(max_tokens):
                with torch.no_grad():
                    out = model(generated_ids)
                next_token = out.logits[:, -1, :].argmax(dim=-1)
                if next_token.item() == tokenizer.eos_token_id:
                    break
                generated_ids = torch.cat([generated_ids, next_token.unsqueeze(0)], dim=-1)
                token_text = tokenizer.decode(next_token, skip_special_tokens=True)
                chunk = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model_name,
                         "choices": [{"index": 0, "delta": {"content": token_text}, "finish_reason": None}]}
                yield f"data: {json.dumps(chunk)}\n\n"
            done_chunk = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model_name,
                          "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
            yield f"data: {json.dumps(done_chunk)}\n\ndata: [DONE]\n\n"
        return StreamingResponse(_stream_gen(), media_type="text/event-stream")

    async def health(request):
        return JSONResponse({"status": "ok", "model": model_name})

    app = Starlette(routes=[
        Route("/v1/models", v1_models),
        Route("/v1/chat/completions", v1_chat, methods=["POST"]),
        Route("/health", health),
    ])
    log.info("Model server ready on http://%s:%d", host, port)
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    p = argparse.ArgumentParser(description="OpenAI-compatible model server")
    p.add_argument("--model", required=True)
    p.add_argument("--port", type=int, default=8080)
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--device", default="auto")
    args = p.parse_args()
    serve(args.model, args.port, args.host, args.device)
