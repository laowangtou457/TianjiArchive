# =============================================================================
# tianji-windows-setup.ps1 —— 天玑档案管理系统 · Windows 变体（变体 C）编排器
#
# 设计：docs/Windows部署方案设计.md（v1.0）
# 架构：Windows 宿主编排（本脚本） + WSL2 Ubuntu 22.04 + 变体 A .run 原样复用
#       Linux 侧 S1→S10 闸门全部由 tianji-server-setup-ubuntu-debian-*.run 继承，
#       本脚本只负责宿主层：虚拟化底座 / 发行版 / 端口暴露 / 自启 / 冒烟。
#
# 阶段：S0 载荷校验 → S1 预检 → S2 虚拟化底座 → S3 发行版 → S4 服务端安装
#       → S5 端口暴露 → S6 自启 → S7 冒烟
#
# 用法（管理员 PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\tianji-windows-setup.ps1
#   powershell -ExecutionPolicy Bypass -File .\tianji-windows-setup.ps1 -PreflightOnly
#   powershell -ExecutionPolicy Bypass -File .\tianji-windows-setup.ps1 -RefreshPortProxy
#   powershell -ExecutionPolicy Bypass -File .\tianji-windows-setup.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\tianji-windows-setup.ps1 -Uninstall -PurgeData
#
# 退出码：0 成功 / 2 预检未过 / 3 载荷校验失败 / 4 阶段执行失败
#         7 S2 已启用特性需重启后重跑（state 已记，重跑自动续） / 8 用法错误
#
# 兼容性：Windows PowerShell 5.1（目标机不保证装了 pwsh 7，禁用 && / ?: 等语法）。
# 编码：本文件必须是 UTF-8 with BOM + CRLF（5.1 无 BOM 按 GBK 解析，中文全乱码；
#       出包脚本 build-windows-package.sh 有前置守卫，不合规直接拒绝出包）。
# 现场约束：解压路径不要含空格与中文（S4 的 .run 经 /mnt/<盘符> 拷入 WSL）。
# =============================================================================

