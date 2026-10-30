#!/bin/bash
# usage: repeat.sh <seconds> <stress args...>   reruns the stress until the time is up and counts how each run ended
end=$((SECONDS + $1)); shift
runs=0; crashes=0
while [ $SECONDS -lt $end ]; do
  node .github/segv-probe/stress.mjs "$@" > /tmp/stress.out 2>&1
  code=$?
  runs=$((runs + 1))
  if [ $code -ne 0 ]; then crashes=$((crashes + 1)); echo "run $runs exit $code: $(tail -c 300 /tmp/stress.out)"; fi
done
echo "RESULT $* runs=$runs crashes=$crashes"
