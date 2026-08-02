#!/usr/bin/env bash
# Run chunked ContactBox vision scan against production.
set -euo pipefail

JOB_ID="${1:-cmsauu2n90000o52u22p6djng}"
BASE="${SCAN_BASE_URL:-https://script-assembler.up.railway.app}"
CHUNK="${SCAN_CHUNK:-40}"
OUT="/tmp/scan-${JOB_ID}-full.json"

total=$(curl -s "$BASE/api/jobs/$JOB_ID" | python3 -c "import json,sys; j=json.load(sys.stdin).get('job',{}); print(j.get('sceneCount',0))")
echo "Job $JOB_ID · $total scenes · chunk=$CHUNK"

all_issues='[]'
total_in=0
total_out=0
total_cost=0
start=0

while [ "$start" -lt "$total" ]; do
  echo "Scanning start=$start limit=$CHUNK …"
  chunk_file="/tmp/scan-chunk-${start}.json"
  http=$(curl -s -w "%{http_code}" -o "$chunk_file" -X POST \
    "$BASE/api/jobs/$JOB_ID/scan?start=$start&limit=$CHUNK" \
    --max-time 600)
  if [ "$http" != "200" ]; then
    echo "FAILED HTTP $http at start=$start"
    cat "$chunk_file" | head -c 500
    exit 1
  fi
  read -r cin cout ccost cissues <<< "$(python3 -c "
import json
d=json.load(open('$chunk_file'))
print(d.get('usage',{}).get('inputTokens',0), d.get('usage',{}).get('outputTokens',0), d.get('costUsd',0), len(d.get('issues',[])))
")"
  total_in=$((total_in + cin))
  total_out=$((total_out + cout))
  python3 -c "
import json
acc=json.loads('$all_issues' if '$all_issues' != '[]' else '[]')
acc.extend(json.load(open('$chunk_file')).get('issues',[]))
print(json.dumps(acc))
" > /tmp/scan-acc.json
  all_issues=$(cat /tmp/scan-acc.json)
  total_cost=$(python3 -c "print($total_cost + $ccost)")
  echo "  chunk ok · issues=$cissues · cost=\$$(python3 -c "print(f'{$ccost:.4f}')")"
  start=$((start + CHUNK))
done

python3 -c "
import json
issues=json.loads('''$all_issues''')
by_sev={'critical':0,'minor':0}
for i in issues:
  by_sev[i.get('severity','minor')]=by_sev.get(i.get('severity','minor'),0)+1
out={
  'jobId':'$JOB_ID',
  'scanned': $total,
  'issues': issues,
  'issueCount': len(issues),
  'critical': by_sev.get('critical',0),
  'minor': by_sev.get('minor',0),
  'usage': {'inputTokens': $total_in, 'outputTokens': $total_out},
  'costUsd': $total_cost,
}
json.dump(out, open('$OUT','w'), indent=2)
print(json.dumps({k:out[k] for k in ['scanned','issueCount','critical','minor','usage','costUsd']}, indent=2))
"
echo "Wrote $OUT"