[CmdletBinding()]
param(
    [switch]$PreflightOnly,
    [switch]$RefreshPortProxy,
    [switch]$Uninstall,
    [switch]$PurgeData,
    [switch]$Quiet,
    [string]$Version = '1.0.0',
    [string]$SetupDir = 'C:\tianji'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------
$DISTRO_NAME  = 'TianjiArchive'
$STATE_FILE   = Join-Path $SetupDir 'state.json'
$LOG_DIR      = Join-Path $SetupDir 'logs'
$BIN_DIR      = Join-Path $SetupDir 'bin'
$BOOT_PS1     = Join-Path $BIN_DIR 'tianji-boot.ps1'
$TASK_NAME    = 'TianjiArchive-Boot'
$FW_WEB_NAME  = 'TianjiArchive Web (8080)'
$FW_S3_NAME   = 'TianjiArchive S3 (8333)'
$PORT_WEB     = 8080
$PORT_S3      = 8333
$PORT_API     = 3000
$PORT_WIZARD  = 18080
$BOOT_TIMEOUT_SEC = 300   # boot.sh 就绪等待上限（真机数据待回填，设计 §9.5）
# 2026-11-13 真机缺陷修复（V4）：服务端安装器（.run）的 Web 向导在 S10 之后是**常驻
# Web 服务**，不会自行退出。S4 若用 WaitForExit 会永久阻塞（实测 166s 后进入死等）。
# 改为读 Linux 侧状态机判定完成：/var/lib/tianji-install/state.json 的 steps.S10_DONE.status。
$WIZ_STATE_IN_WSL = '/var/lib/tianji-install/state.json'
$S4_TIMEOUT_MIN   = 90    # 向导全程 10-40 分钟，留足余量（含用户手动操作时间）

$Script:ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PayloadDir = Join-Path $ScriptDir 'payload'

# ---------------------------------------------------------------------------
# 输出与日志
# ---------------------------------------------------------------------------
function Write-Log([string]$Level, [string]$Msg) {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [$Level] $Msg"
}
function Write-Stage([string]$Id, [string]$Title) {
    Write-Host ''
    Write-Host "==== $Id $Title ===="
}
function Die([int]$Code, [string]$Msg) {
    Write-Log 'FAIL' $Msg
    Write-Host ''
    Write-Host "安装未完成（退出码 $Code）。排查：$LOG_DIR 下最新日志。"
    exit $Code
}

# 全程留痕：Start-Transcript（C:\tianji\logs\setup-<ts>.log）
if (-not (Test-Path $LOG_DIR)) { New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null }
try {
    $transcriptPath = Join-Path $LOG_DIR ("setup-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Start-Transcript -Path $transcriptPath -ErrorAction Stop | Out-Null
} catch {
    Write-Log 'WARN' "日志转写启动失败（不阻断）：$($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# wsl.exe 调用包装：wsl.exe 输出是 UTF-16LE，PowerShell 5.1 默认按 ANSI 解码会
# 出 NUL 乱码（发行版名对不上、IP 取不出）。只对 wsl 调用切 Unicode，其它
# 原生程序（netsh/msiexec）不受影响。
# ---------------------------------------------------------------------------
function Invoke-Wsl {
    $prev = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    try { & wsl.exe @args } finally { [Console]::OutputEncoding = $prev }
}
function Invoke-WslDistro {
    # Invoke-WslDistro <bash命令>  —— 在发行版内以 root 执行，失败抛错语义由调用方判 $LASTEXITCODE
    $prev = [Console]::OutputEncoding
    [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
    try { & wsl.exe -d $DISTRO_NAME -u root -- bash -c $args[0] } finally { [Console]::OutputEncoding = $prev }
}
function Get-WslInstallState {
    # 读 Linux 侧安装器状态机（$WIZ_STATE_IN_WSL）。文件不存在/解析失败返回 $null。
    # 走进程字节流 + UTF-8 解码：state.json 是 UTF-8，而 [Console]::OutputEncoding
    # 在计划任务/重定向环境不可靠（同 Get-WslIp 的真机教训）。
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "$env:SystemRoot\System32\wsl.exe"
    $psi.Arguments = "-d $DISTRO_NAME -u root -- cat $WIZ_STATE_IN_WSL"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $psi.CreateNoWindow = $true
    try {
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit() | Out-Null
        if (-not $out -or -not $out.Trim()) { return $null }
        return ($out | ConvertFrom-Json)
    } catch { return $null }
}

# ---------------------------------------------------------------------------
# 状态机（断点重入：与 Linux 安装器同哲学，见安装器总体设计 §6.2）
# ---------------------------------------------------------------------------
function Read-State {
    if (Test-Path $STATE_FILE) {
        try { return Get-Content $STATE_FILE -Raw | ConvertFrom-Json } catch { return $null }
    }
    return $null
}
function Save-State([string]$Stage, [hashtable]$Steps) {
    $started = $null
    if (Test-Path $STATE_FILE) {
        $old = Read-State
        if ($old -and $old.startedAtUtc) { $started = $old.startedAtUtc }
    }
    if (-not $started) { $started = (Get-Date).ToUniversalTime().ToString('o') }
    $stepsObj = [ordered]@{}
    foreach ($k in $Steps.Keys) { $stepsObj[$k] = $Steps[$k] }
    $obj = [ordered]@{
        variant      = 'windows'
        version      = $Version
        stage        = $Stage
        startedAtUtc = $started
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        steps        = $stepsObj
    }
    Set-Content -Path $STATE_FILE -Value ($obj | ConvertTo-Json -Depth 5) -Encoding UTF8
}
function Mark-Step([hashtable]$Steps, [string]$Id, [string]$Result) {
    $Steps[$Id] = $Result
    Save-State $Id $Steps
}

# ---------------------------------------------------------------------------
# 管理员闸门
# ---------------------------------------------------------------------------
function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Die 2 'S1 预检：必须以管理员身份运行（右键 PowerShell → 以管理员身份运行）。'
    }
}

# ---------------------------------------------------------------------------
# S0 载荷校验（fail-closed：sha 不符绝不进入安装动作）
# ---------------------------------------------------------------------------
$Script:AssetRun     = ''   # tianji-server-setup-ubuntu-debian-*.run
$Script:AssetRootfs  = ''   # ubuntu-jammy-wsl-rootfs.tar.gz
$Script:AssetMsi     = ''   # wsl.msi

function Invoke-Stage0 {
    Write-Stage 'S0' '载荷校验'
    $sumsPath = Join-Path $PayloadDir 'SHA256SUMS.txt'
    if (-not (Test-Path $sumsPath)) { Die 3 "S0：找不到 $sumsPath —— 包不完整，请重新解压。" }

    $expected = @{}
    Get-Content $sumsPath | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2) { $expected[$parts[1].Trim('*')] = $parts[0].ToLower() }
    }
    if ($expected.Count -eq 0) { Die 3 'S0：SHA256SUMS.txt 为空或格式不符。' }

    $fails = 0
    foreach ($rel in $expected.Keys) {
        $full = Join-Path $PayloadDir $rel
        if (-not (Test-Path $full)) {
            Write-Log 'FAIL' "S0：载荷缺失 $rel"; $fails++; continue
        }
        $actual = (Get-FileHash -Path $full -Algorithm SHA256).Hash.ToLower()
        if ($actual -ne $expected[$rel]) {
            Write-Log 'FAIL' "S0：sha256 不符 $rel（期望 $($expected[$rel])，实际 $actual）"
            $fails++
        } else {
            Write-Log 'OK' "S0：$rel sha256 一致"
        }
    }
    if ($fails -gt 0) { Die 3 "S0：载荷校验未通过（$fails 处）——包损坏或被改动，禁止继续安装。" }

    $runs = Get-ChildItem $PayloadDir -Filter 'tianji-server-setup-ubuntu-debian-*.run' -ErrorAction SilentlyContinue
    if ($runs.Count -ne 1) { Die 3 'S0：payload 内必须有且只有一份变体 A .run。' }
    $rootfses = Get-ChildItem $PayloadDir -Filter 'ubuntu-jammy-wsl-rootfs.tar.gz' -ErrorAction SilentlyContinue
    $msis = Get-ChildItem $PayloadDir -Filter '*.msi' -ErrorAction SilentlyContinue
    if ($rootfses.Count -ne 1) { Die 3 'S0：缺少 ubuntu-jammy-wsl-rootfs.tar.gz。' }
    if ($msis.Count -ne 1) { Die 3 'S0：payload 内必须有且只有一份 wsl.msi（WSL 离线安装包）。' }

    $Script:AssetRun    = $runs[0].FullName
    $Script:AssetRootfs = $rootfses[0].FullName
    $Script:AssetMsi    = $msis[0].FullName

    # 版本绑定：.run 文件名里的版本必须与 -Version 一致（防编排器配旧服务端）
    if ($Script:AssetRun -notmatch [regex]::Escape("-$Version.run")) {
        Die 3 "S0：.run 版本与编排器 -Version=$Version 不一致（.run=$($runs[0].Name)）。"
    }
}

