"""Start the platform: python3 run.py [--host 127.0.0.1] [--port 8000]"""
import argparse, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import uvicorn
from backend import app as A

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1"); ap.add_argument("--port", type=int, default=8000)
    a = ap.parse_args()
    A.init()
    if A.S.token:
        print(f"tools enabled; X-Admin-Token: {A.S.token}")
    uvicorn.run(A.build(), host=a.host, port=a.port)
