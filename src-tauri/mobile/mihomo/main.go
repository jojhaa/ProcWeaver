// ProcWeaver's Android host for the existing Mihomo core. No client bridge is vendored.
package main

/*
#include "bridge.h"
*/
import "C"

import (
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/metacubex/mihomo/adapter/outboundgroup"
	"github.com/metacubex/mihomo/component/dialer"
	"github.com/metacubex/mihomo/component/geodata"
	"github.com/metacubex/mihomo/component/mmdb"
	"github.com/metacubex/mihomo/component/process"
	"github.com/metacubex/mihomo/config"
	MC "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/dns"
	"github.com/metacubex/mihomo/hub"
	"github.com/metacubex/mihomo/hub/executor"
	"github.com/metacubex/mihomo/hub/route"
	LC "github.com/metacubex/mihomo/listener/config"
	"github.com/metacubex/mihomo/listener/sing_tun"
	"github.com/metacubex/mihomo/ntp/ntp"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
	"golang.org/x/sys/unix"
)

var lifecycle sync.Mutex
var vpn *sing_tun.Listener
var homeDirectory string
var controllerAddress string
var appliedRoutes routeSnapshot

// The original VpnService descriptor stays open until PWStart returns. Only close
// a failed transfer if the duplicate still refers to that exact TUN interface.
func closeFailedTransfer(original, duplicate int) {
	source, _ := unix.NewIfreq("")
	target, _ := unix.NewIfreq("")
	if unix.IoctlIfreq(original, unix.TUNGETIFF, source) == nil &&
		unix.IoctlIfreq(duplicate, unix.TUNGETIFF, target) == nil && source.Name() == target.Name() {
		_ = unix.Close(duplicate)
	}
}