# ---------------------------------------------------------------------------
# S1 预检（硬闸 fail-closed；WARN 项不阻断）
# ---------------------------------------------------------------------------
function Invoke-PreflightChecks {
    $checks = New-Object System.Collections.Generic.List[object]

    # 1 管理员
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    $checks.Add(@{ id='A1'; name='管理员身份'; pass=$pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); detail=$id.Name })

    # 2 OS 矩阵（只认实测口径，见设计 §3）
    $os = Get-CimInstance Win32_OperatingSystem
    $caption = $os.Caption; $build = [int]($os.BuildNumber)
    $osOk = $false; $osNote = "$caption (build $build)"
    if ($caption -like '*Windows Server 2022*') { $osOk = $true }
    elseif ($caption -like '*Windows Server 2025*') { $osOk = $true }
    elseif ($caption -like '*Windows 11*') { $osOk = $true }
    elseif ($caption -like '*Windows 10*' -and $build -ge 19044) { $osOk = $true }
    else { $osNote = "$caption (build $build) —— 不在支持矩阵（Server 2019/2016、Win10 21H1 及更早不支持）" }
    $checks.Add(@{ id='A2'; name='操作系统版本'; pass=$osOk; detail=$osNote })

    # 3 虚拟化（WSL2 前提）
    $cs = Get-CimInstance Win32_ComputerSystem
    $hv = [bool]$cs.HypervisorPresent
    $hvNote = if ($hv) { '虚拟化监控程序已运行' } else { '未检测到 Hypervisor —— 物理机请到 BIOS 开启 VT-x/AMD-V；VM 请开启嵌套虚拟化' }
    $checks.Add(@{ id='A3'; name='虚拟化可用（HypervisorPresent）'; pass=$hv; detail=$hvNote })

    # 4 内存（≥8GB 硬闸；<16GB WARN 不阻断）
    $memGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    $memNote = "$memGB GB"
    if ($memGB -lt 16) { $memNote += '（低于建议值 16GB，WARN 不阻断）' }
    $checks.Add(@{ id='A4'; name='内存 ≥ 8GB'; pass=($memGB -ge 8); detail=$memNote })

    # 5 磁盘（系统盘剩余 ≥ 60GB）
    $sysDrive = $env:SystemDrive
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sysDrive'"
    $freeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
    $checks.Add(@{ id='A5'; name="$sysDrive 剩余 ≥ 60GB"; pass=($freeGB -ge 60); detail="$freeGB GB 可用（rootfs/镜像装载 + 数据卷增长）" })

    # 6 端口空闲（8080/8333/3000/18080）
    foreach ($p in @($PORT_WEB, $PORT_S3, $PORT_API, $PORT_WIZARD)) {
        $busy = $false
        try {
            $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p)
            $l.Start(); $l.Stop()
        } catch { $busy = $true }
        $pNote = if ($busy) { '被占用——先释放，或改服务端 .env 端口后同步改本脚本常量' } else { '可绑定' }
        $checks.Add(@{ id="A6-$p"; name="端口 $p 空闲"; pass=(-not $busy); detail=$pNote })
    }

    # 7 SetupDir 可写
    $dirOk = $true; $dirNote = $SetupDir
    try {
        if (-not (Test-Path $SetupDir)) { New-Item -ItemType Directory -Path $SetupDir -Force | Out-Null }
        $probe = Join-Path $SetupDir '.write-probe'
        Set-Content -Path $probe -Value 'probe' -ErrorAction Stop
        Remove-Item $probe -Force
    } catch { $dirOk = $false; $dirNote = "$SetupDir 不可写：$($_.Exception.Message)" }
    $checks.Add(@{ id='A7'; name='安装目录可写'; pass=$dirOk; detail=$dirNote })

    return ,$checks
}

function Invoke-Stage1 {
    Write-Stage 'S1' '预检'
    $checks = Invoke-PreflightChecks
    $failCount = 0
    foreach ($c in $checks) {
        $mark = if ($c.pass) { 'PASS' } else { 'FAIL' }
        if (-not $c.pass) { $failCount++ }
        Write-Host ("  [{0}] {1} ：{2}" -f $mark, $c.name, $c.detail)
    }
    if ($failCount -gt 0) { Die 2 "S1 预检：$failCount 项未通过（见上），按明细处置后重跑。" }
    Write-Log 'OK' 'S1 预检全部通过'
}

