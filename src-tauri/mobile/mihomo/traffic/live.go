package traffic

import "sync"

// LiveCounters retains only active proxy counter readers. Completed traffic is
// folded into two totals, independent of disk history and WebView polling.
type LiveCounters struct {
	mu               sync.Mutex
	active           map[string]func() (int64, int64)
	upload, download int64
}

func NewLiveCounters() *LiveCounters {
	return &LiveCounters{active: make(map[string]func() (int64, int64))}
}
func (c *LiveCounters) Begin(id string, read func() (int64, int64)) {
	if read == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.active[id]; !exists {
		c.active[id] = read
	}
}
func (c *LiveCounters) End(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if read, exists := c.active[id]; exists {
		up, down := read()
		c.upload += up
		c.download += down
		delete(c.active, id)
	}
}
func (c *LiveCounters) Total() (int64, int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	upload, download := c.upload, c.download
	for _, read := range c.active {
		up, down := read()
		upload += up
		download += down
	}
	return upload, download
}
