#!/usr/bin/perl
# 极简静态文件 HTTP 服务：把 kickstart 与 .run 安装包喂给 guest。
# 镜像 tianji-qemu:1 里没有 python3/curl/busybox，只有 perl 5.34，故用 perl 核心模块实现。
#
# 特性：
#   * 流式发送：64KB 分块 syswrite，**不把整文件读进内存**（第一版用 `local $/` 整读，
#     喂 150MB 的 .run 时内存峰值可达数倍文件大小，且无续传能力）。
#   * Range 续传：支持 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`，
#     返回 206 + Content-Range，`curl -C -` 可从中断处继续；不合法范围返回 416。
#   * HEAD：只回头部，便于对端先探大小。
#   * 单连接异常不影响守护进程：`$SIG{PIPE}=IGNORE` + eval 包裹，否则 dracut 的客户端
#     半路断开会让 perl 被 SIGPIPE 直接打死，后续重试全部落空 → anaconda 卡到 dracut 超时。
#   * 访问日志写 stderr（run-vm.sh 落到 ks-serve/httpd.log），记录方法/路径/Range/UA/结果。
#
# 用法: perl ks-httpd.pl <端口> <目录>
use strict; use warnings;
use IO::Socket::INET;

my $port  = shift // 8000;
my $dir   = shift // '/vm/ks-serve';
my $CHUNK = 64 * 1024;
$SIG{PIPE} = 'IGNORE';      # 对端断开不能让守护进程死掉

my $srv = IO::Socket::INET->new(LocalAddr => '0.0.0.0', LocalPort => $port,
                                Listen => 8, ReuseAddr => 1, Proto => 'tcp')
  or die "listen $port: $!\n";
print "ks-httpd listening on :$port, root=$dir (streaming, Range supported)\n";
$| = 1;

while (my $c = $srv->accept) {
    # 一个连接出任何意外都只丢这一个连接，不能拖垮整个 serve 循环
    eval { serve_client($c); 1 } or print STDERR "conn error: $@";
    close $c;
}

sub serve_client {
    my ($c) = @_;
    # 头用 print / 体用 syswrite，必须保证顺序：autoflush 让头立刻落到 fd。
    $c->autoflush(1);

    my $line = <$c>;
    my %h;
    while (my $x = <$c>) {
        last if $x =~ /^\r?\n$/;
        $h{lc $1} = $2 if $x =~ /^([^:]+):\s*(.*?)\r?\n$/;
    }
    my ($method, $path) = ($line && $line =~ m{^(\S+)\s+(\S+)}) ? ($1, $2) : ('GET', '/');
    $path =~ s{\?.*$}{};
    $path =~ s{^/+}{};
    $path = 'ks.cfg' if $path eq '';

    my $file = "$dir/$path";
    if ($path =~ /\.\./ || ! -f $file) {
        my $msg = "not found: $path\n";
        print $c "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: "
               . length($msg) . "\r\nConnection: close\r\n\r\n$msg";
        logreq($method, $path, $h{range}, $h{'user-agent'}, '404', 0);
        return;
    }

    my $size = -s $file;
    my ($start, $end) = (0, $size - 1);
    my ($status, $crange) = (200, '');
    if (defined $h{range} && $h{range} =~ /^bytes=(\d*)-(\d*)$/) {
        my ($a, $b) = ($1, $2);
        if ($a eq '' && $b ne '') {                 # bytes=-N，末尾 N 字节
            $start = $size - $b; $start = 0 if $start < 0;
        } elsif ($a ne '') {                        # bytes=A- / bytes=A-B
            $start = $a + 0;
            $end   = ($b ne '' && $b + 0 < $size - 1) ? $b + 0 : $size - 1;
        }
        if ($start > $end || $start >= $size) {
            print $c "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */$size"
                   . "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            logreq($method, $path, $h{range}, $h{'user-agent'}, '416', 0);
            return;
        }
        $status = 206;
        $crange = "Content-Range: bytes $start-$end/$size\r\n";
    }

    my $len = $end - $start + 1;
    print $c "HTTP/1.1 $status " . ($status == 206 ? 'Partial Content' : 'OK') . "\r\n"
           . "Content-Type: application/octet-stream\r\n"
           . "Accept-Ranges: bytes\r\n"
           . $crange
           . "Content-Length: $len\r\nConnection: close\r\n\r\n";

    my $sent = 0;
    if (uc($method) ne 'HEAD') {
        if (open(my $fh, '<', $file)) {
            binmode $fh;
            if (seek($fh, $start, 0)) {
                my ($left, $buf) = ($len, '');
                while ($left > 0) {
                    my $want = $left < $CHUNK ? $left : $CHUNK;
                    my $n = sysread($fh, $buf, $want);
                    last unless defined $n && $n > 0;
                    my $off = 0;
                    while ($off < $n) {
                        my $w = syswrite($c, $buf, $n - $off, $off);
                        last unless defined $w && $w > 0;
                        $off += $w;
                    }
                    last if $off < $n;              # 对端断开，放弃本次连接
                    $sent += $n; $left -= $n;
                }
            }
            close $fh;
        }
    }
    logreq($method, $path, $h{range}, $h{'user-agent'}, $status, $sent);
}

sub logreq {
    my ($method, $path, $range, $ua, $status, $sent) = @_;
    printf STDERR '%s %s /%s range=%s ua=%s -> %s %dB',
      scalar(gmtime), $method, $path, ($range // '-'), ($ua // '-'), $status, $sent;
    print STDERR "\n";
}
