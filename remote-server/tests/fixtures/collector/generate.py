"""Run the real Python collector over the fixture home and record what it reports.

    python3 -I generate.py /home/davin/jarvis/scripts/session_collector/collector.py

Writes expected.json (every SessionInput body it would PUT, keyed by tool:session_id)
and expected-dry-run.txt (its --dry-run table). Nothing is sent anywhere.
"""
import importlib.util
import io
import json
import os
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
collector_path = sys.argv[1]
os.environ["REMOTEA_BIN"] = str(HERE / "fake-remotea.sh")
os.environ["ERIDANI_MACHINE"] = "fixturepc"
os.environ["ERIDANI_BOT_KEY"] = "eri_bot_fixture_not_a_real_key"
os.environ["TZ"] = "UTC"

spec = importlib.util.spec_from_file_location("collector", collector_path)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)

home = HERE / "home"
real_glob = collector.glob.glob
collector.glob.glob = lambda pattern, *a, **k: real_glob(pattern.replace("/mnt/c/Users", str(HERE / "windows-users")), *a, **k)
collector.Path.home = staticmethod(lambda: home)
collector.STATE = Path(tempfile.mkdtemp()) / "state.json"
collector.time.sleep = lambda s: None
sent = {}
collector.send = lambda api, key, tool, sid, body: sent.__setitem__(f"{tool}:{sid}", body)

sys.argv = ["collector.py"]
with redirect_stdout(io.StringIO()):
    collector.main()
(HERE / "expected.json").write_text(json.dumps(dict(sorted(sent.items())), indent=2, ensure_ascii=False) + "\n")

collector.STATE = Path(tempfile.mkdtemp()) / "state.json"
sys.argv = ["collector.py", "--dry-run", "--days", "100000"]
out = io.StringIO()
with redirect_stdout(out):
    collector.main()
(HERE / "expected-dry-run.txt").write_text(out.getvalue())
print(f"{len(sent)} reports")
