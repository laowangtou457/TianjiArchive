#!/usr/bin/env bash
# 变体 A 真机 e2e —— Ubuntu 22.04 guest 内 oneshot 全链驱动（S1→S10 + 终局核对）
# 与变体 B stageC-guest.sh 同构（e2e 的可复用骨架），差异点：
#   1. HTTP 客户端用 python3（ubuntu server 默认无 curl/wget，python3 内置）；
#   2. 结束不直接 poweroff，而是：摘除 stagec 单元与 flag -> disable docker ->
#      挂 collect 单元 -> reboot。-no-reboot 会把 QEMU 顶掉（容器退出），
#      宿主再起一次「收集引导」：docker0 不在，slirp SSH 可用，scp 取证。
#   3. 串口打点口径与变体 B 一致（echo > /dev/ttyS0，宿主 tail logs/ubuntu-boot.log）。
# 装载方式：宿主 e2e-ubuntu.sh prep 阶段经 ssh+sudo tee 推到 /root/stagec.sh。
set -u
OSN=ubuntu
LOG=/root/stagec-ubuntu.log
SER=/dev/ttyS0
exec > >(tee -a "$LOG") 2>&1

# 安全闸：未被 prep 阶段 arm 就什么都不做（防误挂自跑）
[ -f /root/stagec-armed ] || { echo "stagec: 未 arm，跳过"; exit 0; }

ck() { echo "=== CX $OSN $* ===" | tee -a "$LOG" > "$SER"; }

# python3 版 HTTP 客户端（guest 无 curl）
api_step() { # api_step <step> <outfile>
  python3 - "$1" "$2" <<'PY'
import json, sys, urllib.request
step, out = sys.argv[1], sys.argv[2]
req = urllib.request.Request("http://127.0.0.1:18080/api/step",
    data=json.dumps({"step": step}).encode(),
    headers={"Content-Type": "application/json"})
try:
    body = urllib.request.urlopen(req, timeout=2700).read()
except Exception as e:
    body = ("<err>%s</err>" % e).encode()
open(out, "wb").write(body)
print(step, "resp bytes", len(body))
PY
}
api_post() { # api_post <path> <jsonbody> <outfile>
  python3 - "$1" "$2" "$3" <<'PY'
import sys, urllib.request
path, body, out = sys.argv[1], sys.argv[2], sys.argv[3]
req = urllib.request.Request("http://127.0.0.1:18080" + path,
    data=body.encode(), headers={"Content-Type": "application/json"})
try:
    r = urllib.request.urlopen(req, timeout=300).read()
except Exception as e:
    r = ("<err>%s</err>" % e).encode()
open(out, "wb").write(r)
PY
}

echo "== stageC $OSN $(date -u '+%FT%TZ') =="
ck BOOT

echo "== [0] 前置核对 =="
df -h / | tail -1
echo "docker.service is-enabled: $(systemctl is-enabled docker.service 2>&1)"
echo "python3: $(python3 --version 2>&1)"

echo "== [1] 只读盘 dd tar 落普通文件（变体 B 同口径：tar 不走网络）=="
lsblk -b
rm -f /root/tianji-offline-images.tar
dd if=/dev/vdb of=/root/tianji-offline-images.tar bs=4M conv=fsync status=progress
echo "dd rc=$?"
TARSHA=$(sha256sum /root/tianji-offline-images.tar | awk '{print $1}')
echo "tar sha256: $TARSHA"
echo "期望    : 50fde9a8a99c5cac03f4f394083da4887637f03b65f8c8c9a3901dcde2ad1372"
if [ "$TARSHA" != "50fde9a8a99c5cac03f4f394083da4887637f03b65f8c8c9a3901dcde2ad1372" ]; then
  ck FATAL tar-sha-mismatch; systemctl poweroff; exit 5
fi

