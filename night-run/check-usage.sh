#!/usr/bin/env bash
# Usage gate for the night run: prints current 5h-block burn and exits 1 if >= GATE tokens.
# Gate = 90% of the largest historical block (proxy for the plan ceiling), per Karthi 2026-06-10.
GATE=${GATE:-179000000}
npx -y ccusage@latest blocks --json 2>/dev/null | python3 -c "
import json,sys,os
gate=int(os.environ.get('GATE','179000000'))
d=json.load(sys.stdin)
act=[b for b in d.get('blocks',[]) if b.get('isActive')]
if not act:
    print('no active block (fresh window)'); sys.exit(0)
b=act[0]
t=b.get('totalTokens',0)
print(f\"block {b.get('startTime')} -> {b.get('endTime')}  tokens={t:,}  gate={gate:,}  pct={100*t/gate:.0f}%\")
sys.exit(1 if t>=gate else 0)
"
