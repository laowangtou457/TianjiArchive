<#
.SYNOPSIS
    天玑档案管理系统 · 客户端一键配置与连通性自检（client-lite 阶段一）。

.DESCRIPTION
    一个脚本两种用法：

    -Configure   交互式配置向导：问服务器地址 -> 写同目录 config.json ->
                 在桌面创建 .url 快捷方式 -> 接着做三项连通性自检。
                 这是「配置天玑客户端.bat」双击后走的路径。

    不带 -Configure  只做三项自检（随时复查用）。

    三项自检判据与构建机上的 offline/smoke.sh 保持同一口径，不另立标准：

      1. 网站服务   GET http://<server>:<webPort>/healthz     -> HTTP 200 且正文为 ok
      2. 后端接口   GET http://<server>:<webPort>/api/health  -> JSON status="ok"
                    且 deps 中 objectStorage.ok=true
                    （对应 smoke.sh 第 15、16 行两道判据，缺一即失败）
      3. 对象存储   <server>:<s3Port> 的 TCP 直连可达

    第 3 项是本项目特有的关键判据：交付栈只发布 8333 供浏览器做预签名直传，
    8080 通而 8333 不通的典型症状是「能登录、能检索、一上传就失败」，现场
    极易误判为后端 bug，因此前置暴露。

    全部通过输出 "IS_PASS: YES" 并以退出码 0 结束；任一项失败输出
    "IS_PASS: NO" 并以退出码 2 结束（不静默、不降级、不靠猜）。
    配置写入失败退出码 1。

.PARAMETER Configure
    进入交互式配置向导。

.PARAMETER ServerAddr
    服务器 IP。缺省读同目录 config.json 的 serverAddr，再缺省用 192.168.20.51。

.PARAMETER WebPort
    网页端口。0 表示读 config.json（缺省 8080）。

.PARAMETER S3Port
    对象存储直连端口。0 表示读 config.json（缺省 8333）。

.PARAMETER TimeoutSec
    单次 HTTP 探测超时秒数，缺省 8。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\自检.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\自检.ps1 -ServerAddr 127.0.0.1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\自检.ps1 -Configure

.NOTES
    编码必须是 UTF-8 with BOM：Windows PowerShell 5.1 在无 BOM 时会按系统代码页
    （简体中文为 GBK）解析脚本，中文字符串会变成乱码。

    本文件同时也是全部中文界面的唯一载体：批处理启动器保持纯 ASCII，因为
    cmd.exe 解析含 UTF-8 多字节字符的 .bat 时会错算行偏移，中文会被当成命令
    执行（有无 BOM 都一样，已在 Windows 11 上复现）。把中文放进 .ps1 后
    PowerShell 按 BOM 正确解析，任何控制台代码页下输出都不乱码。

    只依赖 Windows 自带组件，不联网、不装任何模块。
#>
[CmdletBinding()]
param(
    [switch] $Configure,
    [string] $ServerAddr = '',
    [int]    $WebPort    = 0,
    [int]    $S3Port     = 0,
    [int]    $TimeoutSec = 8
)

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$script:DefaultServer = '192.168.20.51'
$script:ClientAlias = '天玑档案管理系统'
$script:FailCount = 0

# ============================================================================
# 输出辅助
# ============================================================================

function Write-Section {
    param([Parameter(Mandatory)][string] $Text)
    Write-Host ''
    Write-Host ('=' * 60) -ForegroundColor DarkGray
    Write-Host ('  ' + $Text) -ForegroundColor White
    Write-Host ('=' * 60) -ForegroundColor DarkGray
}

function Write-Kv {
    param(
        [Parameter(Mandatory)][string] $Key,
        [string] $Value = '',
        [int] $Width = 11
    )
    # 按显示宽度对齐：CJK 字符占两列，否则中英混排的冒号会参差不齐。
    $display = 0
    foreach ($ch in $Key.ToCharArray()) {
        if ([int] $ch -ge 0x1100) { $display += 2 } else { $display += 1 }
    }
    $pad = ''
    for ($i = $display; $i -lt $Width; $i++) { $pad += ' ' }
    Write-Host ('  ' + $Key + $pad + ': ' + $Value) -ForegroundColor DarkGray
}

