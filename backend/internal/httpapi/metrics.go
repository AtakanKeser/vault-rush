package httpapi

import (
	"net/http"
	"sort"
	"sync"
	"time"
)

var latencyBucketsMs = []float64{5, 10, 25, 50, 100, 250, 500, 1000, 2500}

// Metrics is a dependency-free request metrics registry rendered as JSON on
// /metrics. A Prometheus exporter would be a drop-in replacement; JSON keeps
// the local stack dependency-free and is what the admin panel consumes.
type Metrics struct {
	mu      sync.Mutex
	total   int64
	byClass map[string]int64
	buckets []int64 // cumulative counts per latencyBucketsMs, last = +Inf
	sumMs   float64
	routes  map[string]*routeStat
	started time.Time
}

type routeStat struct {
	Count   int64   `json:"count"`
	Errors  int64   `json:"errors"`
	SumMs   float64 `json:"-"`
	AvgMs   float64 `json:"avgMs"`
	MaxMs   float64 `json:"maxMs"`
	buckets []int64
	P50Ms   float64 `json:"p50Ms"`
	P95Ms   float64 `json:"p95Ms"`
	P99Ms   float64 `json:"p99Ms"`
}

// NewMetrics creates a registry.
func NewMetrics() *Metrics {
	return &Metrics{byClass: map[string]int64{}, buckets: make([]int64, len(latencyBucketsMs)+1), routes: map[string]*routeStat{}, started: time.Now()}
}

type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Observe records one request.
func (m *Metrics) Observe(route string, status int, d time.Duration) {
	ms := float64(d.Microseconds()) / 1000
	m.mu.Lock()
	defer m.mu.Unlock()
	m.total++
	m.sumMs += ms
	class := "2xx"
	switch {
	case status >= 500:
		class = "5xx"
	case status >= 400:
		class = "4xx"
	case status >= 300:
		class = "3xx"
	}
	m.byClass[class]++
	idx := bucketIndex(ms)
	m.buckets[idx]++
	rs, ok := m.routes[route]
	if !ok {
		rs = &routeStat{buckets: make([]int64, len(latencyBucketsMs)+1)}
		m.routes[route] = rs
	}
	rs.Count++
	rs.SumMs += ms
	if ms > rs.MaxMs {
		rs.MaxMs = ms
	}
	if status >= 500 {
		rs.Errors++
	}
	rs.buckets[idx]++
}

func bucketIndex(ms float64) int {
	for i, b := range latencyBucketsMs {
		if ms <= b {
			return i
		}
	}
	return len(latencyBucketsMs)
}

// quantile estimates a quantile from histogram buckets (upper bound of the
// bucket containing the quantile; good enough for a dashboard).
func quantile(buckets []int64, q float64) float64 {
	var total int64
	for _, c := range buckets {
		total += c
	}
	if total == 0 {
		return 0
	}
	target := int64(float64(total)*q + 0.5)
	var acc int64
	for i, c := range buckets {
		acc += c
		if acc >= target {
			if i < len(latencyBucketsMs) {
				return latencyBucketsMs[i]
			}
			return latencyBucketsMs[len(latencyBucketsMs)-1] * 2
		}
	}
	return latencyBucketsMs[len(latencyBucketsMs)-1]
}

// Snapshot renders the registry.
func (m *Metrics) Snapshot() map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	hist := map[string]int64{}
	for i, b := range latencyBucketsMs {
		hist[formatBucket(b)] = m.buckets[i]
	}
	hist["+Inf"] = m.buckets[len(latencyBucketsMs)]
	routes := map[string]routeStat{}
	keys := make([]string, 0, len(m.routes))
	for k := range m.routes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		rs := *m.routes[k]
		if rs.Count > 0 {
			rs.AvgMs = round2(rs.SumMs / float64(rs.Count))
		}
		rs.MaxMs = round2(rs.MaxMs)
		rs.P50Ms = quantile(rs.buckets, 0.50)
		rs.P95Ms = quantile(rs.buckets, 0.95)
		rs.P99Ms = quantile(rs.buckets, 0.99)
		routes[k] = rs
	}
	avg := 0.0
	if m.total > 0 {
		avg = round2(m.sumMs / float64(m.total))
	}
	// Nested shapes consumed by the LiveOps panel; flat keys kept for scripts.
	buckets := make([]map[string]any, 0, len(latencyBucketsMs)+1)
	for i, b := range latencyBucketsMs {
		buckets = append(buckets, map[string]any{"le": b, "count": m.buckets[i]})
	}
	buckets = append(buckets, map[string]any{"le": "+Inf", "count": m.buckets[len(latencyBucketsMs)]})
	byRoute := make(map[string]int64, len(routes))
	for k, rs := range routes {
		byRoute[k] = rs.Count
	}
	return map[string]any{
		"requestsTotal":    m.total,
		"requestsByClass":  m.byClass,
		"latencyAvgMs":     avg,
		"latencyP50Ms":     quantile(m.buckets, 0.50),
		"latencyP95Ms":     quantile(m.buckets, 0.95),
		"latencyP99Ms":     quantile(m.buckets, 0.99),
		"latencyHistogram": hist,
		"routes":           routes,
		"uptimeSeconds":    int64(time.Since(m.started).Seconds()),
		"latency": map[string]any{
			"unit": "ms", "buckets": buckets, "avgMs": avg,
			"p50Ms": quantile(m.buckets, 0.50), "p95Ms": quantile(m.buckets, 0.95), "p99Ms": quantile(m.buckets, 0.99),
		},
		"requests": map[string]any{"total": m.total, "byStatus": m.byClass, "byRoute": byRoute},
	}
}

func formatBucket(ms float64) string {
	if ms >= 1000 {
		return "le_" + itoa(int(ms/1000)) + "s"
	}
	return "le_" + itoa(int(ms)) + "ms"
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }
