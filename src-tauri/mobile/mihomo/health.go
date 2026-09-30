package main

/*
#include "bridge.h"
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/metacubex/mihomo/adapter"
	MC "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel"
)

type healthNode struct {
	client *http.Client
	proxy  MC.Proxy
	owned  bool
	err    string
}
type healthSession struct {
	ctx    context.Context
	cancel context.CancelFunc
	nodes  map[string]*healthNode
}

var healthMu sync.Mutex
var healthActive atomic.Int32
var healthSessions = map[string]*healthSession{}

func endHealth(id string) {
	healthMu.Lock()
	session := healthSessions[id]
	delete(healthSessions, id)
	healthMu.Unlock()
	if session != nil {
		healthActive.Add(-1)
		session.cancel()
		for _, node := range session.nodes {
			if node.client != nil {
				node.client.CloseIdleConnections()
			}
			if node.owned {
				_ = node.proxy.Close()
			}
		}
	}
}

func closeHealth() {
	healthMu.Lock()
	ids := make([]string, 0, len(healthSessions))
	for id := range healthSessions {
		ids = append(ids, id)
	}
	healthMu.Unlock()
	for _, id := range ids {
		endHealth(id)
	}
}

func pinnedClient(proxy MC.Proxy) *http.Client {
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, TLSHandshakeTimeout: 6 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			number, err := strconv.ParseUint(port, 10, 16)
			if err != nil {
				return nil, err
			}
			return proxy.DialContext(ctx, &MC.Metadata{NetWork: MC.TCP, Type: MC.INNER, Host: host, DstPort: uint16(number)})
		}}
	return &http.Client{Transport: transport, Timeout: 8 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
}

func beginHealth(home string, nodes []map[string]any) (string, error) {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	if len(nodes) == 0 || len(nodes) > 4 {
		return "", errors.New("每批体检限 1–4 个节点")
	}
	if err := initialize(home); err != nil {
		return "", errors.New("检测环境初始化失败")
	}
	healthMu.Lock()
	full := len(healthSessions) >= 2
	healthMu.Unlock()
	if full {
		return "", errors.New("已有检测正在进行，请稍后重试")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	session := &healthSession{ctx: ctx, cancel: cancel, nodes: map[string]*healthNode{}}
	for _, raw := range nodes {
		name, _ := raw["name"].(string)
		node := &healthNode{}
		if vpn != nil {
			node.proxy = tunnel.Proxies()[name]
		}
		if node.proxy == nil {
			if dependency, _ := raw["dialer-proxy"].(string); dependency != "" {
				node.err = "此节点依赖其他出口，请连接 VPN 后体检"
			} else {
				proxy, err := adapter.ParseProxy(raw)
				if err != nil {
					node.err = "节点配置不支持独立检测或参数无效"
				} else {
					node.proxy = proxy
					node.owned = true
				}
			}
		}
		if node.proxy != nil {
			node.client = pinnedClient(node.proxy)
		}
		session.nodes[name] = node
	}
	id := strconv.FormatInt(time.Now().UnixNano(), 10)
	healthMu.Lock()
	healthSessions[id] = session
	healthActive.Add(1)
	healthMu.Unlock()
	go func() { <-ctx.Done(); endHealth(id) }()
	return id, nil
}

func runHealth(id, name string) (map[string]any, error) {
	healthMu.Lock()
	session := healthSessions[id]
	healthMu.Unlock()
	if session == nil {
		return nil, errors.New("检测已取消、过期或网络发生变化，请重试")
	}
	node := session.nodes[name]
	if node == nil {
		return nil, errors.New("节点不在检测批次中")
	}
	if node.err != "" {
		return nil, errors.New(node.err)
	}
	endpoints := []struct{ source, url, ip string }{
		{"ippure", "https://my.ippure.com/v1/info", "ip"},
		{"ip-api", "http://ip-api.com/json/?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,org,as,query", "query"},
	}
	failure := "检测服务未返回有效 IP，请稍后重试"
	for _, endpoint := range endpoints {
		request, _ := http.NewRequestWithContext(session.ctx, http.MethodGet, endpoint.url, nil)
		request.Header.Set("User-Agent", "ProcWeaver/Android")
		request.Header.Set("Accept", "application/json")
		response, err := node.client.Do(request)
		if err != nil {
			if session.ctx.Err() != nil {
				return nil, errors.New("检测已取消或超时")
			}
			if timeout, ok := err.(net.Error); ok && timeout.Timeout() {
				failure = "节点连接或检测服务超时"
			} else {
				failure = "节点连接失败，请检查网络或节点配置"
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 128*1024+1))
		_ = response.Body.Close()
		if response.StatusCode == 429 {
			failure = "检测服务请求过多，请稍后重试"
			continue
		}
		if readErr != nil || response.StatusCode != 200 || len(body) > 128*1024 {
			continue
		}
		var data map[string]any
		if json.Unmarshal(body, &data) != nil {
			continue
		}
		ip, _ := data[endpoint.ip].(string)
		if net.ParseIP(ip) != nil {
			return map[string]any{"source": endpoint.source, "body": string(body)}, nil
		}
	}
	return nil, errors.New(failure)
}

//export PWHealth
func PWHealth(home, input *C.char) *C.char {
	var args struct {
		Action  string           `json:"action"`
		Session string           `json:"session"`
		Node    string           `json:"node"`
		Nodes   []map[string]any `json:"nodes"`
	}
	var result any = map[string]any{}
	var err error
	if json.Unmarshal([]byte(C.GoString(input)), &args) != nil {
		err = errors.New("检测参数无效")
	} else {
		switch args.Action {
		case "begin":
			var id string
			id, err = beginHealth(C.GoString(home), args.Nodes)
			result = map[string]any{"session": id}
		case "probe":
			result, err = runHealth(args.Session, args.Node)
		case "end":
			endHealth(args.Session)
		default:
			err = errors.New("未知检测操作")
		}
	}
	if err != nil {
		result = map[string]any{"error": err.Error()}
	}
	encoded, _ := json.Marshal(result)
	return C.CString(string(encoded))
}