function Write-ItemResult {
    param(
        [Parameter(Mandatory)][ValidateSet('PASS', 'FAIL')][string] $State,
        [Parameter(Mandatory)][string] $Title,
        [Parameter(Mandatory)][string] $Detail
    )
    $color = 'Green'
    if ($State -eq 'FAIL') { $color = 'Red' }
    Write-Host ('  [{0}] {1}' -f $State, $Title) -ForegroundColor $color -NoNewline
    Write-Host ('  ' + $Detail) -ForegroundColor Gray
}

function Write-Hint {
    param([Parameter(Mandatory)][string] $Text)
    Write-Host ('        -> ' + $Text) -ForegroundColor Yellow
}

# ============================================================================
# 探测原语
# ============================================================================

<#
    发起一次 HTTP GET，返回结构化结果，不抛异常。
    只用 Invoke-WebRequest -UseBasicParsing，避免依赖 IE 引擎。
#>
function Invoke-HttpProbe {
    param(
        [Parameter(Mandatory)][string] $Uri,
        [int] $Timeout = 8
    )

    $result = [pscustomobject]@{
        Ok         = $false
        StatusCode = 0
        Body       = ''
        Error      = ''
        ElapsedMs  = 0
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $resp = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $Timeout -ErrorAction Stop
        $result.StatusCode = [int] $resp.StatusCode
        # Windows PowerShell 5.1 对 Content-Type 首值非文本的响应会把 .Content 给成
        # byte[]（例如 /healthz 同时带 octet-stream 与 text/plain），必须显式解码，
        # 否则 [string] 会得到 "111 107" 这种十进制字节串。
        $raw = $resp.Content
        if ($raw -is [byte[]]) { $raw = [System.Text.Encoding]::UTF8.GetString($raw) }
        $result.Body = [string] $raw
        $result.Ok = ($result.StatusCode -eq 200)
    }
    catch {
        $result.Error = $_.Exception.Message
        if ($null -ne $_.Exception.Response) {
            try { $result.StatusCode = [int] $_.Exception.Response.StatusCode } catch { }
        }
    }
    finally {
        $sw.Stop()
        $result.ElapsedMs = [int] $sw.ElapsedMilliseconds
    }

    return $result
}

<#
    把 .NET 的 socket 异常翻译成现场看得懂的中文。
    原始异常文本像「使用"1"个参数调用"EndConnect"时发生异常」，对档案员没有意义。
#>
function ConvertTo-TcpErrorText {
    param(
        [string] $Message,
        [int]    $Port
    )
    if (-not $Message) { return '连接失败，原因未知' }
    if ($Message -match '积极拒绝|actively refused|refused') {
        return ('连接被拒绝，端口 {0} 上没有服务在监听，或被防火墙直接拒绝' -f $Port)
    }
    if ($Message -match '超时|timed out|timeout') {
        return '连接超时，通常是防火墙丢包或服务器不可达'
    }
    if ($Message -match '无法解析|resolve|known host') {
        return '主机名无法解析，请改填 IP 地址'
    }
    return ('连接失败：' + $Message)
}

<#
    TCP 端口可达性。主判据用 Test-NetConnection（与设计文档口径一致），
    失败后再用原始 socket 复核一次，避免 Test-NetConnection 自身抖动造成假红。
