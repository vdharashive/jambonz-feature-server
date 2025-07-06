const {Pool, Client} = require('undici');
const parseUrl = require('parse-url');
const {HTTP_POOLSIZE, HTTP_PIPELINING} = require('../config');

/**
 * Optimized connection pool manager for better performance
 * and memory management
 */
class ConnectionPoolManager {
  constructor(options = {}) {
    this.pools = new Map();
    this.maxConnections = options.maxConnections || HTTP_POOLSIZE || 10;
    this.pipelining = options.pipelining || HTTP_PIPELINING || 1;
    this.keepAliveTimeout = options.keepAliveTimeout || 30000;
    this.idleTimeout = options.idleTimeout || 300000;
    this.cleanupInterval = options.cleanupInterval || 60000;
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(this.cleanup.bind(this), this.cleanupInterval);
    
    // Track pool usage
    this.poolStats = new Map();
  }

  /**
   * Get or create a connection pool for a base URL
   * @param {string} baseUrl - The base URL for the pool
   * @returns {Pool} The connection pool
   */
  getPool(baseUrl) {
    if (!this.pools.has(baseUrl)) {
      this.createPool(baseUrl);
    }
    
    // Update usage stats
    const stats = this.poolStats.get(baseUrl) || {
      created: Date.now(),
      lastUsed: Date.now(),
      requestCount: 0
    };
    stats.lastUsed = Date.now();
    stats.requestCount++;
    this.poolStats.set(baseUrl, stats);
    
    return this.pools.get(baseUrl);
  }

  /**
   * Create a new connection pool
   * @param {string} baseUrl - The base URL for the pool
   */
  createPool(baseUrl) {
    const pool = new Pool(baseUrl, {
      connections: this.maxConnections,
      pipelining: this.pipelining,
      keepAliveTimeout: this.keepAliveTimeout,
      bodyTimeout: 30000,
      headersTimeout: 30000,
      connect: {
        timeout: 10000,
        rejectUnauthorized: false
      }
    });

    // Add error handling
    pool.on('disconnect', (url, targets, err) => {
      console.warn(`Pool disconnected from ${url}:`, err?.message);
    });

    pool.on('connect', (url, targets) => {
      console.debug(`Pool connected to ${url}`);
    });

    this.pools.set(baseUrl, pool);
    
    // Initialize stats
    this.poolStats.set(baseUrl, {
      created: Date.now(),
      lastUsed: Date.now(),
      requestCount: 0
    });
  }

  /**
   * Get a client for a specific URL (fallback for non-pooled requests)
   * @param {string} url - The full URL
   * @returns {Client} The client instance
   */
  getClient(url) {
    const parsedUrl = parseUrl(url);
    const baseUrl = `${parsedUrl.protocol}://${parsedUrl.resource}${parsedUrl.port ? ':' + parsedUrl.port : ''}`;
    
    return new Client(baseUrl, {
      keepAliveTimeout: this.keepAliveTimeout,
      bodyTimeout: 30000,
      headersTimeout: 30000
    });
  }

  /**
   * Clean up idle pools
   */
  cleanup() {
    const now = Date.now();
    const idleThreshold = now - this.idleTimeout;
    
    for (const [baseUrl, stats] of this.poolStats) {
      if (stats.lastUsed < idleThreshold) {
        this.destroyPool(baseUrl);
      }
    }
  }

  /**
   * Destroy a specific pool
   * @param {string} baseUrl - The base URL of the pool to destroy
   */
  destroyPool(baseUrl) {
    const pool = this.pools.get(baseUrl);
    if (pool) {
      pool.close();
      this.pools.delete(baseUrl);
      this.poolStats.delete(baseUrl);
      console.debug(`Destroyed idle pool for ${baseUrl}`);
    }
  }

  /**
   * Get pool statistics
   * @returns {Object} Pool statistics
   */
  getStats() {
    const stats = {
      totalPools: this.pools.size,
      pools: {}
    };
    
    for (const [baseUrl, poolStats] of this.poolStats) {
      stats.pools[baseUrl] = {
        ...poolStats,
        age: Date.now() - poolStats.created,
        idle: Date.now() - poolStats.lastUsed
      };
    }
    
    return stats;
  }

  /**
   * Destroy all pools and cleanup
   */
  destroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    
    for (const [baseUrl, pool] of this.pools) {
      try {
        pool.close();
      } catch (err) {
        console.warn(`Error closing pool ${baseUrl}:`, err.message);
      }
    }
    
    this.pools.clear();
    this.poolStats.clear();
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton connection pool manager
 * @param {Object} options - Configuration options
 * @returns {ConnectionPoolManager} The singleton instance
 */
function getConnectionPoolManager(options = {}) {
  if (!instance) {
    instance = new ConnectionPoolManager(options);
  }
  return instance;
}

module.exports = {
  ConnectionPoolManager,
  getConnectionPoolManager
};