# ---------------------------------------------------------------------------
# S2 虚拟化底座：VirtualMachinePlatform + WSL MSI
# ---------------------------------------------------------------------------
function Invoke-Stage2([hashtable]$Steps) {
    Write-Stage 'S2' '虚拟化底座（VirtualMachinePlatform + WSL MSI）'

    # 2a 特性启用（幂等：已启用直接过）
    # 2026-11-13 真机缺陷修复：Store 版 WSL（wsl.msi）在 Server 2022 上除 VirtualMachinePlatform
    # 外仍需 Microsoft-Windows-Subsystem-Linux（Pico provider），缺失时 wsl --import 报
    # WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED。两个特性一起幂等启用。
    $features = @('VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux')
    foreach ($fname in $features) {
        try {
            $feat = Get-WindowsOptionalFeature -Online -FeatureName $fname -ErrorAction Stop
        } catch {
            Die 4 "S2：无法查询 $fname 状态：$($_.Exception.Message)"
        }
        if ($feat.State -ne 'Enabled') {
            Write-Log 'INFO' "S2：启用 $fname ……"
            try {
                $r = Enable-WindowsOptionalFeature -Online -FeatureName $fname -NoRestart -ErrorAction Stop
            } catch {
                Die 4 "S2：启用 $fname 失败：$($_.Exception.Message)"
            }
            if ($r.RestartNeeded) {
                Mark-Step $Steps 'S2' 'REBOOT_PENDING'
                Die 7 'S2：特性已启用但需要重启。请重启本机后重新运行本脚本（会从 S2 自动续装）。'
            }
            Write-Log 'OK' "S2：$fname 已启用（无需重启）"
        } else {
            Write-Log 'OK' "S2：$fname 已启用"
        }
    }

    # 2b WSL MSI（3010 = 成功但需重启，同样按重启闸处理）
    Write-Log 'INFO' 'S2：安装 WSL MSI（离线 Store 版 wsl.exe + 内核）……'
    $p = Start-Process msiexec.exe -ArgumentList "/i `"$Script:AssetMsi`" /qn /norestart" -Wait -PassThru
    if ($p.ExitCode -eq 3010) {
        Mark-Step $Steps 'S2' 'REBOOT_PENDING'
        Die 7 'S2：WSL MSI 安装完成但需要重启。请重启后重新运行本脚本。'
    }
    if ($p.ExitCode -ne 0) {
        Die 4 "S2：WSL MSI 安装失败（msiexec 退出码 $($p.ExitCode)）。"
    }
    Mark-Step $Steps 'S2' 'DONE'
    Write-Log 'OK' 'S2：虚拟化底座就绪'
}

function Assert-WslReady {
    $wslCmd = Get-Command wsl.exe -ErrorAction SilentlyContinue
    if (-not $wslCmd) {
        Die 4 'S3：找不到 wsl.exe —— MSI 安装后请关闭并重新打开 PowerShell 再重跑（PATH 刷新）。'
    }
}

# ---------------------------------------------------------------------------
# S3 发行版导入 + systemd + .wslconfig
# ---------------------------------------------------------------------------
function Invoke-Stage3([hashtable]$Steps) {
    Write-Stage 'S3' 'WSL 发行版（Ubuntu 22.04）'
    Assert-WslReady

    # 幂等：发行版已存在则跳过导入（wsl -l 输出 UTF-16，Invoke-Wsl 已处理解码）
    $listed = (Invoke-Wsl --list --quiet 2>$null | Out-String)
    $names = $listed -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
    if ($names -contains $DISTRO_NAME) {
        Write-Log 'OK' "S3：发行版 $DISTRO_NAME 已存在（断点续装，跳过导入）"
    } else {
        $wslRoot = Join-Path $SetupDir 'wsl'
        if (-not (Test-Path $wslRoot)) { New-Item -ItemType Directory -Path $wslRoot -Force | Out-Null }
        Write-Log 'INFO' "S3：导入 $DISTRO_NAME（rootfs → $wslRoot，约 1-3 分钟）……"
        & wsl.exe --import $DISTRO_NAME $wslRoot $Script:AssetRootfs --version 2
        if ($LASTEXITCODE -ne 0) { Die 4 "S3：wsl --import 失败（退出码 $LASTEXITCODE）。" }
        Write-Log 'OK' 'S3：发行版导入完成'
    }

    # /etc/wsl.conf：systemd=true（变体 A 的 docker deb 依赖 systemctl enable）
    # 用 base64 传输避免 CRLF/编码破坏（PowerShell 管道给原生 stdin 会带 \r）
    # 2026-11-13 真机缺陷修复：换行转义必须是 PowerShell 的反引号 `n，
    # 此前误用 C 风格 \n → 写出的 conf 是字面量 \n 字符，wsl 解析报
    # "Expected ' ' or '\n' in /etc/wsl.conf:1"，systemd 从未生效。
    $confLines = "[boot]`nsystemd=true`n[network]`nhostname=TianjiArchive`ngenerateHosts=false"
    $confB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($confLines))
    Invoke-WslDistro "echo $confB64 | base64 -d > /etc/wsl.conf" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 4 'S3：写入 /etc/wsl.conf 失败。' }
    Write-Log 'OK' 'S3：/etc/wsl.conf systemd=true 已写入'

    # .wslconfig：资源上限。只在用户文件不存在或含 Tianji 标记时写——不覆盖用户已有配置。
    $wslconfigPath = Join-Path $env:UserProfile '.wslconfig'
    $marker = '# TianjiArchive managed block'
    $needWrite = $true
    if (Test-Path $wslconfigPath) {
        $existing = Get-Content $wslconfigPath -Raw
        if ($existing -and (-not $existing.Contains($marker))) {
            Write-Log 'WARN' "S3：$wslconfigPath 已存在且非 Tianji 生成——不覆盖。如需托管资源请手工并入：memory=8GB"
            $needWrite = $false
        }
    }
    if ($needWrite) {
        $cs = Get-CimInstance Win32_ComputerSystem
        $memGB = [math]::Floor($cs.TotalPhysicalMemory / 1GB)
        # 2026-11-13 真机缺陷修复：WSL 上限必须给足——安装器 K10 判据要求 WSL 内
        # MemTotal ≥ 8GB，而 WSL2 的 memory= 上限还要扣内核开销（8GB 上限实测
        # MemTotal 仅 ~7.4GB）。且 .wslconfig 全部行无效时 WSL2 退到「物理 50%」，
        # 12GB 机器 MemTotal 只有 6GB → S1 必 FAIL。新梯度：物理 ≥16GB 给 12GB，
        # ≥12GB 给 10GB（留 2GB 给 Windows），<12GB 保持 6GB 并 WARN（S1 会拦）。
        $wslMem = '6GB'
        if ($memGB -ge 16) { $wslMem = '12GB' } elseif ($memGB -ge 12) { $wslMem = '10GB' }
        # 2026-11-13 真机缺陷修复：.wslconfig 必须有 [wsl2] 段头，否则 memory/processors
        # 等行全部无效（wsl 启动时逐行报 "-N 无效"）。此前以注释行开头，漏了段头。
        $cfg = "[wsl2]`n$marker`nmemory=$wslMem`nprocessors=4`nswap=2GB`nlocalhostForwarding=true"
        Set-Content -Path $wslconfigPath -Value $cfg -Encoding ASCII
        Write-Log 'OK' "S3：.wslconfig 资源上限 memory=$wslMem processors=4"
        if ($wslMem -eq '6GB') {
            Write-Log 'WARN' "S3：物理内存 ${memGB}GB 不足 12GB，WSL 上限只能给 6GB——S1 内存判据会 FAIL，请扩内存后重装。"
        }
        # .wslconfig 只在 wsl --shutdown 后生效；此处 terminate 单个发行版不够
        # （VM 配额是全局的），必须 shutdown。已 DONE 的阶段断点续装会自动跳过。
        wsl --shutdown 2>$null | Out-Null
        Start-Sleep -Seconds 3
    }

    # systemd 在下次发行版启动时生效
    Invoke-Wsl --terminate $DISTRO_NAME 2>$null | Out-Null
    Mark-Step $Steps 'S3' 'DONE'
    Write-Log 'OK' 'S3：发行版就绪（systemd 于下次启动生效）'
}

