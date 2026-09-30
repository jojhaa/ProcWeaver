// Package traffic stores aggregate payload counters, never destinations or credentials.
package traffic

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	bolt "github.com/metacubex/bbolt"
)

const RetentionDays = 90
const maxGroups = 4096
const maxDailyGroups = 1024

var bucket = []byte("daily-v1")

type Row struct {
	Date        string `json:"date"`
	Package     string `json:"packageName"`
	Outbound    string `json:"outbound"`
	Proxied     bool   `json:"proxied"`
	Upload      int64  `json:"upload"`
	Download    int64  `json:"download"`
	Connections int64  `json:"connections"`
}
type Result struct {
	Rows          []Row  `json:"rows"`
	RetentionDays int    `json:"retentionDays"`
	Error         string `json:"error,omitempty"`
}
type connection struct {
	row      Row
	read     func() (int64, int64)
	up, down int64
	closed   bool
}
type Ledger struct {
	mu        sync.Mutex
	db        *bolt.DB
	zone      *time.Location
	now       func() time.Time
	active    map[string]*connection
	pending   map[string]Row
	lastError string
	lastFlush time.Time
	lastPrune string
}

func Open(path string, zone *time.Location) (*Ledger, error) {
	if zone == nil {
		zone = time.UTC
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(path, 0600, &bolt.Options{Timeout: time.Second})
	if err != nil {
		return nil, err
	}
	if err = db.Update(func(tx *bolt.Tx) error { _, err := tx.CreateBucketIfNotExists(bucket); return err }); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Ledger{db: db, zone: zone, now: time.Now, active: map[string]*connection{}, pending: map[string]Row{}}, nil
}
func clean(value string) string {
	value = strings.ReplaceAll(value, "\x00", "")
	if len(value) > 256 {
		return "其他"
	}
	return value
}
func key(row Row) string {
	kind := "direct"
	if row.Proxied {
		kind = "proxy"
	}
	return row.Date + "\x00" + row.Package + "\x00" + row.Outbound + "\x00" + kind
}
func (l *Ledger) add(row Row) {
	k := key(row)
	if _, ok := l.pending[k]; !ok && len(l.pending) >= maxGroups {
		row.Package = "@other"
		row.Outbound = "其他"
		k = key(row)
	}
	previous := l.pending[k]
	row.Upload += previous.Upload
	row.Download += previous.Download
	row.Connections += previous.Connections
	l.pending[k] = row
}

// Begin/End only touch in-memory counters. No disk I/O occurs on packet threads.
func (l *Ledger) Begin(id, pkg, outbound string, proxied bool, read func() (int64, int64)) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db == nil || read == nil {
		return
	}
	if _, exists := l.active[id]; exists {
		return
	}
	if pkg == "" {
		pkg = "@unknown"
	}
	if outbound == "" {
		outbound = "未知出口"
	}
	l.active[id] = &connection{row: Row{Package: clean(pkg), Outbound: clean(outbound), Proxied: proxied, Connections: 1}, read: read}
}
func (l *Ledger) End(id string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if item := l.active[id]; item != nil {
		item.closed = true
		l.collectOne(id, item, l.now().In(l.zone).Format("2006-01-02"))
	}
}
func (l *Ledger) collect() {
	date := l.now().In(l.zone).Format("2006-01-02")
	for id, item := range l.active {
		l.collectOne(id, item, date)
	}
}
func (l *Ledger) collectOne(id string, item *connection, date string) {
	up, down := item.read()
	row := item.row
	row.Date = date
	if up >= item.up {
		row.Upload = up - item.up
	}
	if down >= item.down {
		row.Download = down - item.down
	}
	if row.Upload > 0 || row.Download > 0 || row.Connections > 0 {
		l.add(row)
	}
	item.up = up
	item.down = down
	item.row.Connections = 0
	if item.closed {
		delete(l.active, id)
	}
}
func (l *Ledger) flush() error {
	today := l.now().In(l.zone).Format("2006-01-02")
	if len(l.pending) == 0 && l.lastPrune == today {
		return nil
	}
	cutoff := l.now().In(l.zone).AddDate(0, 0, -RetentionDays+1).Format("2006-01-02")
	err := l.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucket)
		c := b.Cursor()
		for k, _ := c.First(); k != nil; k, _ = c.Next() {
			if len(k) < 10 || string(k[:10]) < cutoff {
				if err := c.Delete(); err != nil {
					return err
				}
			} else {
				break
			}
		}
		dailyCounts := map[string]int{}
		for k, row := range l.pending {
			if row.Date < cutoff {
				continue
			}
			if b.Get([]byte(k)) == nil {
				count, known := dailyCounts[row.Date]
				if !known {
					prefix := row.Date + "\x00"
					scan := b.Cursor()
					for name, _ := scan.Seek([]byte(prefix)); name != nil && strings.HasPrefix(string(name), prefix); name, _ = scan.Next() {
						count++
					}
				}
				if count >= maxDailyGroups {
					row.Package = "@other"
					row.Outbound = "其他"
					k = key(row)
				} else {
					count++
				}
				dailyCounts[row.Date] = count
			}
			var previous Row
			if raw := b.Get([]byte(k)); raw != nil {
				if err := json.Unmarshal(raw, &previous); err != nil {
					return err
				}
			}
			row.Upload += previous.Upload
			row.Download += previous.Download
			row.Connections += previous.Connections
			raw, err := json.Marshal(row)
			if err != nil {
				return err
			}
			if err = b.Put([]byte(k), raw); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		l.lastError = "历史记录写入失败，暂存在内存"
		return err
	}
	l.pending = map[string]Row{}
	l.lastError = ""
	l.lastFlush = l.now()
	l.lastPrune = today
	return nil
}

