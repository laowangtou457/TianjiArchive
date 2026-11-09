# 天玑档案 变体 B 最小化安装 kickstart —— 统信 UOS Server 20 (1020e)
# 目的：装出一台「尽量接近出厂默认」的最小系统，用于实测 OS 基线六项。
# 刻意不做的事：不写 selinux 指令（要观察发行版默认态）、不动 kysec、不装 docker。
#version=RHEL8
text
skipx
lang en_US.UTF-8
keyboard us
timezone Asia/Shanghai --utc
rootpw --plaintext Tianji@2026
network --bootproto=dhcp --device=link --activate --hostname=tianji-uos
zerombr
clearpart --all --initlabel --drives=vda
# 故意全用 xfs：顺带验证 ftype 默认值（overlay2 前提）
part /boot --fstype=xfs --size=1024 --ondisk=vda
part / --fstype=xfs --size=10240 --grow --ondisk=vda
bootloader --location=mbr --driveorder=vda --append="console=ttyS0,115200n8"
sshkey --username=root "@SSH_PUBKEY@"

reboot

%packages --ignoremissing --excludedocs
@^minimal-environment
kernel
openssh-server
tar
xz
%end

%post --erroronfail
systemctl enable sshd
{
  echo "== installed at"; date -u
  echo "== uname -r"; uname -r
  echo "== ip a"; ip a
  echo "== selinux config"; cat /etc/selinux/config 2>/dev/null | grep -E '^SELINUX='
} > /root/facts-boot.txt
%end
