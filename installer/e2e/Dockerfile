# 仅供 #41 闭环第 ③ 步使用：给 ubuntu:22.04 补上 systemd
# （官方 base 镜像只有 libsystemd0，没有 /lib/systemd/systemd，直接当 init 起会报
#  exec: "/lib/systemd/systemd": stat /lib/systemd/systemd: no such file or directory）
FROM ubuntu:22.04

# 换国内镜像源只是为了让构建机上「apt-get update」稳定：实测 archive.ubuntu.com 与
# 多个国内源在高峰时段会间歇 502，而这一步失败会让后面所有验证都做不成。
# 在能直连官方源的机器上，把下面两行 sed 删掉即可，其余不变。
RUN sed -i \
      -e 's|http://archive.ubuntu.com/ubuntu/\?|http://mirrors.aliyun.com/ubuntu/|g' \
      -e 's|http://security.ubuntu.com/ubuntu/\?|http://mirrors.aliyun.com/ubuntu/|g' \
      /etc/apt/sources.list \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus init-system-helpers \
      iproute2 procps ca-certificates curl gnupg \
 && rm -rf /var/lib/apt/lists/*

# systemd 在容器里作为 PID 1 时需要这个停止信号，否则 docker stop 会等到超时
STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
