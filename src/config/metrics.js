/**
 * Application Metrics Collector
 * 
 * Collects real-time metrics about:
 * - HTTP requests (count, latency histogram, status codes)
 * - Socket.IO connections and events
 * - Database queries (count, latency)
 * - Business metrics (orders created, delivered, etc.)
 * 
 * Exposes metrics via getMetrics() for the /api/metrics endpoint.
 * Compatible with Prometheus text format and JSON.
 */

class MetricsCollector {
  constructor() {
    this.startTime = Date.now();

    // ─── HTTP Metrics ──────────────────────────────────────────────────────
    this.http = {
      totalRequests: 0,
      totalErrors: 0, // 5xx
      totalClientErrors: 0, // 4xx
      activeRequests: 0,
      latencies: [], // last 1000 request durations (ms)
      byMethod: {}, // { GET: count, POST: count, ... }
      byStatus: {}, // { 200: count, 404: count, ... }
      byPath: {}, // { '/api/orders': { count, totalMs } }
    };

    // ─── Socket.IO Metrics ─────────────────────────────────────────────────
    this.socket = {
      totalConnections: 0,
      activeConnections: 0,
      totalEvents: 0,
      totalDisconnects: 0,
      byEvent: {}, // { 'driver:update': count, ... }
    };

    // ─── Database Metrics ──────────────────────────────────────────────────
    this.db = {
      totalQueries: 0,
      totalErrors: 0,
      latencies: [], // last 500 query durations (ms)
    };

    // ─── Business Metrics ──────────────────────────────────────────────────
    this.business = {
      ordersCreated: 0,
      ordersDelivered: 0,
      ordersCancelled: 0,
      ordersAccepted: 0,
      pushSent: 0,
      whatsappSent: 0,
    };

    // Clean old latencies every 5 minutes
    setInterval(() => this._cleanup(), 300_000);
  }

  // ─── HTTP Tracking ─────────────────────────────────────────────────────────

  /**
   * Express middleware to track request metrics.
   */
  httpMiddleware() {
    const self = this;
    return (req, res, next) => {
      const start = Date.now();
      self.http.activeRequests++;
      self.http.totalRequests++;

      // Track by method
      self.http.byMethod[req.method] = (self.http.byMethod[req.method] || 0) + 1;

      res.on("finish", () => {
        self.http.activeRequests--;
        const duration = Date.now() - start;

        // Track latency
        self.http.latencies.push(duration);
        if (self.http.latencies.length > 1000) self.http.latencies.shift();

        // Track by status
        const status = res.statusCode;
        self.http.byStatus[status] = (self.http.byStatus[status] || 0) + 1;

        if (status >= 500) self.http.totalErrors++;
        if (status >= 400 && status < 500) self.http.totalClientErrors++;

        // Track by path (normalize dynamic segments)
        const path = self._normalizePath(req.route?.path || req.path);
        if (!self.http.byPath[path]) self.http.byPath[path] = { count: 0, totalMs: 0 };
        self.http.byPath[path].count++;
        self.http.byPath[path].totalMs += duration;
      });

      next();
    };
  }

  // ─── Socket.IO Tracking ────────────────────────────────────────────────────

  trackSocketConnection() {
    this.socket.totalConnections++;
    this.socket.activeConnections++;
  }

  trackSocketDisconnect() {
    this.socket.activeConnections--;
    this.socket.totalDisconnects++;
  }

  trackSocketEvent(eventName) {
    this.socket.totalEvents++;
    this.socket.byEvent[eventName] = (this.socket.byEvent[eventName] || 0) + 1;
  }

  // ─── Database Tracking ─────────────────────────────────────────────────────

  trackDbQuery(durationMs) {
    this.db.totalQueries++;
    this.db.latencies.push(durationMs);
    if (this.db.latencies.length > 500) this.db.latencies.shift();
  }

  trackDbError() {
    this.db.totalErrors++;
  }