function WslPathOf([string]$WinPath) {
    # D:\x\y → /mnt/d/x/y（编排器与 payload 同盘，drvfs 默认挂载）
    # 2026-11-13 真机缺陷修复：盘符必须转小写——WSL2 挂载点固定为小写 /mnt/<drive>，
    # 实测 /mnt/C 直接 No such file（即便 drvfs 通常大小写不敏感也不可靠）。
    $drive = $WinPath.Substring(0, 1).ToLowerInvariant()
    $rest = $WinPath.Substring(2)
    return ('/mnt/' + $drive + ($rest -replace '\\', '/'))
}

# ---------------------------------------------------------------------------
# S4 服务端安装（变体 A .run 在 WSL 内执行；Web 向导 localhost:18080）
# ---------------------------------------------------------------------------
function Invoke-Stage4([hashtable]$Steps) {
    Write-Stage 'S4' '服务端安装（变体 A .run，Web 向导）'
    Assert-WslReady

    # .run 拷入发行版固定位置（不依赖 drvfs 挂载盘符）
    $inWsl = '/opt/tianji-installer/server-setup.run'
    $srcWsl = WslPathOf $Script:AssetRun
    Invoke-WslDistro "mkdir -p /opt/tianji-installer && cp '$srcWsl' '$inWsl' && chmod +x '$inWsl' && sha256sum '$inWsl'" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 4 'S4：.run 拷入 WSL 失败（注意解压路径不能含空格/中文）。' }
    Write-Log 'OK' 'S4：.run 已拷入发行版'

    # boot.sh（S6 用）：起栈 + 等 web healthy + 显式超时
    # bash 内容用 base64 传输（防 CRLF 注入；$ 变量不被 PowerShell 或 bash 提前展开）
    $bootSh = @'
#!/usr/bin/env bash
# TianjiArchive boot（Windows 变体 S6 用）：起栈 + 等 web healthy + 显式超时
set -u
TIMEOUT_SEC=__BOOT_TIMEOUT__
LOG=/opt/tianji/logs/boot.log
mkdir -p /opt/tianji/logs
{
  echo "[boot] $(date -Is) start"
  cd /opt/tianji
  # 与安装器 stack.go 同源：全局 flag（-f / --env-file）必须在子命令之前
  docker compose -f /opt/tianji/docker-compose.offline.yml --env-file /opt/tianji/.env up -d
  i=0
  while [ "$i" -lt "$TIMEOUT_SEC" ]; do
    st=$(docker inspect -f '{{.State.Health.Status}}' tianji-web 2>/dev/null || echo unknown)
    if [ "$st" = "healthy" ]; then echo "[boot] web healthy"; exit 0; fi
    sleep 5; i=$((i+5))
  done
  echo "[boot] TIMEOUT: web not healthy in ${TIMEOUT_SEC}s"
  exit 1
} >> "$LOG" 2>&1
'@
    $bootSh = $bootSh.Replace('__BOOT_TIMEOUT__', "$BOOT_TIMEOUT_SEC")
    # 2026-11-13 真机缺陷修复（V6）：here-string 保留 CRLF 行尾，base64 忠实带过去，
    # bash 报 set: -\r invalid option / ${'\r'} command not found（rc=127/1）。
    # base64 编码前必须归一为 LF。
    $bootSh = $bootSh.Replace("`r`n", "`n")
    $bootB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bootSh))
    Invoke-WslDistro "mkdir -p /opt/tianji/bin /opt/tianji/logs && echo $bootB64 | base64 -d > /opt/tianji/bin/boot.sh && chmod +x /opt/tianji/bin/boot.sh" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 4 'S4：boot.sh 写入失败。' }
    Write-Log 'OK' 'S4：boot.sh 已就位'

    # 启动 .run（Web 向导 localhost:18080）。**不等待进程退出**——向导在 S10 之后是
    # 常驻 Web 服务，WaitForExit 会永久阻塞（2026-11-13 真机实测：S10 已 DONE 但进程不退）。
    # 改为双判据轮询：以 Linux 侧 state.json 的 S10_DONE 为准，进程退出仅作错误早退信号。
    Write-Host ''
    Write-Host '  ▶ 服务端安装器即将在发行版内启动。请在【宿主浏览器】打开：'
    Write-Host "      http://localhost:$PORT_WIZARD"
    Write-Host '    按向导完成 S1→S10（与 Linux 变体完全相同的闸门与单步通道）。'
    Write-Host "    本脚本轮询安装进度（上限 $S4_TIMEOUT_MIN 分钟，安装全程通常 10-40 分钟）……"
    Write-Host ''
    $runArgs = "-d $DISTRO_NAME -u root -- sh $inWsl"
    $proc = Start-Process wsl.exe -ArgumentList $runArgs -PassThru -WindowStyle Hidden
    $deadline = (Get-Date).AddMinutes($S4_TIMEOUT_MIN)
    $s4Done = $false
    $lastReport = Get-Date
    while ((Get-Date) -lt $deadline) {
        $st = Get-WslInstallState
        if ($st -and $st.steps -and $st.steps.S10_DONE -and $st.steps.S10_DONE.status -eq 'DONE') {
            $s4Done = $true
            break
        }
        if ($proc.HasExited) {
            if ($proc.ExitCode -ne 0) {
                Die 4 "S4：服务端安装器退出码 $($proc.ExitCode) —— 按向导/日志排障后重跑（断点续装，已 DONE 的阶段自动跳过）。"
            }
            # 退出码 0 不等于装完：以 state.json 为准再判一次（上面已判，这里必为未完成）
            Die 4 "S4：安装器已退出（rc=0）但 S10_DONE 未完成 —— 检查 $WIZ_STATE_IN_WSL 与向导日志。"
        }
        # 每 60 秒报一次进度，避免长时间静默让用户以为卡死
        if (((Get-Date) - $lastReport).TotalSeconds -ge 60) {
            $cur = if ($st -and $st.steps) {
                (($st.steps.PSObject.Properties | Where-Object { $_.Value.status -eq 'DONE' } | ForEach-Object { $_.Name }) -join ',')
            } else { '（尚未生成 state.json）' }
            Write-Log 'INFO' "S4 进行中，已完成步骤：$cur"
            $lastReport = Get-Date
        }
        Start-Sleep -Seconds 5
    }
    if (-not $s4Done) {
        Die 4 "S4：等待安装器完成超时（$S4_TIMEOUT_MIN 分钟）。向导仍在 http://localhost:$PORT_WIZARD，可续装后重跑本脚本（已 DONE 阶段自动跳过）。"
    }
    if (-not $proc.HasExited) {
        # 向导是常驻 Web 服务，留着不杀：它会作为 WSL 的活动会话顺带钉住 VM。
        Write-Log 'INFO' 'S4：向导进程仍在后台运行（常驻 Web 服务，正常现象）'
    }
    Mark-Step $Steps 'S4' 'DONE'
    Write-Log 'OK' 'S4：服务端安装完成（S1→S10 全 DONE）'
}