func waitController(open bool) bool {
	if controllerAddress == "" {
		return !open
	}
	for attempt := 0; attempt < 100; attempt++ {
		conn, err := net.DialTimeout("tcp", controllerAddress, 30*time.Millisecond)
		if conn != nil {
			_ = conn.Close()
		}
		if (err == nil) == open {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}

func closeProviders() {
	for _, provider := range tunnel.Providers() {
		if closer, ok := provider.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	}
	for _, provider := range tunnel.RuleProviders() {
		if closer, ok := provider.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
	}
}

func stopCore() {
	closeHealth()
	appliedRoutes = routeSnapshot{}
	if vpn != nil {
		_ = vpn.Close()
		vpn = nil
	}
	statistic.DefaultManager.Range(func(tracker statistic.Tracker) bool { _ = tracker.Close(); return true })
	// Shutdown is a desktop process-exit helper; embedded hosts must also cancel
	// provider refresh/health checks, DNS listeners and optional NTP work.
	closeProviders()
	closeListeners()
	dns.ReCreateServer("", nil, nil)
	ntp.ReCreateNTPService("", 0, "", nil, false)
	executor.Shutdown()
	route.ReCreateServer(&route.Config{})
	waitController(false)
	closeHistory()
}

func initialize(home string) error {
	if homeDirectory != "" && homeDirectory != home {
		return errors.New("core home cannot change")
	}
	if homeDirectory == "" {
		MC.SetHomeDir(home)
		homeDirectory = home
		// Keep Go's default GC policy until device benchmarks establish a heap
		// budget; an arbitrary low limit can trade memory for battery and latency.
		dialer.DefaultSocketHook = func(network, address string, conn syscall.RawConn) error {
			var protected bool
			if err := conn.Control(func(fd uintptr) { protected = C.pw_protect(C.int(fd), C.int(healthActive.Load())) != 0 }); err != nil {
				return err
			}
			if !protected {
				return errors.New("VPN socket protection unavailable")
			}
			return nil
		}
		process.DefaultPackageNameResolver = func(metadata *MC.Metadata) (string, error) {
			protocol := 6
			if metadata.NetWork == MC.UDP {
				protocol = 17
			}
			src, dst := C.CString(metadata.SrcIP.String()), C.CString(metadata.DstIP.String())
			defer C.free(unsafe.Pointer(src))
			defer C.free(unsafe.Pointer(dst))
			name := C.pw_package(C.int(protocol), src, C.int(metadata.SrcPort), dst, C.int(metadata.DstPort))
			defer C.free(unsafe.Pointer(name))
			value := C.GoString(name)
			if value == "" {
				return "", errors.New("connection owner unavailable or shared UID")
			}
			return value, nil
		}
	}
	return nil
}

//export PWValidate
func PWValidate(home, raw *C.char) *C.char {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if err := initialize(C.GoString(home)); err != nil {
		return C.CString(err.Error())
	}
	if vpn == nil {
		geodata.ClearGeoSiteCache()
		geodata.ClearGeoIPCache()
		mmdb.ReloadIP()
		mmdb.ReloadASN()
	}
	_, err := config.Parse([]byte(C.GoString(raw)))
	if err != nil {
		return C.CString("invalid core configuration")
	}
	return C.CString("")
}

//export PWValidateGeo
func PWValidateGeo(kind, path *C.char) *C.char {
	if err := validateGeoFile(C.GoString(kind), C.GoString(path)); err != nil {
		return C.CString("Geo database validation failed")
	}
	return C.CString("")
}

//export PWNetworkChanged
func PWNetworkChanged() {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	closeHealth()
	if vpn == nil {
		return
	}
	statistic.DefaultManager.Range(func(tracker statistic.Tracker) bool { _ = tracker.Close(); return true })
}

//export PWStart
func PWStart(home, raw *C.char, fd C.int) *C.char {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	closeHealth()
	if vpn != nil {
		return C.CString("core already started")
	}
	if err := initialize(C.GoString(home)); err != nil {
		return C.CString(err.Error())
	}
	geodata.ClearGeoSiteCache()
	geodata.ClearGeoIPCache()
	mmdb.ReloadIP()
	mmdb.ReloadASN()
	cfg, err := config.Parse([]byte(C.GoString(raw)))
	if err != nil {
		return C.CString("invalid core configuration")
	}
	// REST reloads manage ordinary listeners only. The VPN FD belongs to this host.
	cfg.General.Tun.Enable = false
	statistic.DefaultManager.ResetStatistic()
	controllerAddress = cfg.Controller.ExternalController
	publishHistoryProxies(cfg.Proxies, cfg.Providers)
	hub.ApplyConfig(cfg)
	if err = verifyListeners(cfg); err != nil {
		stopCore()
		return C.CString(err.Error())
	}
	if err = selectRoutes(C.GoString(raw)); err != nil {
		stopCore()
		return C.CString("application route selection failed")
	}
	// ReCreateServer is asynchronous: serialize readiness/close before another start.
	if !waitController(true) {
		stopCore()
		return C.CString("controller initialization failed")
	}
	ownedFD, err := syscall.Dup(int(fd))
	if err != nil {
		stopCore()
		return C.CString("duplicate TUN descriptor failed")
	}
	if err = unix.SetNonblock(ownedFD, true); err != nil {
		_ = unix.Close(ownedFD)
		stopCore()
		return C.CString("configure TUN descriptor failed")
	}
	options := LC.Tun{
		Enable: true, FileDescriptor: ownedFD, Stack: MC.TunGvisor, MTU: 1500,
		DNSHijack:    []string{"any:53", "tcp://any:53"},
		Inet4Address: []netip.Prefix{netip.MustParsePrefix("172.19.0.1/30")},
		Inet6Address: []netip.Prefix{netip.MustParsePrefix("fdfe:dcba:9876::1/126")},
	}
	vpn, err = sing_tun.New(options, tunnel.Tunnel)
	if err != nil {
		closeFailedTransfer(int(fd), ownedFD)
		stopCore()
		return C.CString("TUN initialization failed")
	}
	appliedRoutes, _ = readRoutes(C.GoString(raw))
	return C.CString("")
}

func selectRoutes(raw string) error {
	routes, err := readRoutes(raw)
	if err != nil {
		return err
	}
	proxies := tunnel.Proxies()
	for name, target := range routes.Selections {
		proxy, ok := proxies[name]
		if !ok {
			return errors.New("route group missing")
		}
		selector, ok := proxy.Adapter().(outboundgroup.SelectAble)
		if !ok {
			return errors.New("route group is not selectable")
		}
		if err := selector.Set(target); err != nil {
			return err
		}
	}
	return nil
}

//export PWReload
func PWReload(raw *C.char) *C.char {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if vpn == nil {
		return C.CString("VPN is not running")
	}
	cfg, err := config.Parse([]byte(C.GoString(raw)))
	if err != nil {
		return C.CString("invalid core configuration")
	}
	cfg.General.Tun.Enable = false
	closeHealth()
	reuseListeners(cfg)
	closeProviders()
	// Keep Android's independent TUN descriptor and the authenticated controller.
	// Mihomo deliberately disables REST config writes in its Android embed mode.
	publishHistoryProxies(cfg.Proxies, cfg.Providers)
	executor.ApplyConfig(cfg, true)
	if err := verifyListeners(cfg); err != nil {
		closeListeners()
		return C.CString(err.Error())
	}
	if err := selectRoutes(C.GoString(raw)); err != nil {
		return C.CString("application route selection failed")
	}
	next, err := readRoutes(C.GoString(raw))
	if err != nil {
		return C.CString("invalid application routes")
	}
	changed := changedPackages(appliedRoutes, next)
	statistic.DefaultManager.Range(func(tracker statistic.Tracker) bool {
		if changed[tracker.Info().Metadata.Process] {
			_ = tracker.Close()
		}
		return true
	})
	appliedRoutes = next
	return C.CString("")
}

//export PWMode
func PWMode(raw *C.char) *C.char {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if vpn == nil {
		return C.CString("VPN is not running")
	}
	switch C.GoString(raw) {
	case "Rule":
		tunnel.SetMode(tunnel.Rule)
	case "Global":
		tunnel.SetMode(tunnel.Global)
	case "Direct":
		tunnel.SetMode(tunnel.Direct)
	default:
		return C.CString("invalid routing mode")
	}
	return C.CString("")
}

//export PWStop
func PWStop() {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	stopCore()
}

//export PWStats
func PWStats() *C.char {
	// ApplyConfig replaces the proxy map; stats must share its lifecycle lock.
	lifecycle.Lock()
	defer lifecycle.Unlock()
	var proxyUp, proxyDown int64
	if liveCounters != nil {
		proxyUp, proxyDown = liveCounters.Total()
	}
	up, down := statistic.DefaultManager.Total()
	bytes, _ := json.Marshal(struct {
		Upload        int64      `json:"uploadTotal"`
		Download      int64      `json:"downloadTotal"`
		ProxyUpload   int64      `json:"proxyUploadTotal"`
		ProxyDownload int64      `json:"proxyDownloadTotal"`
		Connections   []struct{} `json:"connections"`
		Version       string     `json:"version"`
	}{up, down, proxyUp, proxyDown, []struct{}{}, MC.Version})
	return C.CString(string(bytes))
}

func main() {}
