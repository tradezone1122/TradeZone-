# Run guide
Requires Python 3.11+, with `starlette`, `uvicorn`, `requests` (and `pymupdf` for PDFs, optional).
```
cp config/platform.example.json config/platform.json   # point upstreams at your OpenAI-compatible server
python3 run.py --port 8000                              # http://127.0.0.1:8000
UP_TOOLS=1 python3 run.py                               # also enables /api/tools/run (prints the admin token)
python3 -m pytest tests -v                              # needs pytest
```
Docker sandbox (needs a running Docker daemon): `docker build -t unified-sandbox:latest sandbox_image/`, then set `"sandbox": {"backend": "docker"}` in config/platform.json. Not verified on a real daemon.
Upload a document: `curl -X POST --data-binary @file.md "http://127.0.0.1:8000/api/upload?filename=file.md"`.
Local models: any server that speaks `/v1/chat/completions` (e.g. a Splaude/Splash server on a Mac, llama.cpp server). Hosted APIs need `api_key_env` set to the name of an env var holding the key.
Do not expose this to a network: no user auth.
