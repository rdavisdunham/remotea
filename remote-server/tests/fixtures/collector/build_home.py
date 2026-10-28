"""Build the collector fixture home (run once; the output is checked in).

    python3 -I build_home.py
"""
import json
import os
import shutil
import sqlite3
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOME = HERE / "home"
WIN = HERE / "windows-users"


def lines(path, *entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(e if isinstance(e, str) else json.dumps(e) for e in entries) + "\n")


def user(text, ts="2026-10-20T10:00:00Z", **extra):
    base = {"type": "user", "cwd": "/srv/fixture/acme app", "gitBranch": "davin/eng-12-login", "entrypoint": "cli",
            "timestamp": ts, "message": {"role": "user", "content": text}}
    base.update(extra)
    return base


def reply(text, ts="2026-10-20T10:05:00.123Z"):
    return {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "text", "text": text}]}}


for d in (HOME, WIN):
    shutil.rmtree(d, ignore_errors=True)

projects = HOME / ".claude" / "projects"
lines(
    projects / "-srv-fixture-acme" / "0f8fad5b-d9cb-469f-a165-70867728950e.jsonl",
    user("Fix the login test. My key is sk-proj-" + "x" * 30 + " and ghp_" + "a" * 36),
    user("<system-reminder>ignore</system-reminder>", isMeta=True),
    user("Task finished", promptSource="system", origin={"kind": "task-notification"}),
    user([{"type": "tool_result", "tool_use_id": "t", "content": "ok", "is_error": False}]),
    user("<command-name>/review</command-name>\n<command-args>PR 4</command-args>"),
    user("side work", isSidechain=True),
    reply("Fixed it. Bearer abcdefghijklmnopqrstuvwxyz0123"),
    "not json at all",
    {"type": "ai-title", "aiTitle": "Fix login test", "sessionId": "x"},
    {"type": "custom-title", "customTitle": "ENG-12 login ✓ «quotes» 'single'", "sessionId": "x"},
    {"type": "pr-link", "prUrl": "https://github.com/acme/app/pull/4", "prNumber": 4},
    {"type": "pr-link", "prUrl": "https://github.com/acme/app/pull/4", "prNumber": 4},
    user("<system-reminder>a\nb</system-reminder>Now   the docs, please ", ts="2026-10-20T10:07:30.5+02:00"),
    reply("Done — see README.md ✅", ts="2026-10-20T10:09:00Z"),
)
long_prompts = ["Prompt number %d: " % i + ("word " * 400) for i in range(5)]
lines(
    projects / "-srv-fixture-long" / "11111111-2222-4333-8444-555555555555.jsonl",
    *[user(p, ts="2026-10-21T0%d:00:00Z" % i, cwd="/srv/fixture/long", gitBranch="HEAD") for i, p in enumerate(long_prompts)],
    reply("x" * 3000, ts="2026-10-21T09:00:00Z"),
    {"type": "ai-title", "aiTitle": "T" * 700},
)
lines(
    projects / "-srv-fixture-desktop" / "22222222-3333-4444-8555-666666666666.jsonl",
    user("[Request interrupted by user]", cwd="/srv/fixture/desk", entrypoint="claude-desktop"),
    user("Desktop prompt", cwd="/srv/fixture/desk", entrypoint="claude-desktop", ts="2026-10-22T11:00:00Z"),
)
lines(projects / "-srv-fixture-empty" / "33333333-4444-4555-8666-777777777777.jsonl", {"type": "ai-title", "aiTitle": "t"})
lines(projects / "-srv-fixture-acme" / "subdir" / "nested.jsonl", user("never read"))
lines(projects / ".hidden" / "44444444-0000-4000-8000-000000000000.jsonl", user("hidden folder"))

