package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/metacubex/mihomo/component/profile/cachefile"
	"github.com/metacubex/mihomo/config"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
)

func TestSharingListenerLifecycle(t *testing.T) {
	C.SetHomeDir(t.TempDir())
	defer func() { _ = cachefile.Cache().Close() }()
	defer closeListeners()
	// Bind on a non-loopback host interface so skip-auth-prefixes cannot hide
	// missing authentication. Every endpoint stays on this test machine.
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	var host string
	for _, address := range addresses {
		ip, _, _ := net.ParseCIDR(address.String())
		if ip != nil && ip.To4() != nil && ip.IsPrivate() && !ip.IsLoopback() {
			host = ip.String()
			break
		}
	}
	if host == "" {
		t.Fatal("test requires a local IPv4 interface")
	}
	free, err := net.Listen("tcp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	port := free.Addr().(*net.TCPAddr).Port
	free.Close()
	source := fmt.Sprintf("proxies: []\nrules: ['MATCH,REJECT']\ndns: {enable: false}\nauthentication: [test:isolated-test-password]\nskip-auth-prefixes: [127.0.0.0/8]\nlan-allowed-ips: [%s/32, 127.0.0.0/8]\nlisteners:\n- {name: procweaver-lan, type: mixed, listen: '0.0.0.0', port: %d, udp: false, proxy: REJECT}\n", host, port)
	parse := func() *config.Config {
		cfg, e := config.Parse([]byte(source))
		if e != nil {
			t.Fatal(e)
		}
		return cfg
	}
	first := parse()
	executor.ApplyConfig(first, true)
	if err = verifyListeners(first); err != nil {
		t.Fatal(err)
	}
	proxyURL, _ := url.Parse(fmt.Sprintf("http://%s:%d", host, port))
	transport := &http.Transport{Proxy: http.ProxyURL(proxyURL)}
	defer transport.CloseIdleConnections()
	client := http.Client{Transport: transport, Timeout: time.Second * 3}
	response, err := client.Get("http://192.0.2.1/test")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != 407 {
		t.Fatalf("unauthenticated request returned %d", response.StatusCode)
	}
	next := parse()
	reuseListeners(next)
	executor.ApplyConfig(next, true)
	if err = verifyListeners(next); err != nil {
		t.Fatal(err)
	}
	closeListeners()
	// Stop must release the public sharing port, not leave a forwarding server.
	owned, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		t.Fatal("stop leaked listener", err)
	}
	defer owned.Close()
	conflict := parse()
	executor.ApplyConfig(conflict, true)
	if verifyListeners(conflict) == nil {
		t.Fatal("occupied sharing port reported ready")
	}
}
