#!/usr/bin/perl
# 极简静态文件 HTTP 服务（仅用于把 kickstart 喂给 guest）。
# 镜像 tianji-qemu:1 里没有 python3/curl/busybox，只有 perl 5.34，故用 perl 核心模块实现。
# 用法: perl ks-httpd.pl <端口> <目录>
use strict; use warnings;
use IO::Socket::INET;

my $port = shift // 8000;
my $dir  = shift // '/vm/ks-serve';
my $srv = IO::Socket::INET->new(LocalAddr => '0.0.0.0', LocalPort => $port,
                                Listen => 8, ReuseAddr => 1, Proto => 'tcp')
  or die "listen $port: $!\n";
print "ks-httpd listening on :$port, root=$dir\n";
$| = 1;
while (my $c = $srv->accept) {
    my $line = <$c>;
    while (my $h = <$c>) { last if $h =~ /^\r?\n$/ }
    my $path = ($line && $line =~ m{^GET\s+(\S+)}) ? $1 : '/';
    $path =~ s{\?.*$}{};
    $path =~ s{^/}{};
    my $file = "$dir/$path";
    if ($path !~ /\.\./ && -f $file) {
        open(my $fh, '<', $file) or do { print $c resp(500, "open failed\n"); close $c; next };
        binmode $fh; local $/; my $body = <$fh>; close $fh;
        print $c resp(200, $body);
    } else {
        print $c resp(404, "not found: $path\n");
    }
    close $c;
}

sub resp {
    my ($code, $body) = @_;
    my $msg = $code == 200 ? 'OK' : ($code == 404 ? 'Not Found' : 'Error');
    $body = '' unless defined $body;
    return "HTTP/1.1 $code $msg\r\nContent-Type: text/plain\r\nContent-Length: "
         . length($body) . "\r\nConnection: close\r\n\r\n$body";
}
