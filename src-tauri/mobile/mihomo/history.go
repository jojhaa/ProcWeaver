package main

/*
#include "bridge.h"
*/
import "C"

import (
	"encoding/json"
	"path/filepath"
	"time"
	_ "time/tzdata"

	"github.com/metacubex/mihomo/component/process"
	MC "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/tunnel/statistic"
	"procweaver/mobilecore/traffic"
)

var historyLedger *traffic.Ledger
var historyStop chan struct{}
var historyDone chan struct{}
var historyError string
var liveCounters *traffic.LiveCounters

func closeHistory() {
	statistic.SetLifecycleObserver(nil)
	if historyStop != nil {
		close(historyStop)
		<-historyDone
		historyStop = nil
	}
	if historyLedger != nil {
		if err := historyLedger.Close(); err != nil {
			historyError = "历史记录保存失败"
		}
		historyLedger = nil
	}
}
func startHistory(home, zone string) error {
	closeHistory()
	counters := traffic.NewLiveCounters()
	liveCounters = counters
	location, err := time.LoadLocation(zone)
	var ledger *traffic.Ledger
	if err == nil {
		ledger, err = traffic.Open(filepath.Join(home, "traffic-history.db"), location)
	}
	historyLedger = ledger
	historyError = ""
	statistic.SetLifecycleObserver(&statistic.LifecycleObserver{
		Join: func(tracker statistic.Tracker) {
			info := tracker.Info()
			if info.Metadata == nil || info.Metadata.Type == MC.INNER {
				return
			}
			exit := ""
			if len(info.Chain) > 0 {
				exit = info.Chain[0]
			}
			proxied := historyIsProxied(exit, info.ProviderChain)
			read := func() (int64, int64) { return info.UploadTotal.Load(), info.DownloadTotal.Load() }
			if proxied {
				counters.Begin(tracker.ID(), read)
			}
			if ledger == nil {
				return
			}
			pkg := info.Metadata.Process
			if pkg == "" && info.Metadata.Type == MC.TUN && process.DefaultPackageNameResolver != nil {
				pkg, _ = process.DefaultPackageNameResolver(info.Metadata)
			}
			ledger.Begin(tracker.ID(), pkg, exit, proxied, read)
		},
		Leave: func(tracker statistic.Tracker) {
			counters.End(tracker.ID())
			if ledger != nil {
				ledger.End(tracker.ID())
			}
		},
	})
	// In-memory counters remain available if persistence cannot be initialized.
	if err != nil {
		return err
	}
	historyStop = make(chan struct{})
	historyDone = make(chan struct{})
	go func(stop, done chan struct{}) {
		defer close(done)
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				// The timer already batches writes. Do not add another minute
				// gate after an early query or a slightly delayed previous tick.
				_ = ledger.Tick(true)
			case <-stop:
				return
			}
		}
	}(historyStop, historyDone)
	return nil
}

//export PWHistory
func PWHistory(home, zone, action *C.char, start, end C.longlong) *C.char {
	lifecycle.Lock()
	defer lifecycle.Unlock()
	result := traffic.Result{Rows: []traffic.Row{}, RetentionDays: traffic.RetentionDays}
	operation := C.GoString(action)
	if operation == "start" {
		if err := startHistory(C.GoString(home), C.GoString(zone)); err != nil {
			historyError = "流量历史无法初始化，VPN 转发不受影响"
		}
		result.Error = historyError
	} else {
		ledger := historyLedger
		if ledger == nil {
			location, err := time.LoadLocation(C.GoString(zone))
			if err == nil {
				ledger, err = traffic.Open(filepath.Join(C.GoString(home), "traffic-history.db"), location)
			}
			if err != nil {
				result.Error = "无法读取流量历史"
			} else {
				defer ledger.Close()
			}
		}
		if ledger != nil {
			if operation == "clear" {
				if err := ledger.Clear(); err != nil {
					result.Error = "清理流量历史失败"
				}
			}
			if operation == "query" {
				var err error
				result, err = ledger.Query(time.UnixMilli(int64(start)), time.UnixMilli(int64(end)))
				if err != nil {
					result.Error = "读取流量历史失败，日期范围应为 1–32 天"
				}
			}
		}
	}
	raw, _ := json.Marshal(result)
	return C.CString(string(raw))
}
