#!/bin/sh
# Rolls the ClickHouse pod to clear accumulated memory-tracker drift. See the CronJob
# for why this is scheduled rather than fixed in configuration.
set -eu

POD=kvorum-clickhouse-0

echo "restarting $POD"
kubectl delete pod "$POD" --wait=false

# Wait for the delete before waiting for Ready: the replacement keeps the pod name, so a
# Ready check issued immediately matches the still-terminating pod and returns at once.
kubectl wait --for=delete "pod/$POD" --timeout=120s || true
kubectl wait --for=condition=Ready "pod/$POD" --timeout=300s

echo "$POD ready"
