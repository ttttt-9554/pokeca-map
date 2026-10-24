"""Finish the applied arrival repair using already-verified title provenance.

The initial multi-file repair has already been committed. This follow-up
makes no network calls. Existing event names and dates remain untouched.
"""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
if '20261024-livepocket-new-arrival-repair' not in (root/'index.html').read_text():
    raise RuntimeError('Initial arrival repair is not present; stop for review')
changes = {}

def replace(path, old, new):
    source = (root/path).read_text(encoding='utf-8')
    if source.count(new) == 1:
        return
    if source.count(old) != 1:
        raise RuntimeError('Upstream source changed: '+path)
    changes[path] = source.replace(old,new)

replace('scripts/livepocket_v19.py',
        "origin.startswith(('v14_livepocket_', 'v21_official_'))",
        "origin.startswith(('v14_livepocket_', 'v21_official_', 'v21_9_official_exact_url_title'))")
replace('scripts/test_livepocket_new_arrivals.py',
        "'event_title':'v14_livepocket_rendered_public_page'",
        "'event_title':'v21_9_official_exact_url_title'")
for path, source in changes.items():
    (root/path).write_text(source,encoding='utf-8')
print('Verified-title provenance source files repaired:',len(changes))
