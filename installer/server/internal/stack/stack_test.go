package stack

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"tianji-archive/installer/internal/buildplan"
	"tianji-archive/installer/internal/execx"
)

type stubRunner struct{ out map[string]string }

func (s stubRunner) Run(_ context.Context, name string, args ...string) (execx.Result, error) {
	key := name + " " + strings.Join(args, " ")
	if v, ok := s.out[key]; ok {
		return execx.Result{Command: key, Stdout: v}, nil
	}
	return execx.Result{Command: key, ExitCode: 1}, errors.New("未预置: " + key)
}

func newStackForTest(runner execx.Runner, opts ...func(*Options)) *Stack {
	o := Options{
		Layout:      buildplan.Layout{DeployRoot: "/opt/tianji"},
		ComposeFile: "/opt/tianji/docker-compose.offline.yml",
		EnvFile:     "/opt/tianji/.env",
		Runner:      runner,
	}
	for _, fn := range opts {
		fn(&o)
	}
	return New(o)
}

// compose 的全局 flag 必须在子命令之前，否则 .env 会被静默忽略。
func TestComposeArgsPutGlobalFlagsFirst(t *testing.T) {
	st := newStackForTest(stubRunner{})
	args := st.ComposeArgs("up", "-d")
	want := []string{"compose", "-f", "/opt/tianji/docker-compose.offline.yml", "--env-file", "/opt/tianji/.env", "up", "-d"}
	if len(args) != len(want) {
		t.Fatalf("参数个数不对: %v", args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("第 %d 个参数不对: %v", i, args)
		}
	}
	if args[len(args)-1] != "-d" {
		t.Fatalf("子命令必须落在最后: %v", args)
	}
}

func TestPSParsesJSONArray(t *testing.T) {
	body := `[{"Service":"postgres","State":"running","Health":"healthy"},{"Service":"api","State":"running"}]`
	st := newStackForTest(stubRunner{out: map[string]string{
		"docker compose -f /opt/tianji/docker-compose.offline.yml --env-file /opt/tianji/.env ps --format json": body,
	}})
	services, err := st.ps(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(services) != 2 || services[0].Service != "postgres" {
		t.Fatalf("解析结果不对: %+v", services)
	}
}

// compose v2.20 及更早输出「每行一个 JSON 对象」，必须兼容。
func TestPSParsesJSONLines(t *testing.T) {
	body := `{"Service":"postgres","State":"running","Health":"healthy"}
{"Service":"api","State":"running","Health":"starting"}`
	st := newStackForTest(stubRunner{out: map[string]string{
		"docker compose -f /opt/tianji/docker-compose.offline.yml --env-file /opt/tianji/.env ps --format json": body,
	}})
	services, err := st.ps(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(services) != 2 || services[1].Health != "starting" {
		t.Fatalf("解析结果不对: %+v", services)
	}
}

func TestUnhealthyDetectsStartingAndExited(t *testing.T) {
	list := []ServiceHealth{
		{Service: "a", State: "running", Health: "healthy"},
		{Service: "b", State: "running"},
		{Service: "c", State: "running", Health: "starting"},
		{Service: "d", State: "exited", Health: ""},
	}
	bad := unhealthy(list)
	if len(bad) != 2 {
		t.Fatalf("应只有 c、d 未就绪，实际 %+v", bad)
	}
	desc := describe(bad)
	if !strings.Contains(desc, "c[state=running health=starting]") {
		t.Fatalf("描述不对: %s", desc)
	}
}

// 关键回归：/api/health 返回 {code,data:{status:ok,...}} 的包装形态，
// 必须与 offline/smoke.sh 用同一组字符串判据（否则两边结论会不一致）。
func TestSmokeUsesSameTokensAsSmokeSh(t *testing.T) {
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"code":0,"data":{"status":"ok","deps":[{"name":"objectStorage","ok":true}]},"message":"成功"}`))
	}))
	defer apiSrv.Close()

	esSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/_analyze" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"tokens":[{"token":"中华人民共和国"}]}`))
	}))
	defer esSrv.Close()

	st := newStackForTest(stubRunner{out: map[string]string{}}, func(o *Options) {
		o.APIBaseURL = apiSrv.URL
		o.ESBaseURL = esSrv.URL
	})
	items, err := st.Smoke(context.Background())
	// exec 的两项会失败（桩里没有 exec 输出），但 1/4 与 4/4 必须通过。
	if len(items) != 4 {
		t.Fatalf("应有 4 项冒烟，实际 %d", len(items))
	}
	if !items[0].Passed {
		t.Fatalf("健康检查应通过: %+v", items[0])
	}
	if !items[3].Passed {
		t.Fatalf("IK 分词应通过: %+v", items[3])
	}
	if err == nil {
		t.Fatal("有两项 exec 失败，整体必须报错")
	}
	if !strings.Contains(err.Error(), "2/4") {
		t.Fatalf("错误应给出失败项数: %v", err)
	}
}

// 后端 degraded（objectStorage=false）时必须判失败，且提示要指向 objectStorage。
func TestSmokeFailsWhenObjectStorageNotReady(t *testing.T) {
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":0,"data":{"status":"ok","deps":[{"name":"objectStorage","ok":false}]}}`))
	}))
	defer apiSrv.Close()
	esSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tokens":[]}`))
	}))
	defer esSrv.Close()

	st := newStackForTest(stubRunner{out: map[string]string{}}, func(o *Options) {
		o.APIBaseURL = apiSrv.URL
		o.ESBaseURL = esSrv.URL
	})
	items, _ := st.Smoke(context.Background())
	if items[0].Passed {
		t.Fatal("objectStorage 未就绪时必须判失败")
	}
	if !strings.Contains(items[0].Detail, "objectStorage") {
		t.Fatalf("提示应指向 objectStorage: %s", items[0].Detail)
	}
}

func TestSmokeFailsWhenIKNotInstalled(t *testing.T) {
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"status":"ok","deps":[{"name":"objectStorage","ok":true}]}}`))
	}))
	defer apiSrv.Close()
	esSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 标准分词器不会切出「中华人民共和国」整词
		_, _ = w.Write([]byte(`{"tokens":[{"token":"中华"},{"token":"人民"}]}`))
	}))
	defer esSrv.Close()

	st := newStackForTest(stubRunner{out: map[string]string{}}, func(o *Options) {
		o.APIBaseURL = apiSrv.URL
		o.ESBaseURL = esSrv.URL
	})
	items, _ := st.Smoke(context.Background())
	if items[3].Passed {
		t.Fatal("IK 未切出预期词条时必须判失败")
	}
	if !strings.Contains(items[3].Detail, "IK") {
		t.Fatalf("提示应说明 IK: %s", items[3].Detail)
	}
}

func TestLastLinesHelperInWebPackageNotNeededHere(t *testing.T) {
	// 占位：stack 包不需要截断行逻辑，这里只为保证 test 文件里 truncate 被覆盖。
	if got := truncate("abcdef", 3); !strings.HasPrefix(got, "abc") {
		t.Fatalf("truncate 行为不对: %q", got)
	}
	if got := truncate("abc", 10); got != "abc" {
		t.Fatalf("短串不应被截断: %q", got)
	}
}
