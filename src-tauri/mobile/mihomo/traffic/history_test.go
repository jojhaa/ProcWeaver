package traffic

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestDailyGroupLimitPreservesTotals(t *testing.T) {
	l, err := Open(filepath.Join(t.TempDir(), "history.db"), time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	now := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	l.now = func() time.Time { return now }
	for n := 0; n < 2200; n++ {
		id := fmt.Sprint(n)
		l.Begin(id, "pkg"+id, "exit"+id, n%2 == 0, func() (int64, int64) { return 5, 7 })
		l.End(id)
		if n == 1100 {
			if err = l.Tick(true); err != nil {
				t.Fatal(err)
			}
		}
	}
	r, err := l.Query(now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) > maxDailyGroups+2 {
		t.Fatalf("unbounded rows: %d", len(r.Rows))
	}
	var up, down, count int64
	for _, row := range r.Rows {
		up += row.Upload
		down += row.Download
		count += row.Connections
	}
	if up != 11000 || down != 15400 || count != 2200 {
		t.Fatalf("overflow lost counters: %d %d %d", up, down, count)
	}
}

func TestShortConnectionsPersistenceAndNoDoubleCount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	now := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	l, err := Open(path, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	l.now = func() time.Time { return now }
	var up, down int64
	l.Begin("short", "com.example.app", "test-exit", true, func() (int64, int64) { return up, down })
	up, down = 101, 503
	l.End("short")
	if len(l.active) != 0 {
		t.Fatal("closed tracker retained")
	}
	for i := 0; i < 3; i++ {
		if err = l.Tick(true); err != nil {
			t.Fatal(err)
		}
	}
	if err = l.Close(); err != nil {
		t.Fatal(err)
	}
	l, err = Open(path, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	l.now = func() time.Time { return now }
	r, err := l.Query(now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 1 || r.Rows[0].Upload != 101 || r.Rows[0].Download != 503 || r.Rows[0].Connections != 1 || !r.Rows[0].Proxied {
		t.Fatalf("incorrect counters: %+v", r)
	}
}
func TestDateBoundaryRetentionAndClearLiveConnection(t *testing.T) {
	zone := time.FixedZone("test", 8*3600)
	now := time.Date(2026, 9, 25, 23, 59, 0, 0, zone)
	l, err := Open(filepath.Join(t.TempDir(), "history.db"), zone)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	l.now = func() time.Time { return now }
	var up, down int64
	l.Begin("long", "pkg", "DIRECT", false, func() (int64, int64) { return up, down })
	up = 100
	if err = l.Tick(true); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)
	up = 150
	down = 10
	if err = l.Tick(true); err != nil {
		t.Fatal(err)
	}
	start := time.Date(2026, 9, 26, 0, 0, 0, 0, zone)
	r, err := l.Query(start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 1 || r.Rows[0].Upload != 50 || r.Rows[0].Download != 10 {
		t.Fatalf("bad day split: %+v", r)
	}
	if err = l.Clear(); err != nil {
		t.Fatal(err)
	}
	up = 170
	l.End("long")
	r, err = l.Query(start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 1 || r.Rows[0].Upload != 20 || r.Rows[0].Download != 0 {
		t.Fatalf("clear recounted old bytes: %+v", r)
	}
	now = now.AddDate(0, 0, RetentionDays+1)
	r, err = l.Query(start, start.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Rows) != 0 {
		t.Fatal("expired history retained")
	}
	if _, err = l.Query(now, now.Add(33*24*time.Hour)); err == nil {
		t.Fatal("unbounded query accepted")
	}
}

func TestPeriodicFlushPersistsEvenAfterRecentQuery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.db")
	now := time.Date(2026, 9, 26, 12, 0, 0, 0, time.UTC)
	l, err := Open(path, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	l.now = func() time.Time { return now }
	var upload int64 = 10
	l.Begin("active", "pkg", "exit", true, func() (int64, int64) { return upload, 0 })
	if _, err = l.Query(now.Add(-time.Hour), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	now = now.Add(59 * time.Second)
	upload = 30
	if err = l.Tick(true); err != nil {
		t.Fatal(err)
	}
	// Reopen without the ledger's shutdown flush: the scheduled tick must
	// already have persisted the current counter even after a recent query.
	if err = l.db.Close(); err != nil {
		t.Fatal(err)
	}
	l.db = nil
	l, err = Open(path, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	l.now = func() time.Time { return now }
	r, err := l.Query(now.Add(-time.Hour), now.Add(time.Hour))
	if err != nil || len(r.Rows) != 1 || r.Rows[0].Upload != 30 {
		t.Fatalf("scheduled flush lost traffic: %+v, %v", r, err)
	}
}
