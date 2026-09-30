package main

import (
	"reflect"
	"strings"
	"testing"
)

func routes(t *testing.T, text string) routeSnapshot {
	t.Helper()
	value, err := readRoutes(text)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func TestChangedPackageRetiresOnlyItsOwnFlows(t *testing.T) {
	before := "rules:\n- PROCESS-NAME,com.example.a,DIRECT\n- PROCESS-NAME,com.example.b,DIRECT\n- MATCH,DIRECT\n"
	for _, after := range []string{
		strings.Replace(before, "com.example.a,DIRECT", "com.example.a,REJECT", 1),
		strings.Replace(before, "- PROCESS-NAME,com.example.a,DIRECT\n", "", 1),
	} {
		if got := changedPackages(routes(t, before), routes(t, after)); !reflect.DeepEqual(got, map[string]bool{"com.example.a": true}) {
			t.Fatal(got)
		}
	}
	if got := changedPackages(routes(t, before), routes(t, before)); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestSelectionAndSandboxDependencies(t *testing.T) {
	before := `rules:
- SUB-RULE,(PROCESS-NAME,com.example.a),sandbox
- PROCESS-NAME,com.example.b,other
sub-rules:
  sandbox: ["DOMAIN,example.test,bundle", "MATCH,REJECT"]
proxy-groups:
- {name: bundle, type: select, proxies: [DIRECT, REJECT]}
- {name: other, type: select, proxies: [DIRECT, REJECT]}
procweaver-bundle-selections:
  bundle: DIRECT
  other: DIRECT
`
	for _, after := range []string{
		strings.Replace(before, "bundle: DIRECT", "bundle: REJECT", 1),
		strings.Replace(before, "DOMAIN,example.test,bundle", "DOMAIN,example.org,bundle", 1),
	} {
		if got := changedPackages(routes(t, before), routes(t, after)); !reflect.DeepEqual(got, map[string]bool{"com.example.a": true}) {
			t.Fatal(got)
		}
	}
}

func TestChangingReferencedProxyClosesItsPackages(t *testing.T) {
	before := `rules: ["PROCESS-NAME,com.example.a,group", "PROCESS-NAME,com.example.b,DIRECT"]
proxy-groups: [{name: group, type: select, proxies: [node]}]
proxies: [{name: node, type: http, server: 192.0.2.1, port: 1234}]
`
	after := strings.Replace(before, "192.0.2.1", "192.0.2.2", 1)
	if got := changedPackages(routes(t, before), routes(t, after)); !reflect.DeepEqual(got, map[string]bool{"com.example.a": true}) {
		t.Fatal(got)
	}
}