  // ─── Business Tracking ─────────────────────────────────────────────────────

  trackOrderCreated() { this.business.ordersCreated++; }
  trackOrderDelivered() { this.business.ordersDelivered++; }
  trackOrderCancelled() { this.business.ordersCancelled++; }
  trackOrderAccepted() { this.business.ordersAccepted++; }
  trackPushSent() { this.business.pushSent++; }
  trackWhatsappSent() { this.business.whatsappSent++; }

  // ─── Get Metrics ──────────────────────────────────────────────────────────

  /**
   * Returns all metrics as a structured object.
   */
  getMetrics() {
    const uptimeMs = Date.now() - this.startTime;
    const mem = process.memoryUsage();

    return {
      uptime_seconds: Math.round(uptimeMs / 1000),
      uptime_human: this._formatUptime(uptimeMs),

      // Process
      process: {
        memory_rss_mb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
        memory_heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
        memory_heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
        cpu_user_ms: process.cpuUsage().user / 1000,
        cpu_system_ms: process.cpuUsage().system / 1000,
        pid: process.pid,
        node_version: process.version,
      },

      // HTTP
      http: {
        total_requests: this.http.totalRequests,
        active_requests: this.http.activeRequests,
        total_errors_5xx: this.http.totalErrors,
        total_client_errors_4xx: this.http.totalClientErrors,
        requests_per_second: this._requestsPerSecond(),
        latency: this._calculatePercentiles(this.http.latencies),
        by_method: this.http.byMethod,
        by_status: this.http.byStatus,
        slowest_endpoints: this._slowestEndpoints(),
      },

      // Socket.IO
      socket: {
        active_connections: this.socket.activeConnections,
        total_connections: this.socket.totalConnections,
        total_events: this.socket.totalEvents,
        total_disconnects: this.socket.totalDisconnects,
        events_per_second: this._eventsPerSecond(),
        top_events: this._topEvents(),
      },

      // Database
      database: {
        total_queries: this.db.totalQueries,
        total_errors: this.db.totalErrors,
        latency: this._calculatePercentiles(this.db.latencies),
      },

      // Business
      business: this.business,

      // Timestamp
      collected_at: new Date().toISOString(),
    };
  }

  /**
   * Returns metrics in Prometheus text format.
   */
  getPrometheusMetrics() {
    const m = this.getMetrics();
    const lines = [];

    lines.push(`# HELP app_uptime_seconds Application uptime in seconds`);
    lines.push(`# TYPE app_uptime_seconds gauge`);
    lines.push(`app_uptime_seconds ${m.uptime_seconds}`);

    lines.push(`# HELP app_http_requests_total Total HTTP requests`);
    lines.push(`# TYPE app_http_requests_total counter`);
    lines.push(`app_http_requests_total ${m.http.total_requests}`);

    lines.push(`# HELP app_http_errors_total Total 5xx errors`);
    lines.push(`# TYPE app_http_errors_total counter`);
    lines.push(`app_http_errors_total ${m.http.total_errors_5xx}`);

    lines.push(`# HELP app_http_active_requests Active HTTP requests`);
    lines.push(`# TYPE app_http_active_requests gauge`);
    lines.push(`app_http_active_requests ${m.http.active_requests}`);

    lines.push(`# HELP app_http_latency_p50_ms HTTP latency p50`);
    lines.push(`# TYPE app_http_latency_p50_ms gauge`);
    lines.push(`app_http_latency_p50_ms ${m.http.latency.p50}`);

    lines.push(`# HELP app_http_latency_p95_ms HTTP latency p95`);
    lines.push(`# TYPE app_http_latency_p95_ms gauge`);
    lines.push(`app_http_latency_p95_ms ${m.http.latency.p95}`);

    lines.push(`# HELP app_http_latency_p99_ms HTTP latency p99`);
    lines.push(`# TYPE app_http_latency_p99_ms gauge`);
    lines.push(`app_http_latency_p99_ms ${m.http.latency.p99}`);

    lines.push(`# HELP app_socket_active_connections Active WebSocket connections`);
    lines.push(`# TYPE app_socket_active_connections gauge`);
    lines.push(`app_socket_active_connections ${m.socket.active_connections}`);

    lines.push(`# HELP app_socket_events_total Total Socket.IO events processed`);
    lines.push(`# TYPE app_socket_events_total counter`);
    lines.push(`app_socket_events_total ${m.socket.total_events}`);

    lines.push(`# HELP app_db_queries_total Total database queries`);
    lines.push(`# TYPE app_db_queries_total counter`);
    lines.push(`app_db_queries_total ${m.database.total_queries}`);

    lines.push(`# HELP app_db_errors_total Total database errors`);
    lines.push(`# TYPE app_db_errors_total counter`);
    lines.push(`app_db_errors_total ${m.database.total_errors}`);

    lines.push(`# HELP app_memory_rss_mb Process RSS memory in MB`);
    lines.push(`# TYPE app_memory_rss_mb gauge`);
    lines.push(`app_memory_rss_mb ${m.process.memory_rss_mb}`);

    lines.push(`# HELP app_orders_created_total Orders created since startup`);
    lines.push(`# TYPE app_orders_created_total counter`);
    lines.push(`app_orders_created_total ${m.business.ordersCreated}`);

    lines.push(`# HELP app_orders_delivered_total Orders delivered since startup`);
    lines.push(`# TYPE app_orders_delivered_total counter`);
    lines.push(`app_orders_delivered_total ${m.business.ordersDelivered}`);

    return lines.join("\n") + "\n";
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  _calculatePercentiles(latencies) {
    if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, max: 0 };
    const sorted = [...latencies].sort((a, b) => a - b);
    const len = sorted.length;
    return {
      p50: sorted[Math.floor(len * 0.5)] || 0,
      p95: sorted[Math.floor(len * 0.95)] || 0,
      p99: sorted[Math.floor(len * 0.99)] || 0,
      avg: Math.round(sorted.reduce((a, b) => a + b, 0) / len),
      max: sorted[len - 1] || 0,
    };
  }

  _requestsPerSecond() {
    const uptimeS = (Date.now() - this.startTime) / 1000;
    if (uptimeS < 1) return 0;
    return Math.round((this.http.totalRequests / uptimeS) * 100) / 100;
  }

  _eventsPerSecond() {
    const uptimeS = (Date.now() - this.startTime) / 1000;
    if (uptimeS < 1) return 0;
    return Math.round((this.socket.totalEvents / uptimeS) * 100) / 100;
  }

  _slowestEndpoints() {
    return Object.entries(this.http.byPath)
      .map(([path, data]) => ({ path, avg_ms: Math.round(data.totalMs / data.count), count: data.count }))
      .sort((a, b) => b.avg_ms - a.avg_ms)
      .slice(0, 5);
  }

  _topEvents() {
    return Object.entries(this.socket.byEvent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([event, count]) => ({ event, count }));
  }

  _normalizePath(path) {
    // Replace numeric IDs with :id
    return path.replace(/\/\d+/g, "/:id").replace(/\/ORD-[A-Z0-9]+/gi, "/:code");
  }

  _formatUptime(ms) {
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }

  _cleanup() {
    // Keep only last 1000 HTTP latencies and 500 DB latencies
    if (this.http.latencies.length > 1000) {
      this.http.latencies = this.http.latencies.slice(-1000);
    }
    if (this.db.latencies.length > 500) {
      this.db.latencies = this.db.latencies.slice(-500);
    }
    // Trim byPath to top 50
    const paths = Object.entries(this.http.byPath);
    if (paths.length > 50) {
      const top = paths.sort((a, b) => b[1].count - a[1].count).slice(0, 50);
      this.http.byPath = Object.fromEntries(top);
    }
  }
}

// Singleton
export const metrics = new MetricsCollector();
export default metrics;