# ---------------------------------------------------------------------------
# WSL IP 与端口暴露
# ---------------------------------------------------------------------------
function Get-WslIp {
    # 2026-11-13 真机缺陷修复：计划任务/重定向环境下 [Console]::OutputEncoding 切换
    # 不可靠，Invoke-WslDistro 的 UTF-16 解码会得到乱码导致取不到 IP。改为进程
    # 字节流自读，Unicode / UTF-8 两种解码各试一次（wsl.exe 输出编码随宿主环境变）。
    foreach ($enc in @([System.Text.Encoding]::Unicode, [System.Text.Encoding]::UTF8)) {
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = "$env:SystemRoot\System32\wsl.exe"
        $psi.Arguments = "-d $DISTRO_NAME -u root -- hostname -I"
        $psi.UseShellExecute = $false
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = $enc
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        if ($out -match '(\d+\.\d+\.\d+\.\d+)') { return $Matches[1] }
    }
    return $null
}

function Invoke-RefreshPortProxy {
    Assert-Admin
    Assert-WslReady
    $ip = Get-WslIp
    if (-not $ip) { Die 4 '端口暴露：取不到 WSL IP（发行版未运行？先完成安装，或手动 wsl -d TianjiArchive 再试）。' }
    Write-Log 'INFO' "portproxy 目标 WSL IP = $ip"
    foreach ($port in @($PORT_WEB, $PORT_S3)) {
        & netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$port 2>$null | Out-Null
        & netsh.exe interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=$port connectaddress=$ip connectport=$port | Out-Null
        if ($LASTEXITCODE -ne 0) { Die 4 "端口暴露：portproxy 配置失败（端口 $port）。" }
        # 2026-11-13 真机缺陷修复：0.0.0.0 的 v4tov4 不覆盖回环流量（127.0.0.1 直连
        # 不走路由），本机浏览器/冒烟访问 localhost:$port 会挂。补一条回环规则。
        & netsh.exe interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=$port 2>$null | Out-Null
        & netsh.exe interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=$port connectaddress=$ip connectport=$port | Out-Null
        if ($LASTEXITCODE -ne 0) { Die 4 "端口暴露：portproxy 回环规则配置失败（端口 $port）。" }
    }
    foreach ($rule in @(@($FW_WEB_NAME, $PORT_WEB), @($FW_S3_NAME, $PORT_S3))) {
        $name = $rule[0]; $port = $rule[1]
        $exists = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
        if (-not $exists) {
            New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Any | Out-Null
            Write-Log 'OK' "防火墙放行 TCP $port"
        }
    }
    Write-Log 'OK' "portproxy 就绪：宿主:$PORT_WEB → WSL:$PORT_WEB，宿主:$PORT_S3 → WSL:$PORT_S3"
    return $ip
}

function Invoke-Stage5([hashtable]$Steps) {
    Write-Stage 'S5' '端口暴露（portproxy + 防火墙）'
    Invoke-RefreshPortProxy | Out-Null

    # LAN 自测：必须用真实网卡地址（不是 localhost——那测不出 portproxy）。
    # 排除回环 / WSL 的 vEthernet / 链路本地地址。
    $lanIp = $null
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object {
        if ($lanIp) { return }
        if ($_.IPAddress -like '127.*') { return }
        if ($_.IPAddress -like '169.254.*') { return }
        if ($_.InterfaceAlias -like '*WSL*' -or $_.InterfaceAlias -like '*Loopback*') { return }
        $lanIp = $_.IPAddress
    }
    if ($lanIp) {
        try {
            $resp = Invoke-WebRequest -Uri "http://${lanIp}:${PORT_WEB}/healthz" -UseBasicParsing -TimeoutSec 10
            # 2026-11-13 真机缺陷修复：-UseBasicParsing 下 Content 可能是 Byte[]
            # （PS 5.1 按 content-type 判定），直接 .Trim() 抛「Byte[] 不含 Trim」。
            $ct = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
            if ($resp.StatusCode -eq 200 -and $ct.Trim() -eq 'ok') {
                Write-Log 'OK' "S5：LAN 自测通过（http://${lanIp}:${PORT_WEB}/healthz = ok）"
            } else {
                Die 4 "S5：LAN 自测异常（status=$($resp.StatusCode) content=$($resp.Content)）。"
            }
        } catch {
            Die 4 "S5：LAN 自测失败（${lanIp}:$PORT_WEB）：$($_.Exception.Message) —— 查 portproxy 与防火墙规则。"
        }
    } else {
        Write-Log 'WARN' 'S5：取不到本机 IPv4 地址，跳过 LAN 自测（localhost 已通；LAN 侧待现场复核）。'
    }
    Mark-Step $Steps 'S5' 'DONE'
}

