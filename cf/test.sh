#!/usr/bin/env bash
# Chạy toàn bộ test trước khi deploy. Chạy: bash cf/test.sh
set -e
cd "$(dirname "$0")"
for t in test_auth test_core test_worker; do
  node "$t.mjs" 2>&1 | grep -v -E "ExperimentalWarning|trace-warnings|MODULE_TYPELESS"
done
echo "Tất cả test PASS."
