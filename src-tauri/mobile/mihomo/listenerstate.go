package main

import (
	"errors"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/listener"
	"github.com/metacubex/mihomo/tunnel"
)

var activeListeners = map[string]C.InboundListener{}

// Mihomo reuses equal listeners. Keep their original objects so readiness checks
// inspect the bound sockets, including when applying an unchanged configuration.
func reuseListeners(cfg *config.Config) {
	for name, next := range cfg.Listeners {
		if previous := activeListeners[name]; previous != nil && previous.Config().Equal(next.Config()) {
			cfg.Listeners[name] = previous
		}
	}
}
func verifyListeners(cfg *config.Config) error {
	for _, current := range cfg.Listeners {
		if current.Address() == "" {
			return errors.New("proxy listener initialization failed")
		}
	}
	if cfg.General.MixedPort != 0 && listener.GetPorts().MixedPort != cfg.General.MixedPort {
		return errors.New("local proxy port unavailable")
	}
	activeListeners = cfg.Listeners
	return nil
}
func closeListeners() {
	listener.PatchInboundListeners(map[string]C.InboundListener{}, tunnel.Tunnel, true)
	listener.ReCreateMixed(0, tunnel.Tunnel)
	listener.ReCreateHTTP(0, tunnel.Tunnel)
	listener.ReCreateSocks(0, tunnel.Tunnel)
	activeListeners = map[string]C.InboundListener{}
}
