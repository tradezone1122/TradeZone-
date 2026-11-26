# Kimi K3 Model Architecture — Study & Fine-Tuning Guide

This directory contains multiple Kimi K3 implementations for study and custom fine-tuning.
Your goal: fine-tune → host yourself → connect to the platform via OpenAI-compatible API.

## Directory Overview

| Dir | License | Description |
|-----|---------|-------------|
| `kimi3_official/` | AGPL-3.0 | Official Kimi K3 architecture (MoE, MLA, speculative decoding) |
| `kimi3_from_scratch/` | Apache-2.0 | Clean from-scratch implementation with trainer |
| `kimi3_pytorch/` | MIT | PyTorch mini version + KDA attention — best starting point |
| `kimi3_for_all/` | — | Train-on-1xH100 toolkit with inference + training scripts |

## Recommended Path to Your Own Model

### Step 1 — Understand the Architecture
Study `kimi3_pytorch/transformer_modules/` — clean, well-commented PyTorch:
- `mha.py` — Multi-Head Attention
- `rope.py` — Rotary Position Embedding
- `swiglu.py` — SwiGLU activation (used in Kimi K3)
- `rms_norm.py` — RMSNorm
- `kda/` — Knowledge-Dense Attention (Kimi's innovation)

### Step 2 — Start Training
Use `kimi3_for_all/` for a complete train-from-scratch pipeline on 1x H100:
```bash
cd model/kimi3_for_all
pip install torch==2.7.1 --index-url https://download.pytorch.org/whl/cu126
pip install -r requirements.txt
python training/train.py
python inference/generate.py
```

### Step 3 — Advanced Fine-Tuning
`kimi3_from_scratch/` has a full trainer with metrics:
```bash
cd model/kimi3_from_scratch
pip install -r requirements.txt
python training/trainer.py
```

### Step 4 — Serve via OpenAI-Compatible API
Once you have weights, serve them:
```bash
# Option A: vLLM (recommended for production)
vllm serve ./weights --served-model-name my-kimi-k3 --port 8080

# Option B: Platform adapter
python -m backend.model_server --model ./weights --port 8080
```

Then set in `config/platform.json`:
```json
{
  "upstreams": [{
    "name": "my-model",
    "base_url": "http://localhost:8080/v1",
    "api_key_env": "",
    "models": ["my-kimi-k3"]
  }],
  "default_model": "my-kimi-k3"
}
```

## Model Weights Download (HuggingFace)

The code here is architecture only — no weights. To get the actual Kimi K3 weights:
```bash
pip install huggingface-hub
python -c "from huggingface_hub import snapshot_download; snapshot_download('moonshotai/Kimi-K3-Instruct', local_dir='./weights')"
```
Weights are ~15-100GB depending on the variant.

## Key Innovations in Kimi K3
- **MoE (Mixture of Experts)**: routes tokens to specialist sub-networks
- **MLA (Multi-head Latent Attention)**: compresses KV cache dramatically
- **KDA (Knowledge-Dense Attention)**: improves factual retrieval
- **Eagle3 speculative decoding**: 3x faster inference
- **Muon optimizer**: better convergence than AdamW for pre-training