// Tick samples existing counter pointers, retaining short connections after close.
// Persistence is batched once per minute; query and normal shutdown flush early.
func (l *Ledger) Tick(force bool) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db == nil {
		return errors.New("history closed")
	}
	l.collect()
	if force || l.now().Sub(l.lastFlush) >= time.Minute {
		return l.flush()
	}
	return nil
}
func (l *Ledger) Query(start, end time.Time) (Result, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	result := Result{Rows: []Row{}, RetentionDays: RetentionDays}
	if l.db == nil || !end.After(start) || end.Sub(start) > 32*24*time.Hour {
		return result, errors.New("invalid history range")
	}
	l.collect()
	if err := l.flush(); err != nil {
		return result, err
	}
	first, last := start.In(l.zone).Format("2006-01-02"), end.Add(-time.Millisecond).In(l.zone).Format("2006-01-02")
	groups := map[string]Row{}
	err := l.db.View(func(tx *bolt.Tx) error {
		c := tx.Bucket(bucket).Cursor()
		for k, v := c.Seek([]byte(first)); k != nil; k, v = c.Next() {
			if len(k) < 10 {
				continue
			}
			if string(k[:10]) > last {
				break
			}
			var row Row
			if err := json.Unmarshal(v, &row); err != nil {
				return err
			}
			row.Date = ""
			group := key(row)
			if _, ok := groups[group]; !ok && len(groups) >= maxGroups {
				row.Package = "@other"
				row.Outbound = "其他"
				group = key(row)
			}
			previous := groups[group]
			row.Upload += previous.Upload
			row.Download += previous.Download
			row.Connections += previous.Connections
			groups[group] = row
		}
		return nil
	})
	for _, row := range groups {
		result.Rows = append(result.Rows, row)
	}
	sort.Slice(result.Rows, func(i, j int) bool {
		return result.Rows[i].Upload+result.Rows[i].Download > result.Rows[j].Upload+result.Rows[j].Download
	})
	result.Error = l.lastError
	return result, err
}
func (l *Ledger) Clear() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db == nil {
		return errors.New("history closed")
	}
	if err := l.db.Update(func(tx *bolt.Tx) error {
		if err := tx.DeleteBucket(bucket); err != nil {
			return err
		}
		_, err := tx.CreateBucket(bucket)
		return err
	}); err != nil {
		return err
	}
	l.pending = map[string]Row{}
	for _, item := range l.active {
		item.up, item.down = item.read()
		item.row.Connections = 0
	}
	return nil
}
func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db == nil {
		return nil
	}
	l.collect()
	err := l.flush()
	closeErr := l.db.Close()
	l.db = nil
	l.active = nil
	if err != nil {
		return err
	}
	return closeErr
}
