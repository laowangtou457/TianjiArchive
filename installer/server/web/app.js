/* 天玑档案管理系统 · 服务器端安装向导前端
 *
 * 设计约束（对应 docs/安装器总体设计.md）：
 *  - 不引用任何外部资源（现场无公网，CDN 会白屏）；
 *  - 六步页面与十步状态机一一对应，前端不自己发明顺序，一切以 /api/status
 *    返回的 steps[].status 为准（这样 --resume、TUI 与 Web 三个入口永远一致）；
 *  - 每步执行期间以 1 秒间隔轮询该步日志文件，实现「实时滚动」。
 */
(function () {
  'use strict';

  var TOKEN = new URLSearchParams(location.search).get('t') || '';

  /* 与 Go 侧 stepLogFile 严格对应的日志文件名 */
  var STEP_LOG = {
    S1_PREFLIGHT: '01-preflight.log',
    S2_VERIFY: '02-verify.log',
    S3_DOCKER: '03-docker-install.log',
    S4_IMAGES: '04-images-load.log',
    S5_ENV: '05-env.log',
    S6_UP: '06-up.log',
    S7_MIGRATE: '07-migrate.log',
    S8_SEED: '08-seed.log',
    S9_SMOKE: '09-smoke.log',
    S10_DONE: '99-summary.txt'
  };

  /* 每步的说明与按钮文案 */
  var STEP_META = {
    S1_PREFLIGHT: {
      desc: '逐条实测 K1~K13：内核/架构/overlay2/cgroup/vm.max_map_count/memlock/nofile/iptables/磁盘/内存/dpkg 锁/已有 Docker/SELinux。任一 FAIL 即阻断，并给出「为什么必须修 + 怎么修」。',
      action: '开始环境体检'
    },
    S2_VERIFY: {
      desc: '按 manifest.json 逐文件复核 sha256，并校验镜像 tar 与构建机记录同源。任何不匹配都视为包被篡改或传输损坏，硬停，不提供「跳过」。',
      action: '校验安装包完整性'
    },
    S3_DOCKER: {
      desc: '变体 A 用 dpkg 装离线 deb 闭包（不调用 apt，全程不出网）；变体 B 解 static 包并自写 systemd unit。随后写入 sysctl/limits 并回读确认，最后校验 docker compose ≥ 2.20。',
      action: '安装 Docker Engine'
    },
    S4_IMAGES: {
      desc: '先校验 tar 的 sha256，再 docker load，最后按 images.txt 逐个 inspect（8/8）。少一个镜像就停——「少两个也起栈」会让失败延后到用户第一次上传文件时才暴露。',
      action: '导入离线镜像'
    },
    S5_ENV: {
      desc: '渲染 /opt/tianji/.env 并准备部署根（compose 文件、SeaweedFS 入口、volumes 目录）。已存在 .env 时拒绝静默覆盖。',
      action: '写入部署配置'
    },
    S6_UP: {
      desc: 'docker compose up -d 后轮询 compose ps，直到所有服务 running 且 healthcheck 通过。',
      action: '启动服务栈'
    },
    S7_MIGRATE: { desc: '在 api 容器内执行数据库迁移（幂等，可重跑）。', action: '执行数据库迁移' },
    S8_SEED: { desc: '在 api 容器内执行种子数据（幂等，可重跑）。', action: '初始化种子数据' },
    S9_SMOKE: {
      desc: '四项逐一真跑：/api/health 且 objectStorage.ok、S3 九项探针、样品书籍全链路、IK 中文分词。判据与 offline/smoke.sh 完全一致。',
      action: '执行四项冒烟'
    },
    S10_DONE: { desc: '写入 99-summary.txt 汇总（每步状态与耗时）。', action: '生成安装汇总' }
  };

  var snap = null;
  var view = 'overview';
  var busy = false;
  var statusTimer = null;
  var logTimer = null;
  var clockTimer = null;
  var flash = null;

  var panel = document.getElementById('panel');
  var steplistEl = document.getElementById('steplist');
  var metaEl = document.getElementById('meta');
  var osbadgeEl = document.getElementById('osbadge');
  var elapsedEl = document.getElementById('elapsed');

  /* ------------------------------------------------------------------ 工具 */

  function apiUrl(path) {
    if (!TOKEN) return path;
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(TOKEN);
  }

  function api(path, body) {
    var opts = { method: body === undefined ? 'GET' : 'POST', headers: {} };
    if (TOKEN) opts.headers['X-Tianji-Token'] = TOKEN;
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(apiUrl(path), opts).then(function (res) {
      return res.text().then(function (text) {
        var parsed;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          parsed = { ok: false, error: '响应不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200) };
        }
        return parsed;
      });
    });
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtDuration(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function statusOf(stepId) {
    if (!snap) return '';
    for (var i = 0; i < snap.steps.length; i++) {
      if (snap.steps[i].id === stepId) return snap.steps[i].status || '';
    }
    return '';
  }

  function titleOf(stepId) {
    if (!snap) return stepId;
    for (var i = 0; i < snap.steps.length; i++) {
      if (snap.steps[i].id === stepId) return snap.steps[i].title;
    }
    return stepId;
  }

  /* ------------------------------------------------------------------ 数据 */

  function refresh() {
    return api('/api/status').then(function (res) {
      if (!res.ok) {
        flash = { kind: 'fail', text: res.error || '读取状态失败' };
        render();
        throw new Error(res.error || '读取状态失败');
      }
      snap = res.data;
      render();
      return snap;
    });
  }

  function act(path, body, okText) {
    if (busy) return Promise.resolve();
    busy = true;
    flash = null;
    render();
    return api(path, body === undefined ? {} : body)
      .then(function (res) {
        busy = false;
        if (!res.ok) {
          flash = { kind: 'fail', text: res.error || '操作失败' };
          if (res.problems && res.problems.length) {
            flash.list = res.problems;
          }
          if (res.needsForm) view = 'S5_ENV';
          if (res.needsConfirm) view = 'S1_PREFLIGHT';
        } else {
          if (okText) flash = { kind: 'pass', text: okText };
        }
        return refresh().catch(function () {});
      })
      .catch(function (err) {
        busy = false;
        flash = { kind: 'fail', text: String(err) };
        render();
      });
  }

  /* ------------------------------------------------------------------ 渲染 */

  function render() {
    if (snap) {
      metaEl.textContent =
        snap.product + ' · 版本 ' + snap.version + ' · 变体 ' + snap.variant + ' · ' + snap.arch;
      var osText = snap.os && snap.os.id ? snap.os.id + ' ' + (snap.os.versionId || '') : '未识别系统';
      osbadgeEl.textContent = osText;
      elapsedEl.textContent = '已用 ' + fmtDuration(snap.elapsedMs || 0);
    }
    renderSteplist();
    renderPanel();
    syncTimers();
  }

  function renderSteplist() {
    var html = '';
    html += stepItemHtml('overview', '总览', '', snap && snap.nextStep === 'S10_DONE' ? 'done' : '', 0);
    if (snap) {
      snap.steps.forEach(function (step, idx) {
        html += stepItemHtml(step.id, step.title, step.status, stepClass(step.status), idx + 1);
      });
    }
    steplistEl.innerHTML = html;
  }

  function stepItemHtml(id, title, status, cls, idx) {
    var active = view === id ? ' active' : '';
    var label = status === 'DONE' ? '✓' : status === 'FAIL' ? '!' : idx === 0 ? '•' : String(idx);
    return (
      '<button class="stepitem ' + cls + active + '" data-action="view" data-id="' + esc(id) + '">' +
      '<span class="idx">' + esc(label) + '</span>' +
      '<span class="name">' + esc(title) + '</span>' +
      '</button>'
    );
  }

  function stepClass(status) {
    if (status === 'DONE') return 'done';
    if (status === 'FAIL') return 'fail';
    return '';
  }

  function renderPanel() {
    if (!snap) {
      panel.innerHTML = '<div class="placeholder">正在加载安装包信息…</div>';
      return;
    }
    var html = '';
    if (flash) {
      html += '<div class="banner ' + flash.kind + '">' + esc(flash.text);
      if (flash.list && flash.list.length) {
        html += '<ul>' + flash.list.map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') + '</ul>';
      }
      html += '</div>';
    }
    if (view === 'overview') {
      html += renderOverview();
    } else {
      html += renderStep(view);
    }
    panel.innerHTML = html;
    bindForm();
    scrollLogToBottom();
  }

  /* --------------------------------------------------------------- 总览页 */

  function renderOverview() {
    var h = '';
    h += '<h2>安装总览</h2>';
    h += '<p class="lead">这台服务器将安装：' + esc(snap.product) + ' ' + esc(snap.version) +
      '（变体 ' + esc(snap.variant) + '）。全程离线，不访问公网。</p>';

    h += renderOSMatch();

    h += '<h3>安装包</h3><div class="grid2">';
    h += kv('payload 目录', snap.rootDir);
    h += kv('部署根', snap.deployRoot);
    h += kv('状态文件', snap.stateFile);
    h += kv('日志目录', snap.logDir);
    var buildInfo = (snap.build && snap.build.build) || {};
    h += kv('构建提交', buildInfo.git_head || '未记录');
    h += kv('构建时间', buildInfo.built_at_utc || '未记录');
    h += '</div>';

    h += '<h3>镜像包（与安装包同目录分发）</h3>';
    h += '<div class="field"><input type="text" id="tarpath" value="' + esc(snap.imagesTar) + '">' +
      '<span class="help">默认放在安装器目录；若你放在了别处，在这里改成实际路径后点「保存路径」。' +
      '期望 ' + esc(snap.imageExpected) + ' 个镜像，sha256 来自 manifest.json。</span></div>';
    h += '<div class="actions">' +
      '<button class="btn gray" data-action="save-tar">保存路径</button>' +
      '</div>';

    h += '<h3>操作</h3>';
    h += '<div class="actions">';
    h += '<button class="btn" data-action="run-all"' + (busy ? ' disabled' : '') + '>一键执行剩余步骤</button>';
    h += '<button class="btn ghost" data-action="view" data-id="S1_PREFLIGHT"' + (busy ? ' disabled' : '') + '>逐步执行（推荐首次安装）</button>';
    h += '</div>';
    h += '<p class="help dim">一键执行会从当前断点一路跑到完成；中途失败会停在那一步，修好后可继续。' +
      '切换标签页不会中断安装。</p>';

    if (snap.installed) {
      h += '<div class="banner warn">检测到服务栈已在运行。重复安装会重新 up，请确认这是你想要的操作。' +
        '只想重跑校验时，单独执行「包完整性」步骤即可。</div>';
    }

    h += '<h3>卸载</h3>';
    h += '<p class="help">安装完成后如要卸载（默认保留业务数据）：<code class="mono">' + esc(snap.uninstallHint) + '</code></p>';
    return h;
  }

  function renderOSMatch() {
    var m = snap.osMatch || {};
    var os = snap.os || {};
    var head = '系统识别：' + esc(os.prettyName || os.id || '未识别') +
      '（ID=' + esc(os.id || '?') + ' VERSION_ID=' + esc(os.versionId || '?') +
      ' codename=' + esc(os.codename || '?') + '）';
    var h = '<div class="banner info">' + head + '<br>匹配结论：' + esc(m.reason || '未判定') + '</div>';
    if (m.level === 'reject') {
      h += '<div class="banner fail">本机与安装包变体不匹配，环境体检会直接阻断。' +
        '请改用 ' + esc(m.suggestedVariant || '对应变体') + ' 的安装包。</div>';
    } else if (m.level === 'unverified') {
      if (snap.confirmed) {
        h += '<div class="banner warn">未验证组合：已勾选「风险自担」，将继续安装。</div>';
      } else {
        h += '<div class="banner warn">未验证组合（' + esc(m.reason) + '）。' +
          '需要你显式确认后才会继续：</div>' +
          '<div class="actions"><button class="btn danger" data-action="confirm-os">我已确认该组合未经验证，风险自担</button></div>';
      }
    }
    return h;
  }

  function kv(k, v) {
    return '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v mono">' + esc(v || '—') + '</span></div>';
  }

  /* --------------------------------------------------------------- 步骤页 */

  function renderStep(stepId) {
    var meta = STEP_META[stepId] || { desc: '', action: '执行' };
    var status = statusOf(stepId);
    var h = '';
    h += '<h2>' + esc(titleOf(stepId)) + ' <span class="tag ' + (status === 'DONE' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP') + '">' +
      esc(status || '未开始') + '</span></h2>';
    h += '<p class="lead">' + esc(meta.desc) + '</p>';

    if (stepId === 'S5_ENV') {
      h += renderEnvForm();
    }

    if (stepId === 'S10_DONE') {
      h += renderDone();
    }

    h += '<div class="actions">';
    h += '<button class="btn" data-action="run-step" data-id="' + esc(stepId) + '"' + (busy ? ' disabled' : '') + '>' + esc(meta.action) + '</button>';
    if (status === 'DONE') {
      h += '<button class="btn gray" data-action="view" data-id="overview">返回总览</button>';
    }
    h += '</div>';
    if (busy) {
      h += '<p class="dim"><span class="spin">◐</span> 正在执行，日志实时刷新中…</p>';
    }

    h += renderStepResult(stepId);
    h += '<h3>本步日志（' + esc(STEP_LOG[stepId]) + '）</h3>';
    h += '<pre class="log" id="logbox">加载中…</pre>';
    return h;
  }

  function renderStepResult(stepId) {
    switch (stepId) {
      case 'S1_PREFLIGHT':
        return renderPreflight();
      case 'S2_VERIFY':
        return renderVerify();
      case 'S3_DOCKER':
        return renderDocker();
      case 'S4_IMAGES':
        return renderImages();
      case 'S5_ENV':
        return renderEnvResult();
      case 'S6_UP':
        return renderServices();
      case 'S9_SMOKE':
        return renderSmoke();
      default:
        return '';
    }
  }

  function renderPreflight() {
    var rep = snap.preflight;
    if (!rep) return '';
    var h = '<h3>体检结果（' + rep.items.length + ' 项）</h3>';
    h += '<table class="tbl"><thead><tr><th>编号</th><th>级别</th><th>项目</th><th>结论</th></tr></thead><tbody>';
    rep.items.forEach(function (it) {
      var hint = it.hint ? '<div class="hint">建议：' + esc(it.hint) + '</div>' : '';
      h += '<tr><td class="mono">' + esc(it.id) + '</td><td><span class="tag ' + esc(it.level) + '">' + esc(it.level) +
        '</span></td><td>' + esc(it.title) + '</td><td>' + esc(it.detail) + hint + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function renderVerify() {
    if (!snap.verify || !snap.verify.length) return '';
    var h = '<h3>载荷校验（' + snap.verify.length + ' 个文件）</h3>';
    h += '<table class="tbl"><thead><tr><th>文件</th><th>结果</th><th>实际 sha256</th></tr></thead><tbody>';
    snap.verify.forEach(function (c) {
      var detail = c.ok ? '<span class="tag PASS">匹配</span>' : '<span class="tag FAIL">不匹配</span>' + (c.err ? '<div class="dim">' + esc(c.err) + '</div>' : '');
      h += '<tr><td class="mono">' + esc(c.path) + '</td><td>' + detail + '</td><td class="mono dim">' + esc(c.actual || c.expected) + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function renderDocker() {
    if (!snap.docker) return '';
    var d = snap.docker;
    var h = '<h3>Docker 安装结果</h3><div class="grid2">';
    h += kv('安装方式', d.method === 'reuse' ? '复用已有 Docker' : d.method === 'deb' ? 'dpkg 离线 deb 闭包' : 'static 二进制');
    h += kv('dockerd 版本', d.daemonVersion);
    h += kv('compose 版本', d.composeVersion);
    if (d.debCount) h += kv('deb 包数', d.debCount + ' 个');
    h += '</div>';
    if (d.steps && d.steps.length) {
      h += '<ul>' + d.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
    }
    return h;
  }

  function renderImages() {
    var r = snap.images;
    if (!r) return '';
    var h = '<h3>镜像核对（' + (snap.imageCount || 0) + '/' + (snap.imageExpected || 0) + '）</h3>';
    h += '<div class="grid2">' + kv('tar 路径', r.tarPath) + kv('sha256', r.sha256Actual) + '</div>';
    h += '<table class="tbl"><thead><tr><th>镜像</th><th>结果</th><th>Image ID</th></tr></thead><tbody>';
    (r.checks || []).forEach(function (c) {
      var cell = c.ok ? '<span class="tag PASS">已导入</span>' : '<span class="tag FAIL">缺失</span><div class="dim">' + esc(c.err || '') + '</div>';
      h += '<tr><td class="mono">' + esc(c.name) + '</td><td>' + cell + '</td><td class="mono dim">' + esc(c.id || '') + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function renderEnvForm() {
    var v = snap.values || {};
    var required = [
      ['endpoint', '局域网地址（S3_PUBLIC_ENDPOINT）', 'text', '必填。局域网浏览器做预签名直传用的地址，例如 192.168.20.51。填 127.0.0.1 会导致「能登录、能检索、一上传就失败」。'],
      ['postgresPassword', 'PostgreSQL 密码', 'text', '至少 12 字符。数据库的超级用户密码。'],
      ['minioAccessKey', 'SeaweedFS 访问密钥', 'text', '至少 6 字符。相当于 S3 的 AccessKey。'],
      ['minioSecretKey', 'SeaweedFS 私钥', 'password', '至少 12 字符。相当于 S3 的 SecretKey。'],
      ['jwtAccessSecret', 'JWT 访问令牌密钥', 'password', '至少 32 字符。泄露等于可以伪造登录态。'],
      ['jwtRefreshSecret', 'JWT 刷新令牌密钥', 'password', '至少 32 字符，且必须与访问令牌密钥不同。'],
      ['redisPassword', 'Redis 密码', 'password', '至少 8 字符。'],
      ['corsOrigins', 'CORS 白名单（可留空自动生成）', 'text', '留空则自动设为 http://<局域网地址>:8080,http://localhost:8080']
    ];
    var h = '<h3>部署表单（8 项高敏参数）</h3>';
    h += '<div class="banner info">这些值会写入 <code class="mono">' + esc(snap.envPath) +
      '</code>（权限 0600），日志里只保留前 4 后 4 位。安装器不会替你随机生成密码——你需要在安装后拿它登录。</div>';
    h += '<form class="envform" id="envform" autocomplete="off">';
    required.forEach(function (f) {
      var key = f[0], label = f[1], type = f[2], help = f[3];
      h += '<div class="field"><label for="f_' + key + '">' + esc(label) + '</label>' +
        '<input type="' + type + '" id="f_' + key + '" name="' + key + '" value="' + esc(v[key] || '') + '" spellcheck="false">' +
        '<span class="help">' + esc(help) + '</span></div>';
    });
    h += '<div class="field check"><input type="checkbox" id="f_overwrite"' + (v.overwrite ? ' checked' : '') + '>' +
      '<label for="f_overwrite">覆盖已存在的 .env（原文件会先备份到日志目录）</label></div>';
    h += '<div class="actions"><button class="btn" type="submit"' + (busy ? ' disabled' : '') + '>保存表单</button></div>';
    h += '</form>';
    return h;
  }

  function renderEnvResult() {
    if (!snap.envWritten) return '';
    return '<div class="banner pass">.env 已写入 <code class="mono">' + esc(snap.envPath) + '</code></div>';
  }

  function renderServices() {
    var list = snap.services || [];
    if (!list.length) return '';
    var h = '<h3>服务状态（' + list.length + ' 个）</h3>';
    h += '<table class="tbl"><thead><tr><th>服务</th><th>容器</th><th>state</th><th>health</th></tr></thead><tbody>';
    list.forEach(function (raw) {
      // compose ps 的 JSON 用大写字段名（Service/Name/State/Health），这里统一取一遍。
      var svc = { service: raw.Service || raw.service, name: raw.Name || raw.name, state: raw.State || raw.state, health: raw.Health || raw.health };
      var health = svc.health || '无 healthcheck';
      var cls = health === 'healthy' || !svc.health ? 'PASS' : 'WARN';
      h += '<tr><td>' + esc(svc.service) + '</td><td class="mono dim">' + esc(svc.name || '') + '</td><td>' + esc(svc.state || '') +
        '</td><td><span class="tag ' + cls + '">' + esc(health) + '</span></td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function renderSmoke() {
    var list = snap.smoke || [];
    if (!list.length) return '';
    var h = '<h3>冒烟结果（' + list.filter(function (i) { return i.passed; }).length + '/4）</h3>';
    h += '<table class="tbl"><thead><tr><th>项</th><th>结果</th><th>说明</th></tr></thead><tbody>';
    list.forEach(function (it) {
      h += '<tr><td>' + esc(it.name) + '</td><td><span class="tag ' + (it.passed ? 'PASS' : 'FAIL') + '">' +
        (it.passed ? 'PASS' : 'FAIL') + '</span></td><td>' + esc(it.detail) + '</td></tr>';
    });
    h += '</tbody></table>';
    return h;
  }

  function renderDone() {
    var h = '<h3>完成</h3>';
    h += '<div class="bigurl">' + esc(snap.accessUrl) + '</div>';
    h += '<div class="grid2">' +
      kv('S3 直连端点', snap.s3Endpoint) +
      kv('部署根', snap.deployRoot) +
      kv('日志目录', snap.logDir) +
      kv('管理员账号', '见 api 容器日志中 seed 步骤输出（或随包文档 现场部署.md）') +
      '</div>';
    h += '<div class="banner info">请先在服务器本机浏览器打开上面的地址验证一次，再把地址告诉局域网用户。' +
      '同时确认 8333 端口对局域网放通，否则上传会失败。</div>';
    h += '<div class="actions">' +
      '<button class="btn" data-action="finish"' + (busy ? ' disabled' : '') + '>关闭安装器（释放 18080 端口）</button>' +
      '<button class="btn gray" data-action="uninstall">卸载（保留业务数据）</button>' +
      '</div>';
    return h;
  }

  /* --------------------------------------------------------------- 事件 */

  function bindForm() {
    var form = document.getElementById('envform');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var payload = {};
      ['endpoint', 'postgresPassword', 'minioAccessKey', 'minioSecretKey', 'jwtAccessSecret', 'jwtRefreshSecret', 'redisPassword', 'corsOrigins'].forEach(function (k) {
        var el = document.getElementById('f_' + k);
        payload[k] = el ? el.value.trim() : '';
      });
      var ow = document.getElementById('f_overwrite');
      payload.overwrite = ow ? !!ow.checked : false;
      act('/api/env', payload, '表单已保存');
    });
  }

  document.addEventListener('click', function (ev) {
    var target = ev.target.closest('[data-action]');
    if (!target) return;
    var action = target.getAttribute('data-action');
    var id = target.getAttribute('data-id');

    if (action === 'view') {
      view = id;
      flash = null;
      render();
      return;
    }
    if (action === 'run-step') {
      act('/api/step', { step: id }, titleOf(id) + ' 完成');
      return;
    }
    if (action === 'run-all') {
      act('/api/run-all', {}, '全部步骤已执行完成');
      return;
    }
    if (action === 'confirm-os') {
      act('/api/confirm', {}, '已记录风险确认');
      return;
    }
    if (action === 'save-tar') {
      var input = document.getElementById('tarpath');
      act('/api/images-tar', { path: input ? input.value.trim() : '' }, '镜像包路径已保存');
      return;
    }
    if (action === 'finish') {
      act('/api/finish', {}, '安装器将在倒计时后退出').then(function () {
        flash = { kind: 'pass', text: '安装器将在 60 秒后退出并释放端口，现在可以关闭本页面。' };
        render();
      });
      return;
    }
    if (action === 'uninstall') {
      if (!window.confirm('确认卸载？业务数据（volumes/）会保留，但服务会停止。')) return;
      act('/api/uninstall', { purgeVolumes: false }, '已卸载（业务数据保留）');
      return;
    }
  });

  /* --------------------------------------------------------------- 轮询 */

  function syncTimers() {
    var isStepView = view !== 'overview';
    if (isStepView) {
      if (!logTimer) {
        logTimer = setInterval(pollLog, 1000);
        pollLog();
      }
    } else if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }

    var needStatus = busy || (snap && snap.nextStep !== 'S10_DONE' && isStepView);
    if (needStatus) {
      if (!statusTimer) statusTimer = setInterval(backgroundRefresh, 2000);
    } else if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }

    if (!clockTimer) {
      clockTimer = setInterval(function () {
        if (!snap) return;
        elapsedEl.textContent = '已用 ' + fmtDuration((snap.elapsedMs || 0) + (Date.now() - tickBase));
      }, 1000);
      tickBase = Date.now();
    }
  }

  var tickBase = Date.now();

  function backgroundRefresh() {
    api('/api/status').then(function (res) {
      if (!res.ok) return;
      var prevNext = snap ? snap.nextStep : null;
      snap = res.data;
      snap.elapsedMs = 0;
      tickBase = Date.now();
      // 不要在用户填表时重绘表单，避免输入被清空
      var form = document.getElementById('envform');
      if (form && document.activeElement && form.contains(document.activeElement)) {
        return;
      }
      if (prevNext !== snap.nextStep && snap.nextStep && view !== 'overview') {
        // 当前步已完成：自动跳到下一步，让用户接着点
        view = snap.nextStep;
      }
      render();
    });
  }

  function pollLog() {
    if (view === 'overview') return;
    var name = STEP_LOG[view];
    if (!name) return;
    api('/api/log?name=' + encodeURIComponent(name) + '&tail=400').then(function (res) {
      if (!res.ok) return;
      var box = document.getElementById('logbox');
      if (!box) return;
      var content = (res.data && res.data.content) || '';
      box.textContent = content || '（本步尚未产生日志）';
    });
  }

  function scrollLogToBottom() {
    var box = document.getElementById('logbox');
    if (box) box.scrollTop = box.scrollHeight;
  }

  /* --------------------------------------------------------------- 启动 */

  document.getElementById('footerhint').textContent =
    '安装器只在服务器本机运行，绑定 127.0.0.1:18080。安装完成后请关闭本页面并结束安装器进程。';

  refresh().catch(function () {
    panel.innerHTML = '<div class="banner fail">无法连接安装器（可能已经退出）。请在服务器终端重新执行 setup.run。</div>';
  });
})();