# ---------------------------------------------------------------------------
# S6 开机自启（计划任务 SYSTEM / ONSTART）
# ---------------------------------------------------------------------------
function Invoke-Stage6([hashtable]$Steps) {
    Write-Stage 'S6' '开机自启'
    if (-not (Test-Path $BIN_DIR)) { New-Item -ItemType Directory -Path $BIN_DIR -Force | Out-Null }

    # 核心脚本自拷贝：boot 任务调用的 core 版 = 当前脚本（-RefreshPortProxy 模式）
    # 2026-11-13 真机缺陷修复：函数作用域内 $MyInvocation.MyCommand.Path 指向函数
    # （null），必须用 $PSCommandPath（任何作用域都指向脚本文件）。
    Copy-Item $PSCommandPath (Join-Path $BIN_DIR 'tianji-windows-setup-core.ps1') -Force

    # 宿主 boot 包装：刷 portproxy（WSL IP 漂移）→ 起栈 → 全程追加日志留痕
    # 2026-11-13 真机缺陷修复（V6）：开机瞬间发行版尚未启动（WSL 冷启动需数秒到数十秒），
    # core -RefreshPortProxy 取 IP 失败、boot.sh 也失败。修复：先预热 wsl（true 重试
    # 12×5s），RefreshPortProxy 失败降级为 WARN 继续（旧 portproxy 大概率仍有效）。
    $bootTpl = @'
# TianjiArchive 开机自启包装（由安装器生成；不要手工改 portproxy 逻辑）
$ErrorActionPreference = 'Continue'
$log = 'C:\tianji\logs\boot-__TS__.log'
"[boot-ps1] $(Get-Date -Format o) start" | Out-File $log -Append -Encoding utf8
try {
    # 预热：发行版冷启动（开机后 systemd 引导需数秒到数十秒）
    $okWsl = $false
    for ($i = 1; $i -le 12; $i++) {
        & wsl.exe -d __DISTRO__ -u root -- true 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $okWsl = $true; "[boot-ps1] wsl warm after ${i} tries" | Out-File $log -Append -Encoding utf8; break }
        Start-Sleep -Seconds 5
    }
    if ($okWsl) {
        & 'C:\tianji\bin\tianji-windows-setup-core.ps1' -RefreshPortProxy *>> $log
        "[boot-ps1] portproxy rc=$LASTEXITCODE（非 0 降级继续，旧规则大概率仍有效）" | Out-File $log -Append -Encoding utf8
        & wsl.exe -d __DISTRO__ -u root -- /opt/tianji/bin/boot.sh *>> $log
        "[boot-ps1] boot.sh rc=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
        # 2026-11-13 真机缺陷修复（V6 终局）：WSL2 VM 在没有附着会话时自动关闭
        # （后台容器不算活动会话）→ boot 任务退出后几十秒容器全灭。起一个分离的
        # 常驻 wsl 会话钉住 VM（任务 ExecutionTimeLimit 必须为 0/无限，见注册处）。
        Start-Process wsl.exe -ArgumentList '-d','__DISTRO__','-u','root','--','sleep','infinity' -WindowStyle Hidden
        "[boot-ps1] keep-alive wsl session started" | Out-File $log -Append -Encoding utf8
    } else {
        "[boot-ps1] FATAL: wsl warm failed after 60s" | Out-File $log -Append -Encoding utf8
    }
} catch {
    ("[boot-ps1] EXC " + $_.Exception.Message) | Out-File $log -Append -Encoding utf8
}
'@
    $bootPs = $bootTpl.Replace('__TS__', (Get-Date -Format 'yyyyMMdd')).Replace('__DISTRO__', $DISTRO_NAME)
    Set-Content -Path $BOOT_PS1 -Value $bootPs -Encoding UTF8

    $exists = Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue
    if ($exists) { Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false }
    $action    = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$BOOT_PS1`""
    $trigger   = New-ScheduledTaskTrigger -AtStartup
    # 2026-11-13 真机缺陷修复（V6）：不能用 SYSTEM——WSL 发行版是 per-user 的，
    # SYSTEM 上下文里 wsl -d TianjiArchive 报「无效的分发名称」。改用安装用户 +
    # S4U（免密码、开机自动运行、非交互），RunLevel Highest 保管理员令牌。
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
    # ExecutionTimeLimit 0 = 无限制：任务里的常驻 keep-alive wsl 会话不能被 1 小时上限杀掉
    $settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TASK_NAME -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Mark-Step $Steps 'S6' 'DONE'
    Write-Log 'OK' "S6：计划任务 $TASK_NAME 已注册（开机 → 刷 portproxy → 起栈）"
}

# ---------------------------------------------------------------------------
# S7 冒烟（与 client-lite 自检.ps1 / offline/smoke.sh 同口径三项）
# ---------------------------------------------------------------------------
function Invoke-Smoke {
    $allPass = $true

    # 1/3 网站服务
    # 2026-11-13 真机缺陷修复：portproxy 是 v4tov4（只听 IPv4），而 localhost 在
    # Server 2022 上优先解析 ::1（IPv6）→ 连接失败假阴性。冒烟一律走 127.0.0.1。
    $ok1 = $false
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT_WEB/healthz" -UseBasicParsing -TimeoutSec 10
        $body1 = if ($r.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
        $ok1 = ($r.StatusCode -eq 200 -and $body1.Trim() -eq 'ok')
    } catch { }
    if (-not $ok1) { $allPass = $false }
    Write-Host ("  [{0}] 1/3 网站服务  http://127.0.0.1:$PORT_WEB/healthz" -f $(if ($ok1) { 'PASS' } else { 'FAIL' }))

    # 2/3 后端接口（status=ok 且 objectStorage.ok=true）
    # 2026-11-13 真机缺陷修复：/api/health 实际结构是 {code, data:{status, deps:[{name,ok}]}}
    # —— status 在 data 里、objectStorage 是 deps 数组元素，原断言 $j.status /
    # $j.objectStorage.ok 恒为 null 必 FAIL。Content 在 -UseBasicParsing 下还可能是
    # Byte[]，先归一化。
    $ok2 = $false
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT_WEB/api/health" -UseBasicParsing -TimeoutSec 15
        $body = if ($r.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($r.Content) } else { [string]$r.Content }
        $j = $body | ConvertFrom-Json
        $d = if ($j.data) { $j.data } else { $j }
        $os = @($d.deps | Where-Object { $_.name -eq 'objectStorage' })
        $ok2 = ($d.status -eq 'ok' -and $os.Count -gt 0 -and $os[0].ok -eq $true)
    } catch { }
    if (-not $ok2) { $allPass = $false }
    Write-Host ("  [{0}] 2/3 后端接口  /api/health (status=ok, objectStorage.ok=true)" -f $(if ($ok2) { 'PASS' } else { 'FAIL' }))

    # 3/3 对象存储 TCP
    $ok3 = $false
    try {
        $c = New-Object Net.Sockets.TcpClient
        $c.Connect('127.0.0.1', $PORT_S3); $c.Close(); $ok3 = $true
    } catch { }
    if (-not $ok3) { $allPass = $false }
    Write-Host ("  [{0}] 3/3 对象存储  127.0.0.1:$PORT_S3 TCP" -f $(if ($ok3) { 'PASS' } else { 'FAIL' }))

    return $allPass
}

function Invoke-Stage7([hashtable]$Steps) {
    Write-Stage 'S7' '收尾冒烟'
    $allPass = Invoke-Smoke
    if (-not $allPass) { Die 4 'S7 冒烟：存在 FAIL 项——栈未就绪，按明细排障后重跑（已完成阶段自动跳过）。' }
    Mark-Step $Steps 'S7' 'DONE'
    Write-Host ''
    Write-Host '  IS_PASS: YES —— 安装完成。'
    Write-Host "  用户访问：http://<本机局域网IP>:$PORT_WEB"
    Write-Host "  状态：$STATE_FILE ；日志：$LOG_DIR"
    Write-Host "  卸载：tianji-windows-setup.ps1 -Uninstall（默认保留数据；-PurgeData 才清数据）"
}

# ---------------------------------------------------------------------------
# -RefreshPortProxy 独立模式
# ---------------------------------------------------------------------------
if ($RefreshPortProxy) {
    Invoke-RefreshPortProxy | Out-Null
    exit 0
}

# ---------------------------------------------------------------------------
# -Uninstall（默认保留数据；-PurgeData 才清）
# ---------------------------------------------------------------------------
if ($Uninstall) {
    Assert-Admin
    Write-Host '==== 卸载 TianjiArchive（Windows 变体）===='
    if ($PurgeData) {
        Write-Host ''
        Write-Host '*** -PurgeData：将删除 WSL 发行版与 C:\tianji —— 全部档案数据不可恢复！***'
        $ans = Read-Host '确认删除请输入 YES'
        if ($ans -ne 'YES') { Write-Host '已取消。'; exit 0 }
    }
    if (Get-ScheduledTask -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TASK_NAME -Confirm:$false
        Write-Log 'OK' "已删除计划任务 $TASK_NAME"
    }
    foreach ($port in @($PORT_WEB, $PORT_S3)) {
        & netsh.exe interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=$port 2>$null | Out-Null
    }
    Write-Log 'OK' '已删除 portproxy'
    foreach ($name in @($FW_WEB_NAME, $FW_S3_NAME)) {
        if (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -DisplayName $name
            Write-Log 'OK' "已删除防火墙规则 $name"
        }
    }
    if ($PurgeData) {
        Invoke-Wsl --unregister $DISTRO_NAME 2>$null | Out-Null
        Write-Log 'OK' "已注销 WSL 发行版 $DISTRO_NAME（含全部档案数据）"
        if (Test-Path $SetupDir) { Remove-Item $SetupDir -Recurse -Force }
        Write-Log 'OK' "已删除 $SetupDir"
    } else {
        Write-Log 'OK' "WSL 发行版 $DISTRO_NAME 已保留（数据在 $SetupDir\wsl\ext4.vhdx）。连数据一起删：加 -PurgeData 重跑。"
    }
    Write-Host '卸载完成。'
    exit 0
}

# ---------------------------------------------------------------------------
# 主流程：S0 → S7（断点重入：已 DONE 的阶段自动跳过）
# ---------------------------------------------------------------------------
Assert-Admin
Invoke-Stage0

if ($PreflightOnly) {
    Invoke-Stage1
    Write-Host ''
    Write-Host 'PreflightOnly：预检通过，未做任何安装动作。'
    exit 0
}

$state = Read-State
$steps = @{}
if ($state -and $state.steps) {
    $state.steps.PSObject.Properties | ForEach-Object { $steps[$_.Name] = $_.Value }
}
$prevStage = '(新装)'
if ($state -and $state.stage) { $prevStage = $state.stage }
Write-Log 'INFO' "断点续装检查：已有状态 stage=$prevStage"

if ($steps['S2'] -ne 'DONE') { Invoke-Stage2 $steps }
if ($steps['S3'] -ne 'DONE') { Invoke-Stage3 $steps }
if ($steps['S4'] -ne 'DONE') { Invoke-Stage4 $steps }
if ($steps['S5'] -ne 'DONE') { Invoke-Stage5 $steps }
if ($steps['S6'] -ne 'DONE') { Invoke-Stage6 $steps }
if ($steps['S7'] -ne 'DONE') { Invoke-Stage7 $steps }

exit 0
