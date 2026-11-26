# Test report
Latest full run: 40 passed (34 platform/agent tests + 6 docker-backend tests). The listing below is the earlier 34-test run.
Command: `python3 -I -m pytest tests -v` (Python 3.13). Real HTTP servers on localhost; the model upstream is a **mock** (tests/conftest.py) that echoes input, so no real LLM was exercised.
    collecting ... collected 34 items
    
    tests/test_agents.py::test_agent_plain_answer PASSED                     [  2%]
    tests/test_agents.py::test_agent_requires_token_when_tools_enabled PASSED [  5%]
    tests/test_agents.py::test_unknown_agent_and_bad_body PASSED             [  8%]
    tests/test_agents.py::test_agent_tool_memory_roundtrip PASSED            [ 11%]
    tests/test_agents.py::test_memory_injected_into_agent_prompt PASSED      [ 14%]
    tests/test_agents.py::test_agent_rag_tool PASSED                         [ 17%]
    tests/test_agents.py::test_agent_artifact_tool_and_view PASSED           [ 20%]
    tests/test_agents.py::test_agent_shell_tool_sandboxed PASSED             [ 23%]
    tests/test_agents.py::test_agent_cannot_use_tool_outside_allowlist PASSED [ 26%]
    tests/test_agents.py::test_bad_tool_arguments_are_returned_to_model_not_crash PASSED [ 29%]
    tests/test_agents.py::test_step_limit PASSED                             [ 32%]
    tests/test_agents.py::test_delegation_agent_to_agent PASSED              [ 35%]
    tests/test_agents.py::test_delegation_depth_limit PASSED                 [ 38%]
    tests/test_agents.py::test_agent_run_persists_session PASSED             [ 41%]
    tests/test_agents.py::test_memory_api_crud_and_validation PASSED         [ 44%]
    tests/test_agents.py::test_memory_survives_restart PASSED                [ 47%]
    tests/test_agents.py::test_panel_served_and_agents_listed PASSED         [ 50%]
    tests/test_agents.py::test_upstream_failure_in_agent_is_502 PASSED       [ 52%]
    tests/test_platform.py::test_health_and_ui PASSED                        [ 55%]
    tests/test_platform.py::test_models_aggregates_upstream PASSED           [ 58%]
    tests/test_platform.py::test_chat_nonstream_routes_and_logs PASSED       [ 61%]
    tests/test_platform.py::test_chat_stream_sse_and_persist_after_restart PASSED [ 64%]
    tests/test_platform.py::test_session_isolation PASSED                    [ 67%]
    tests/test_platform.py::test_upload_rag_retrieval_and_injection PASSED   [ 70%]
    tests/test_platform.py::test_upload_rejects_bad_names_and_traversal PASSED [ 73%]
    tests/test_platform.py::test_upload_size_limit PASSED                    [ 76%]
    tests/test_platform.py::test_skills_index PASSED                         [ 79%]
    tests/test_platform.py::test_tools_require_token_and_allowlist PASSED    [ 82%]
    tests/test_platform.py::test_tool_timeout PASSED                         [ 85%]
    tests/test_platform.py::test_tools_disabled_by_default PASSED            [ 88%]
    tests/test_platform.py::test_artifact_versions_and_sandbox_headers PASSED [ 91%]
    tests/test_platform.py::test_artifact_validation PASSED                  [ 94%]
    tests/test_platform.py::test_chat_validation_and_missing_upstream PASSED [ 97%]
    tests/test_platform.py::test_upstream_down_is_502 PASSED                 [100%]
    
    ============================== 34 passed in 3.85s ==============================

Docker backend: 6 tests with a fake `docker` executable check the exact flags (network none, read-only, cap-drop ALL, no-new-privileges, pids/memory limits, non-root, single workspace mount, no docker.sock), allowlist before docker, no silent fallback when the daemon is down, kill on timeout, API 403. They do NOT prove isolation.

Covers: agent loop (tool calls via a scripted mock model), tool allowlist per agent, delegation lead->specialist and depth/step limits, long-term memory CRUD/dedupe/restart persistence, memory injection into agent prompts, agent auth, panel serving; plus UI serving, model listing, chat (stream and non-stream), session log persistence across a simulated restart, session isolation, upload + RAG retrieval + injection into the upstream request, filename sanitising, size limit, skill index, tool auth/allowlist/timeout/disabled-by-default, artifact versioning and CSP, input validation, missing and unreachable upstream.
NOT tested: real model output, the browser UI itself (no browser run), multi-user auth, concurrency/load, Docker, MCP, the original knowledge-rag test suite (needs chromadb).

Browser smoke test (Playwright, headless Chromium, no upstream configured): panel tabs Knowledge/Memory/Artifacts/Skills/Sessions/Agents render; saving a memory through the UI works; Agents tab shows the "no upstream configured" error as designed; chat page loads and shows the Panel link. Only console error: the expected 503 from the unconfigured upstream. The chat page was not driven with a real model.
