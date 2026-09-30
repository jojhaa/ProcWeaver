package traffic

import (
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
)

func TestLiveCountersKeepClosedFlowsAndDoNotDoubleCount(t *testing.T) {
	c := NewLiveCounters()
	var up, down int64 = 10, 20
	c.Begin("short", func() (int64, int64) { return up, down })
	c.End("short")
	c.End("short")
	up, down = 50, 90
	c.Begin("active", func() (int64, int64) { return up, down })
	for n := 0; n < 3; n++ {
		if u, d := c.Total(); u != 60 || d != 110 {
			t.Fatalf("bad totals %d/%d", u, d)
		}
	}
	up, down = 70, 100
	c.End("active")
	if u, d := c.Total(); u != 80 || d != 120 {
		t.Fatalf("closed flow lost %d/%d", u, d)
	}
	if len(c.active) != 0 {
		t.Fatal("closed counter readers retained")
	}
}

func TestLiveCountersConcurrentSnapshotsAndCloses(t *testing.T) {
	c := NewLiveCounters()
	var done atomic.Bool
	var readers sync.WaitGroup
	readers.Add(1)
	go func() {
		defer readers.Done()
		for !done.Load() {
			c.Total()
		}
	}()
	var writers sync.WaitGroup
	for n := 0; n < 200; n++ {
		writers.Add(1)
		go func(id string) { defer writers.Done(); c.Begin(id, func() (int64, int64) { return 7, 11 }); c.End(id) }(fmt.Sprint(n))
	}
	writers.Wait()
	done.Store(true)
	readers.Wait()
	if u, d := c.Total(); u != 1400 || d != 2200 {
		t.Fatalf("concurrent totals %d/%d", u, d)
	}
}

func BenchmarkLiveTotals1000(b *testing.B) {
	c := NewLiveCounters()
	for n := 0; n < 1000; n++ {
		c.Begin(fmt.Sprint(n), func() (int64, int64) { return 7, 11 })
	}
	b.ReportAllocs()
	b.ResetTimer()
	for n := 0; n < b.N; n++ {
		c.Total()
	}
}