#>
function Test-TcpPort {
    param(
        [Parameter(Mandatory)][string] $ComputerName,
        [Parameter(Mandatory)][int]    $Port,
        [int] $TimeoutMs = 4000
    )

    $result = [pscustomobject]@{
        Ok        = $false
        ElapsedMs = 0
        Error     = ''
    }

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $result.Ok = [bool] (Test-NetConnection -ComputerName $ComputerName -Port $Port `
                -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction Stop)
    }
    catch {
        $result.Error = $_.Exception.Message
    }

    if (-not $result.Ok) {
        $client = New-Object System.Net.Sockets.TcpClient
        try {
            $async = $client.BeginConnect($ComputerName, $Port, $null, $null)
            if ($async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
                $client.EndConnect($async)
                $result.Ok = $true
                $result.Error = ''
            }
            elseif (-not $result.Error) {
                $result.Error = ('连接超时，超过 {0} 毫秒' -f $TimeoutMs)
            }
        }
        catch {
            if (-not $result.Error) { $result.Error = $_.Exception.Message }
        }
        finally {
            try { $client.Close() } catch { }
        }
    }

    $sw.Stop()
    $result.ElapsedMs = [int] $sw.ElapsedMilliseconds
    return $result
}

# ============================================================================
# 配置读写
# ============================================================================

<#
    读 config.json。文件不存在或解析失败时返回 $null，由调用方决定降级策略。
#>
function Read-ClientConfig {
    param([Parameter(Mandatory)][string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return ((Get-Content -LiteralPath $Path -Raw -Encoding UTF8) | ConvertFrom-Json)
    }
    catch {
        return $null
    }
}

<#
    写 config.json。

    字段顺序固定为「地址 -> 端口 -> 派生地址 -> 别名 -> 状态」，便于现场用记事本
    直接改；文件里出现的其他未知字段原样保留（前向兼容）。输出 UTF-8 无 BOM，
    避免记事本与新版本工具读出头字节垃圾。
#>
function Save-ClientConfig {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)] $Values,
        [string] $Alias = ''
    )

    $existing = Read-ClientConfig -Path $Path

    $ordered = [ordered]@{}
    foreach ($key in @('serverAddr', 'webPort', 's3Port', 'scheme', 'baseUrl', 's3Endpoint')) {
        if ($Values.Contains($key)) { $ordered[$key] = $Values[$key] }
    }

    $aliasValue = ''
    if ($existing -and $existing.PSObject.Properties['alias'] -and $existing.alias) {
        $aliasValue = [string] $existing.alias
    }
    elseif ($Alias) {
        $aliasValue = $Alias
    }
    $ordered['alias'] = $aliasValue

    foreach ($key in @('configured', 'updatedAtUtc')) {
        if ($Values.Contains($key)) { $ordered[$key] = $Values[$key] }
    }

    if ($existing) {
        foreach ($prop in $existing.PSObject.Properties) {
            if (-not $ordered.Contains($prop.Name)) { $ordered[$prop.Name] = $prop.Value }
        }
    }

    $json = $ordered | ConvertTo-Json -Depth 5
    # PowerShell 5.1 的 ConvertTo-Json 会在冒号后输出两个空格（"key":  "value"），
    # 现场要用记事本手改这个文件，这里规范化成单空格。
    $json = [regex]::Replace($json, '(?m)^(\s*"[^"]+":)\s+', '$1 ')
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8)
}

<#
    解析用户输入的服务器地址，容忍误粘贴的协议前缀、末尾斜杠与端口。
    返回 Ok/Address/Scheme，不合法时 Ok=$false（不抛异常）。
#>
function ConvertTo-ServerAddress {
    param([string] $Raw)

    $value = ([string] $Raw).Trim()
    $scheme = 'http'
    if ($value -match '^(?i)https://') { $scheme = 'https'; $value = $value.Substring(8) }
    elseif ($value -match '^(?i)http://') { $value = $value.Substring(7) }
    $value = $value.TrimEnd('/')
    if ($value -match '^([^:]+):\d+$') { $value = $Matches[1] }

    if ($value -notmatch '^[0-9A-Za-z][0-9A-Za-z.-]*$') {
        return [pscustomobject]@{ Ok = $false; Address = ''; Scheme = $scheme }
    }
    return [pscustomobject]@{ Ok = $true; Address = $value; Scheme = $scheme }
}

<#
    取桌面目录。桌面可能被 OneDrive 重定向，GetFolderPath 已处理大多数情况，
    这里再补两层兜底。
#>
function Get-DesktopPath {
    $path = [Environment]::GetFolderPath('Desktop')
    if (-not $path -or -not (Test-Path -LiteralPath $path)) {
        $path = Join-Path $env:USERPROFILE 'Desktop'
    }
    if (-not (Test-Path -LiteralPath $path)) {
        $path = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
    }
    return $path
}

<#
    创建 .url 快捷方式（标准 Internet Shortcut，双击用默认浏览器打开）。
    桌面不可写时退化到安装目录。返回 Path 与 Target，Target 取 desktop/local/none。
#>
function Set-ClientShortcut {
    param(
        [Parameter(Mandatory)][string] $Directory,
        [Parameter(Mandatory)][string] $BaseUrl,
        [string] $Name = '天玑档案管理系统'
    )

    $enc = New-Object System.Text.ASCIIEncoding
    $lines = @('[InternetShortcut]', ('URL=' + $BaseUrl), 'IconIndex=0')

    $target = 'none'
    $path = ''
    $desktop = Get-DesktopPath
    if (Test-Path -LiteralPath $desktop) {
        try {
            $path = Join-Path $desktop ($Name + '.url')
            [System.IO.File]::WriteAllLines($path, $lines, $enc)
            $target = 'desktop'
        }
        catch {
            $path = ''
            $target = 'none'
        }
    }
    if (-not $path) {
        try {
            $path = Join-Path $Directory ($Name + '.url')
            [System.IO.File]::WriteAllLines($path, $lines, $enc)
            $target = 'local'
        }
        catch {
            $path = ''
            $target = 'none'
        }
    }
    return [pscustomobject]@{ Path = $path; Target = $target }
}

# ============================================================================
# 配置向导
# ============================================================================

<#
    交互式向导：问地址 -> 写 config.json -> 建快捷方式。
    成功返回解析后的地址对象；用户放弃或写入失败返回 $null。
#>
function Invoke-ConfigureWizard {
    param(
        [Parameter(Mandatory)][string] $Directory,
        [Parameter(Mandatory)][string] $ConfigPath
    )

    Write-Section '天玑档案管理系统 · 客户端配置'

    $existing = Read-ClientConfig -Path $ConfigPath
    $webPort = 8080
    $s3Port = 8333
    $current = ''
    if ($existing) {
        if ($existing.webPort) { $webPort = [int] $existing.webPort }
        if ($existing.s3Port) { $s3Port = [int] $existing.s3Port }
        if ($existing.serverAddr) { $current = [string] $existing.serverAddr }
    }

    $defaultAddr = $script:DefaultServer
    if ($current) { $defaultAddr = $current }

    Write-Host ''
    Write-Host '  本向导只做三件事：写配置、建桌面快捷方式、接着跑自检。'
    Write-Host '  全程离线，不会安装或下载任何东西。'
    Write-Host ''
    if ($current) {
        Write-Host ('  当前配置的服务器地址：' + $current)
    }
    else {
        Write-Host '  尚未配置过服务器地址，将使用默认值。'
    }
    Write-Host ('  网页端口：{0}      对象存储直连端口：{1}' -f $webPort, $s3Port)
    Write-Host ''
    Write-Host '  请输入服务器 IP 地址，只填 IP，不要带 http:// 或端口。'
    Write-Host ('  直接按回车则使用默认值：' + $defaultAddr)
    Write-Host ''

    $resolved = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        $answer = Read-Host ('服务器地址 [默认 ' + $defaultAddr + ']')
        if (-not $answer) { $answer = $defaultAddr }
        $parsed = ConvertTo-ServerAddress -Raw $answer
        if ($parsed.Ok) {
            $resolved = $parsed
            break
        }
        Write-Host ('  [FAIL] 地址不合法：' + $answer) -ForegroundColor Red
        Write-Host '         只填 IP，例如 192.168.20.51，不要带 http:// 或斜杠或端口。' -ForegroundColor Red
        Write-Host ''
    }
    if (-not $resolved) {
        Write-Host '  [FAIL] 连续 5 次输入不合法，已退出。' -ForegroundColor Red
        return $null
    }

    $baseUrl = '{0}://{1}:{2}' -f $resolved.Scheme, $resolved.Address, $webPort
    $s3Url = '{0}://{1}:{2}' -f $resolved.Scheme, $resolved.Address, $s3Port

    $values = [ordered]@{
        serverAddr   = $resolved.Address
        webPort      = $webPort
        s3Port       = $s3Port
        scheme       = $resolved.Scheme
        baseUrl      = $baseUrl
        s3Endpoint   = $s3Url
        configured   = $true
        updatedAtUtc = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    }

    Write-Host ''
    Write-Host '  正在写入配置 ...'
    try {
        Save-ClientConfig -Path $ConfigPath -Values $values -Alias $script:ClientAlias
    }
    catch {
        Write-Host ('  [FAIL] config.json 写入失败：' + $_.Exception.Message) -ForegroundColor Red
        Write-Host '         常见原因：目录只读、杀毒软件拦截、文件被其他程序占用。' -ForegroundColor Red
        Write-Host '         可把整个 tianji-client-lite 目录复制到桌面后重试。' -ForegroundColor Red
        return $null
    }
    Write-Host ('  [OK] config.json 已写入：' + $ConfigPath) -ForegroundColor Green
    Write-Host ('       服务器地址：' + $resolved.Address)
    Write-Host ('       网页访问地址：' + $baseUrl)
    Write-Host ('       对象存储地址：' + $s3Url)

    $shortcut = Set-ClientShortcut -Directory $Directory -BaseUrl $baseUrl -Name $script:ClientAlias
    Write-Host ''
    switch ($shortcut.Target) {
        'desktop' {
            Write-Host ('  [OK] 桌面快捷方式已创建：' + $script:ClientAlias + '.url') -ForegroundColor Green
        }
        'local' {
            Write-Host ('  [WARN] 桌面不可写，已在安装目录创建快捷方式：' + $script:ClientAlias + '.url') -ForegroundColor Yellow
        }
        default {
            Write-Host ('  [WARN] 快捷方式创建失败，可直接在浏览器访问 ' + $baseUrl) -ForegroundColor Yellow
        }
    }
    Write-Host ''
    return $resolved
}

# ============================================================================
# 主流程
# ============================================================================

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $scriptDir) { $scriptDir = (Get-Location).Path }
$configPath = Join-Path $scriptDir 'config.json'

if ($Configure) {
    $wizardResult = Invoke-ConfigureWizard -Directory $scriptDir -ConfigPath $configPath
    if (-not $wizardResult) { exit 1 }
    Write-Host '  接下来做三项连通性自检。' -ForegroundColor Gray
}

# ---------------------------------------------------------------- 读取配置
$config = Read-ClientConfig -Path $configPath
$configState = '未找到 config.json，使用内置默认值'
if ($config) { $configState = '已读取 config.json' }
elseif (Test-Path -LiteralPath $configPath) { $configState = 'config.json 解析失败，使用内置默认值' }

$scheme = 'http'
if ($config -and $config.scheme) { $scheme = [string] $config.scheme }

if (-not $ServerAddr) {
    if ($config -and $config.serverAddr) { $ServerAddr = [string] $config.serverAddr }
    else { $ServerAddr = $script:DefaultServer }
}

# 容错：即使用户把完整 URL 写进 config.json 也能跑
$normalized = ConvertTo-ServerAddress -Raw $ServerAddr
if ($normalized.Ok) {
    $ServerAddr = $normalized.Address
    if (-not ($config -and $config.scheme)) { $scheme = $normalized.Scheme }
}

if ($WebPort -le 0) {
    if ($config -and $config.webPort) { $WebPort = [int] $config.webPort } else { $WebPort = 8080 }
}
if ($S3Port -le 0) {
    if ($config -and $config.s3Port) { $S3Port = [int] $config.s3Port } else { $S3Port = 8333 }
}

$webUri = '{0}://{1}:{2}/healthz' -f $scheme, $ServerAddr, $WebPort
$apiUri = '{0}://{1}:{2}/api/health' -f $scheme, $ServerAddr, $WebPort
$baseUri = '{0}://{1}:{2}' -f $scheme, $ServerAddr, $WebPort

# ---------------------------------------------------------------- 环境信息
Write-Section '天玑档案管理系统 · 客户端连通性自检'

$osCaption = [string] [Environment]::OSVersion.VersionString
$osVersion = ''
try {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
    $osCaption = ([string] $os.Caption).Trim()
    $osVersion = [string] $os.Version
}
catch {
    $osCaption = [string] [Environment]::OSVersion.VersionString
}

Write-Kv '时间' ('{0:yyyy-MM-dd HH:mm:ss zzz}' -f (Get-Date))
Write-Kv '计算机' ([string] $env:COMPUTERNAME)
Write-Kv '账号' ([string] $env:USERNAME)
Write-Kv '系统' ('{0} {1}' -f $osCaption, $osVersion)
Write-Kv 'PowerShell' ($PSVersionTable.PSVersion.ToString())
Write-Kv '脚本目录' $scriptDir
Write-Kv '配置文件' ('{0}  [{1}]' -f $configPath, $configState)
Write-Kv '目标服务器' ('{0}    网页端口 {1}    对象存储端口 {2}' -f $ServerAddr, $WebPort, $S3Port)

# ---------------------------------------------------------------- 第 1 项：网站服务
Write-Host ''
Write-Host '[1/3] 网站服务（nginx 反代 + SPA 静态页）' -ForegroundColor Cyan
Write-Host ('      GET ' + $webUri) -ForegroundColor DarkGray

$webProbe = Invoke-HttpProbe -Uri $webUri -Timeout $TimeoutSec
$webOk = $false
if ($webProbe.StatusCode -eq 200) {
    $body = $webProbe.Body.Trim()
    if ($body -eq 'ok') {
        $webOk = $true
        Write-ItemResult -State 'PASS' -Title '网站服务可达' -Detail ('HTTP 200 正文 ok，耗时 {0} ms' -f $webProbe.ElapsedMs)
    }
    else {
        Write-ItemResult -State 'FAIL' -Title '网站服务异常' -Detail ('HTTP 200 但 /healthz 正文不是 ok，耗时 {0} ms' -f $webProbe.ElapsedMs)
        Write-Hint '站点能开但健康端点内容不符合预期，通常是 web 镜像版本过旧，需在服务器重新 load 镜像。'
    }
}
elseif ($webProbe.StatusCode -gt 0) {
    Write-ItemResult -State 'FAIL' -Title '网站服务异常' -Detail ('HTTP {0}，耗时 {1} ms' -f $webProbe.StatusCode, $webProbe.ElapsedMs)
    Write-Hint '请确认服务器上 docker compose ps 中 tianji-web 状态为 healthy。'
}
else {
    Write-ItemResult -State 'FAIL' -Title '网站服务不可达' -Detail ('{0}，耗时 {1} ms' -f $webProbe.Error, $webProbe.ElapsedMs)
    Write-Hint '先确认 IP 是否写对，再确认服务器 docker compose ps 中 tianji-web 为 healthy。'
}
if (-not $webOk) { $script:FailCount++ }

# ---------------------------------------------------------------- 第 2 项：后端接口
Write-Host ''
Write-Host '[2/3] 后端接口（/api/health）' -ForegroundColor Cyan
Write-Host ('      GET ' + $apiUri) -ForegroundColor DarkGray

$apiProbe = Invoke-HttpProbe -Uri $apiUri -Timeout $TimeoutSec
$apiOk = $false
$apiJson = $null
if ($apiProbe.StatusCode -eq 200 -and $apiProbe.Body) {
    try { $apiJson = $apiProbe.Body | ConvertFrom-Json } catch { $apiJson = $null }
}

if ($apiProbe.StatusCode -ne 200) {
    Write-ItemResult -State 'FAIL' -Title '后端不可达' -Detail ('{0}，耗时 {1} ms' -f $apiProbe.Error, $apiProbe.ElapsedMs)
    Write-Hint '确认服务器 docker compose ps 中 tianji-api 为 healthy，再看 docker compose logs api 末尾 100 行。'
}
elseif ($null -eq $apiJson) {
    Write-ItemResult -State 'FAIL' -Title '后端返回内容不是 JSON' -Detail ('HTTP 200，耗时 {0} ms' -f $apiProbe.ElapsedMs)
    Write-Hint '可能是 nginx 把 /api 反代到了错误上游，检查 tianji-web 的反代配置。'
}
else {
    # 后端挂了全局响应拦截器，实际形状是 { code, data:{ status, version, deps }, message, timestamp }。
    # 这里兼容「有包装」与「无包装」两种形状，避免接口演进导致本自检假红。
    $payload = $apiJson
    if ($apiJson.PSObject.Properties['data'] -and $null -ne $apiJson.data) { $payload = $apiJson.data }

    $status = [string] $payload.status
    Write-Kv 'status' $status
    Write-Kv 'version' ([string] $payload.version)
    if ($apiJson.PSObject.Properties['code']) { Write-Kv '响应码' ([string] $apiJson.code) }

    $storageOk = $null
    if ($payload.deps) {
        foreach ($dep in $payload.deps) {
            $flag = 'ok'
            $color = 'Green'
            if (-not $dep.ok) { $flag = 'FAIL'; $color = 'Red' }
            Write-Host ('        - {0,-16} {1,-5} {2} ms' -f [string] $dep.name, $flag, $dep.latencyMs) -ForegroundColor $color
            if ([string] $dep.name -eq 'objectStorage') { $storageOk = [bool] $dep.ok }
        }
    }

    if ($status -eq 'ok' -and $storageOk -eq $true) {
        $apiOk = $true
        Write-ItemResult -State 'PASS' -Title '后端健康' -Detail ('status=ok，objectStorage.ok=true，耗时 {0} ms' -f $apiProbe.ElapsedMs)
    }
    elseif ($status -eq 'ok' -and $storageOk -ne $true) {
        Write-ItemResult -State 'FAIL' -Title '后端健康但附件存储未就绪' -Detail ('status=ok，objectStorage.ok=false，耗时 {0} ms' -f $apiProbe.ElapsedMs)
        Write-Hint '上传一定会失败。确认 tianji-seaweedfs 为 healthy、8333 已放通，再重跑本自检。'
    }
    else {
        Write-ItemResult -State 'FAIL' -Title '后端未就绪' -Detail ('status={0}，耗时 {1} ms' -f $status, $apiProbe.ElapsedMs)
        Write-Hint 'status 不是 ok 表示至少一个依赖不健康，看上面标 FAIL 的那几行。'
        if ($storageOk -eq $false) {
            Write-Hint '其中 objectStorage 未就绪意味着上传一定会失败：先查 tianji-seaweedfs 与 8333 端口。'
        }
    }
}
if (-not $apiOk) { $script:FailCount++ }

# ---------------------------------------------------------------- 第 3 项：对象存储直连
Write-Host ''
Write-Host '[3/3] 对象存储直连（浏览器分片直传用）' -ForegroundColor Cyan
Write-Host ('      TCP ' + $ServerAddr + ':' + $S3Port) -ForegroundColor DarkGray

$tcpProbe = Test-TcpPort -ComputerName $ServerAddr -Port $S3Port
$s3Ok = [bool] $tcpProbe.Ok
if ($s3Ok) {
    Write-ItemResult -State 'PASS' -Title ('端口 {0} 可达' -f $S3Port) -Detail ('耗时 {0} ms' -f $tcpProbe.ElapsedMs)
}
else {
    $tcpText = ConvertTo-TcpErrorText -Message $tcpProbe.Error -Port $S3Port
    Write-ItemResult -State 'FAIL' -Title ('端口 {0} 不可达' -f $S3Port) -Detail ('{0}，耗时 {1} ms' -f $tcpText, $tcpProbe.ElapsedMs)
    Write-Hint ('分片上传会失败：症状是能登录、能检索、一上传就报错。请让运维确认服务器防火墙已放通 TCP {0}，' -f $S3Port)
    Write-Hint '并确认 docker compose ps 中 tianji-seaweedfs 为 healthy。'
    $script:FailCount++
}

# ---------------------------------------------------------------- 汇总
Write-Host ''
Write-Host ('-' * 60) -ForegroundColor DarkGray

$totalCount = 3
$passCount = $totalCount - $script:FailCount
Write-Host ('  结果：{0} 项中 {1} 项通过，{2} 项失败' -f $totalCount, $passCount, $script:FailCount) -ForegroundColor Gray

if ($script:FailCount -eq 0) {
    Write-Host '  IS_PASS: YES' -ForegroundColor Green
    Write-Host ''
    Write-Host ('  可以在浏览器打开：' + $baseUri) -ForegroundColor Gray
    if ($Configure) {
        Write-Host ('  或双击桌面上的「' + $script:ClientAlias + '」快捷方式。') -ForegroundColor Gray
        Write-Host '  换服务器地址：重新双击本目录的「配置天玑客户端.bat」即可。' -ForegroundColor DarkGray
    }
    Write-Host '  报障时请把本窗口内容整段复制给运维。' -ForegroundColor DarkGray
    Write-Host ('-' * 60) -ForegroundColor DarkGray
    exit 0
}

Write-Host '  IS_PASS: NO' -ForegroundColor Red
Write-Host ''
Write-Host '  按失败项排查：' -ForegroundColor Yellow
if (-not $webOk) {
    Write-Host ('    - 第 1 项：先确认 IP 是否写对（当前 {0}），再确认服务端网站服务已启动。' -f $ServerAddr) -ForegroundColor Yellow
}
if (-not $apiOk) {
    Write-Host '    - 第 2 项：网站通而接口不通时，看服务端 docker compose logs api --tail=100。' -ForegroundColor Yellow
}
if (-not $s3Ok) {
    Write-Host ('    - 第 3 项：登录检索正常但上传失败，是端口或防火墙问题，不是后端 bug（TCP {0}）。' -f $S3Port) -ForegroundColor Yellow
}
Write-Host '  报障时请把本窗口内容整段复制给运维，含上方 deps 明细。' -ForegroundColor DarkGray
Write-Host ('-' * 60) -ForegroundColor DarkGray
exit 2
