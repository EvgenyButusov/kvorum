#!/bin/sh
# Rolls the ClickHouse pod to clear accumulated memory-tracker drift. See the CronJob
# for why this is scheduled rather than fixed in configuration.
set -eu

POD=kvorum-clickhouse-0
TIMEOUT_TICKS=100
TICK_SECONDS=3

# Polled with `get` rather than `kubectl wait`, which needs list/watch on the whole pod
# collection: those verbs cannot be narrowed by resourceNames, so granting them would
# widen this job's Role from one pod to every pod in the namespace.
uid() { kubectl get pod "$POD" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }
ready() { kubectl get pod "$POD" -o jsonpath='{.status.containerStatuses[0].ready}' 2>/dev/null || true; }

OLD_UID=$(uid)
if [ -z "$OLD_UID" ]; then
  echo "$POD not found" >&2
  exit 1
fi

echo "restarting $POD (uid $OLD_UID)"
kubectl delete pod "$POD" --wait=false

# Compare uids, not readiness alone: the replacement keeps the pod name, so a readiness
# check on its own passes against the still-terminating pod and returns immediately.
tick=0
while [ "$tick" -lt "$TIMEOUT_TICKS" ]; do
  NEW_UID=$(uid)
  if [ -n "$NEW_UID" ] && [ "$NEW_UID" != "$OLD_UID" ] && [ "$(ready)" = "true" ]; then
    echo "$POD ready (uid $NEW_UID)"
    exit 0
  fi
  tick=$((tick + 1))
  sleep "$TICK_SECONDS"
done

echo "$POD did not become ready within $((TIMEOUT_TICKS * TICK_SECONDS))s" >&2
exit 1