echo "== [2] 取 .run（HTTP 固定别名 server-setup.run，变体 B 同口径：.run 走网络）=="
rm -f /root/server-setup.run
python3 - <<'PY'
import hashlib, urllib.request
urllib.request.urlretrieve("http://10.0.2.2:8000/server-setup.run", "/root/server-setup.run")
h = hashlib.sha256()
with open("/root/server-setup.run", "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
print("run sha256:", h.hexdigest())
PY
echo "期望    : 5fab54c9dabeb29f943efee070f25d0123eb81b5306a8729c57b0f4365f0dc88"
if ! sha256sum /root/server-setup.run | grep -q 5fab54c9; then
  ck FATAL run-sha-mismatch; systemctl poweroff; exit 5
fi

echo "== [3] 启动安装器 --web --overwrite =="
if pgrep -f tianji-installer >/dev/null; then pkill -f tianji-installer; sleep 1; fi
nohup sh /root/server-setup.run --web --overwrite >/root/setup-web-C.log 2>&1 &
ready=0
for i in $(seq 1 120); do
  sleep 1
  if (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null; then ready=1; echo "18080 就绪（${i}s）"; break; fi
done
[ "$ready" = 1 ] || { ck FATAL web-18080; tail -30 /root/setup-web-C.log; systemctl poweroff; exit 4; }
grep -E "日志目录|状态文件" /root/setup-web-C.log | tail -2

echo "== [4] 登记 tar + 提交 env =="
api_post /api/images-tar '{"path":"/root/tianji-offline-images.tar"}' /root/c-tarreg.json
head -c 150 /root/c-tarreg.json; echo

GIP=$(ip -4 -o addr show | awk '$2!="lo"{print $4}' | cut -d/ -f1 | head -1)
echo "guest IP: $GIP"
api_post /api/env "{\"endpoint\":\"$GIP\",\"postgresPassword\":\"TianjiPg#2026e2e\",\"minioAccessKey\":\"tianji-e2e\",\"minioSecretKey\":\"TianjiMinio_2026e2e\",\"jwtAccessSecret\":\"e2e-jwt-access-secret-0123456789abcdef\",\"jwtRefreshSecret\":\"e2e-jwt-refresh-secret-fedcba9876543210\",\"redisPassword\":\"TianjiRedis#26\"}" /root/c-env.json
head -c 200 /root/c-env.json; echo

echo "== [5] S1（含确认门处理：OS 未登记 -> needsConfirm -> confirm 重跑）=="
S1OK=0
for try in 1 2; do
  api_step S1_PREFLIGHT /root/c-resp-S1.json
  if grep -q '"ok":true' /root/c-resp-S1.json; then S1OK=1; break; fi
  if grep -q needsConfirm /root/c-resp-S1.json; then
    echo "命中风险自担确认门，confirm 后重跑 S1"
    api_post /api/confirm '{}' /root/c-confirm.json
    continue
  fi
  break
done
[ "$S1OK" = 1 ] && ck S1-DONE || { ck FATAL S1; cat /root/c-resp-S1.json; systemctl poweroff; exit 6; }

echo "== [6] 逐步 S2→S10（/api/step 顺序门，不可跳步）=="
FAIL=0
for step in S2_VERIFY S3_DOCKER S4_IMAGES S5_ENV S6_UP S7_MIGRATE S8_SEED S9_SMOKE S10_DONE; do
  echo "---- $step 开始 $(date -u '+%FT%TZ') ----"
  api_step "$step" "/root/c-resp-$step.json"
  ok=$(grep -c '"ok":true' "/root/c-resp-$step.json" || true)
  echo "curl(ok)=$ok"
  head -c 400 "/root/c-resp-$step.json"; echo
  if [ "$ok" -ge 1 ] 2>/dev/null; then
    ck "$step-OK"
  else
    ck "$step-FAIL"
    cat "/root/c-resp-$step.json"
    FAIL=1
    break
  fi
done

echo "== [7] 终局核对 =="
echo "--- 进程存活（防 stale）：$(pgrep -f '[/]opt/tianji-installer/bin/tianji-installer' >/dev/null && echo YES || echo NO)"
echo "--- state.json 时间戳：$(stat -c '%y' /var/lib/tianji-install/state.json)"
python3 -c "import json;d=json.load(open('/var/lib/tianji-install/state.json'));print({k:v['status'] for k,v in d['steps'].items()})" 2>/dev/null
# docker CLI 位置按变体不同：变体 A（ubuntu/debian）走 deb 安装 → /usr/bin/docker；
# 变体 B（kylin/uos）走静态二进制 → /usr/local/lib/tianji/docker-static/docker。
# 硬编码静态路径会让变体 A 的终局核对打出「0 个镜像」的假阴性。
DCMD=$(command -v docker 2>/dev/null || echo /usr/local/lib/tianji/docker-static/docker)
echo "--- docker CLI：$DCMD"
echo "--- docker images：$($DCMD images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | wc -l) 个"
$DCMD images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null
echo "--- 容器健康："
$DCMD ps --format '{{.Names}} {{.Status}}' 2>/dev/null
echo "--- 冒烟结果："
python3 -c "import json;d=json.load(open('/root/c-resp-S9_SMOKE.json'));print(json.dumps(d['data'].get('smoke',[]),ensure_ascii=False,indent=1))" 2>/dev/null || true

echo "== [8] 收尾：摘单元 -> disable docker -> 挂 collect -> reboot =="
rm -f /root/stagec-armed
systemctl disable tianji-e2e-stagec.service >/dev/null 2>&1
systemctl disable docker.service docker.socket >/dev/null 2>&1
systemctl enable tianji-e2e-collect.service >/dev/null 2>&1
if [ "$FAIL" = 0 ]; then ck ALL-GREEN; else ck CHAIN-BROKEN; fi
sync
sleep 3
systemctl reboot
