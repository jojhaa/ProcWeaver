package main

import (
	MC "github.com/metacubex/mihomo/constant"
	P "github.com/metacubex/mihomo/constant/provider"
	"testing"
)

type historyTestProxy struct {
	MC.Proxy
	name string
	kind MC.AdapterType
}

func (p historyTestProxy) Name() string         { return p.name }
func (p historyTestProxy) Type() MC.AdapterType { return p.kind }

type historyTestProvider struct {
	P.ProxyProvider
	nodes   []MC.Proxy
	version uint32
}

func (p *historyTestProvider) Proxies() []MC.Proxy { return p.nodes }
func (p *historyTestProvider) Version() uint32     { return p.version }

func TestHistoryClassifiesProvidersAndRefreshes(t *testing.T) {
	p := &historyTestProvider{nodes: []MC.Proxy{historyTestProxy{name: "provider-exit", kind: MC.Http}, historyTestProxy{name: "custom-direct", kind: MC.Direct}}}
	publishHistoryProxies(map[string]MC.Proxy{"provider-exit": historyTestProxy{name: "provider-exit", kind: MC.Direct}}, map[string]P.ProxyProvider{"remote": p})
	if !historyIsProxied("provider-exit", []string{"remote"}) || historyIsProxied("custom-direct", []string{"remote"}) {
		t.Fatal("provider classification wrong")
	}
	if historyIsProxied("provider-exit", nil) {
		t.Fatal("provider overrode a distinct top-level direct proxy")
	}
	p.nodes = []MC.Proxy{historyTestProxy{name: "provider-exit", kind: MC.Direct}}
	p.version++
	if historyIsProxied("provider-exit", []string{"remote"}) {
		t.Fatal("provider update left stale classification")
	}
}
