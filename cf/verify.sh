#!/usr/bin/env bash
# Kiểm tra nhanh Worker LIVE (không ghi dữ liệu). Chạy: bash cf/verify.sh
# Có thể override:  WORKER=https://... ORIGIN=https://... bash cf/verify.sh
set -u
WORKER="${WORKER:-https://the-prophet.lishace.workers.dev}"
ORIGIN="${ORIGIN:-https://lishacee.github.io}"
pass=0; fail=0
check(){ # desc | actual-contains | expected
  if echo "$2" | grep -q "$3"; then echo "  ✓ $1"; pass=$((pass+1));
  else echo "  ✗ $1 — got: $2"; fail=$((fail+1)); fi; }

echo "Worker: $WORKER   Origin: $ORIGIN"
echo "1) Worker sống + D1 đọc được (resume token sai -> lỗi phiên):"
check "resume rejects bad token" "$(curl -s -X POST "$WORKER" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{"fn":"resume","args":["nope"]}' --max-time 20)" "Phiên hết hạn"

echo "2) CORS khớp origin GitHub Pages:"
check "ACAO header matches origin" "$(curl -s -D - -o /dev/null -X POST "$WORKER" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{"fn":"resume","args":["x"]}' --max-time 20 | tr -d '\r')" "access-control-allow-origin: $ORIGIN"

echo "3) fn lạ -> báo lỗi rõ (không crash):"
check "unknown fn -> Unknown fn" "$(curl -s -X POST "$WORKER" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{"fn":"nope123","args":[]}' --max-time 20)" "Unknown fn"

echo "4) API cần đăng nhập -> chặn khi không có token:"
check "getPools requires auth" "$(curl -s -X POST "$WORKER" -H "Origin: $ORIGIN" -H 'Content-Type: text/plain' -d '{"fn":"getPools","args":[""]}' --max-time 20)" "Chưa đăng nhập"

echo
echo "Kết quả: $pass ✓  /  $fail ✗"
[ "$fail" -eq 0 ] && echo "PIPE OK — Worker + D1 + CORS + auth-gate hoạt động." || echo "CÓ LỖI — xem dòng ✗ ở trên."
