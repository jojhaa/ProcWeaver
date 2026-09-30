package main

import (
	"sync"
	"sync/atomic"

	MC "github.com/metacubex/mihomo/constant"
	P "github.com/metacubex/mihomo/constant/provider"
)

type historyProvider struct {
	mu      sync.Mutex
	source  P.ProxyProvider
	version uint32
	kinds   map[string]bool
}
type historyOutbounds struct {
	kinds     map[string]bool
	providers map[string]*historyProvider
}

var historyProxyKinds atomic.Pointer[historyOutbounds]

func proxyKind(proxy MC.Proxy) bool {
	switch proxy.Type() {
	case MC.Direct, MC.Reject, MC.RejectDrop, MC.Pass, MC.Compatible:
		return false
	default:
		return true
	}
}
func publishHistoryProxies(proxies map[string]MC.Proxy, providers map[string]P.ProxyProvider) {
	snapshot := &historyOutbounds{kinds: make(map[string]bool, len(proxies)), providers: make(map[string]*historyProvider, len(providers))}
	for name, proxy := range proxies {
		snapshot.kinds[name] = proxyKind(proxy)
	}
	for name, provider := range providers {
		snapshot.providers[name] = &historyProvider{source: provider}
	}
	historyProxyKinds.Store(snapshot)
}
func (p *historyProvider) kind(name string) (bool, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	version := p.source.Version()
	if p.kinds == nil || version != p.version {
		kinds := make(map[string]bool)
		for _, proxy := range p.source.Proxies() {
			kinds[proxy.Name()] = proxyKind(proxy)
		}
		p.kinds, p.version = kinds, version
	}
	value, found := p.kinds[name]
	return value, found
}

// Provider nodes are absent from Config.Proxies. Resolve the actual provider
// chain first, caching its classification until the provider version changes.
// Never read the mutable tunnel provider map on forwarding goroutines.
func historyIsProxied(exit string, providerChain []string) bool {
	snapshot := historyProxyKinds.Load()
	if snapshot == nil {
		return false
	}
	for _, name := range providerChain {
		if provider := snapshot.providers[name]; provider != nil {
			if proxied, found := provider.kind(exit); found {
				return proxied
			}
		}
	}
	return snapshot.kinds[exit]
}
