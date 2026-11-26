# Inventory Report
Full per-file manifest: `docs/MANIFEST.csv` (22,874 files, columns: archive, path, ext, bytes, sha1_12).
35 uploaded zips -> 37 extracted directories (two `kimi-k3-in-c` part-pairs uploaded twice, in two spellings).
About 11,650 files are byte-identical duplicates of another file (mostly the repeated claude-code copies).
Nested archives: none inspected. Not every file was read; selection was by project structure, README, LICENSE and targeted code reading of the chosen components.

| Archive | Files | License found | Used |
|---|---|---|---|
| knowledge-rag-master | 284 | MIT | YES (parser, chunker, FTS5 index, skills) |
| splaude-main | 518 | Apache-2.0 | YES (chat UI only; engine is Apple Metal/Swift/C++) |
| open-multi-agent-main | 681 | MIT | NO - TypeScript, needs npm packages (offline) |
| claude-artifact-viewer-template-main | 72 | MIT | NO - Vite/React, needs npm build |
| claude-ui-main | 65 | MIT | NO - Nuxt, needs npm build |
| chat-with-gpt-main | 138 | MIT | NO - React, needs npm build |
| kimi-k3-pytorch-main | 515 | MIT | NO - needs torch (not installed), no weights |
| kimi-k3-from-scratch-main | 209 | Apache-2.0 | NO - model code, no serving integration |
| kimi-k3-in-c-main (4 dirs) | ~730 | Apache-2.0 / none | NO |
| ChatGPT-main, chatgpt-web-main, ChatGPT-code-main | 47/93/27 | GPL-2/3 | EXCLUDED (copyleft, your decision pending) |
| kimi3-master | 123 | AGPL-3 | EXCLUDED |
| claude-code-* (about 12 archives) | 1,500-2,400 each | "All rights reserved" / "UNLICENSED - leaked proprietary" | EXCLUDED |
| claude-code-sandbox-main | 68 | MIT (declared in package.json; no LICENSE file; corrected after first draft said none) | IDEA ONLY (Docker isolation); no code copied; needs Docker daemon + npm |
| awesome-claude-skills-master, Kimi-K3-for-All-master, claude-code-doc-main | various | none found | EXCLUDED until license is confirmed |
| awesome-chatgpt*, everything-chatgpt, chatgpt-complete-guide, ChatGPT-for-Java, Kimi-K3-main | small | CC0 / CC-BY / CC-BY-SA / MIT / custom | Not relevant (prompt lists, guides, docs) |