codex = HOME / ".codex"
codex.mkdir(parents=True)
state = sqlite3.connect(codex / "state_5.sqlite")
state.execute(
    "CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT,"
    " title TEXT, name TEXT, archived INTEGER, git_branch TEXT, git_origin_url TEXT, first_user_message TEXT,"
    " created_at_ms INTEGER, updated_at_ms INTEGER)"
)
rollout = HOME / ".codex" / "sessions" / "rollout-t9.jsonl"
lines(
    rollout,
    {"type": "session_meta", "payload": {"id": "t9"}},
    {"type": "event_msg", "payload": {"type": "user_message", "message": "Run the tests"}},
    {"type": "event_msg", "payload": {"type": "agent_message", "message": "Running."}},
    {"type": "event_msg", "payload": {"type": "user_message", "message": "<input>And lint</input>"}},
    {"type": "event_msg", "payload": {"type": "agent_message", "message": "All green."}},
)
rows = [
    ("019a0000-0000-7000-8000-000000000001", "", 1760000000, 1760000600, "cli", "/srv/fixture/acme app", "Login fix", None, 0,
     "eng-12-login", "git@github.com:acme/acme-app.git", "Fix login", 1760000000000, 1760000600000),
    ("t9", str(rollout), 1760001000, 1760002000, "exec", "/srv/fixture/beta", None, "Beta tests", 0, None, None, "Run the tests",
     None, None),
    ("t2", "", 1, 2, '{"subagent":{"other":"guardian"}}', "/x", "Review", None, 0, None, None, "r", 1, 2),
    ("t3", "", 1, 2, "cli", "/x", "Old", None, 1, None, None, "o", 1, 2),
    ("t4", "", 1, 2, None, "/x", "Null source", None, 0, None, None, "n", 1, 2),
]
state.executemany("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
state.commit()
state.close()
history = sqlite3.connect(codex / "thread_history_1.sqlite")
history.execute("CREATE TABLE thread_items (thread_id TEXT, rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)")
for ordinal, kind, item in (
    (1, "userMessage", {"type": "userMessage", "content": [{"type": "text", "text": "Fix login"}]}),
    (2, "agentMessage", {"type": "agentMessage", "text": "Looking."}),
    (3, "userMessage", {"type": "userMessage", "content": [{"type": "text", "text": "<realtime_delegation>\n<input>Now add a test</input>"}]}),
    (4, "agentMessage", {"type": "agentMessage", "text": "Added the test. xoxb-1234567890-abc"}),
):
    history.execute("INSERT INTO thread_items VALUES (?, ?, ?, ?)", ("019a0000-0000-7000-8000-000000000001", ordinal, kind, json.dumps(item)))
history.commit()
history.close()

# The Windows side: Claude Desktop (an ssh mirror and a local one) and the ChatGPT desktop app.
lines(WIN / "davin" / ".claude" / "projects" / "ssh-1234" / "55555555-0000-4000-8000-000000000001.jsonl",
      user("hello over ssh", cwd="/srv/app", ts="2026-10-23T08:00:00Z"))
lines(WIN / "davin" / ".claude" / "projects" / "C--Users-davin-proj" / "55555555-0000-4000-8000-000000000002.jsonl",
      user("windows project", cwd="C:\\Users\\davin\\proj", ts="2026-10-23T09:00:00Z"))
(WIN / "Public" / ".claude").mkdir(parents=True)
wcodex = WIN / "davin" / ".codex"
wcodex.mkdir(parents=True)
ws = sqlite3.connect(wcodex / "state_5.sqlite")
ws.execute(
    "CREATE TABLE threads (id TEXT, rollout_path TEXT, created_at INTEGER, updated_at INTEGER, source TEXT, cwd TEXT,"
    " title TEXT, name TEXT, archived INTEGER, git_branch TEXT, git_origin_url TEXT, first_user_message TEXT,"
    " created_at_ms INTEGER, updated_at_ms INTEGER)"
)
ws.execute("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
           ("d1", "", 1, 2, "vscode", "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\srv\\fixture\\acme app", "Desktop thread", None, 0,
            "main", "https://github.com/acme/web.git/", "<realtime_delegation><input>Talk to me</input>", 1760003000000, 1760003600000))
ws.commit()
ws.close()

# A fixed mtime, so the source versions are stable across checkouts.
for root, _, files in os.walk(HERE):
    for f in files:
        os.utime(os.path.join(root, f), (1760000000, 1760000000))
