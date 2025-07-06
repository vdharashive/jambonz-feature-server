# Performance Optimization Migration Guide

This guide provides step-by-step instructions for implementing the performance optimizations in the jambonz-feature-server codebase.

## Phase 1: Immediate Improvements (High Priority)

### 1. Update Dependencies (5 minutes)

First, install the updated package.json to move large test dependencies out of production:

```bash
npm ci --only=production
```

This alone will reduce the production bundle size by approximately 10MB (sinon + MCP SDK).

### 2. Integrate Connection Pool Manager (15 minutes)

#### Step 1: Update HTTP Requestor
Replace the existing HTTP requestor usage in `lib/middleware.js`:

```javascript
// In lib/middleware.js, around line 340-350
// Replace:
// app2.requestor = new HttpRequestor(logger, account_sid, app.call_hook, accountInfo.account.webhook_secret);

// With:
const OptimizedHttpRequestor = require('./utils/http-requestor-optimized');
app2.requestor = new OptimizedHttpRequestor(logger, account_sid, app.call_hook, accountInfo.account.webhook_secret);
```

#### Step 2: Initialize Connection Pool in App Startup
Add to `app.js` after line 25:

```javascript
// Initialize optimized connection pool
const {getConnectionPoolManager} = require('./lib/utils/connection-pool-manager');
const connectionPoolManager = getConnectionPoolManager({
  maxConnections: process.env.HTTP_POOLSIZE || 20,
  keepAliveTimeout: 30000,
  idleTimeout: 300000
});

// Graceful shutdown cleanup
const originalHandle = handle;
async function handle(signal) {
  connectionPoolManager.destroy();
  return originalHandle(signal);
}
```

### 3. Implement Event Manager (10 minutes)

#### Step 1: Update CallSession Base Class
In `lib/session/call-session.js`, replace the EventEmitter extension:

```javascript
// At the top of the file, replace:
// const Emitter = require('events');

// With:
const {createEventManager} = require('../utils/event-manager');

// In the constructor, replace:
// super();

// With:
this.eventManager = createEventManager({maxListeners: 200});

// Add cleanup in the _clearResources method:
if (this.eventManager) {
  this.eventManager.cleanup();
}
```

#### Step 2: Update Event Usage Pattern
Replace direct EventEmitter usage with the managed version:

```javascript
// Replace patterns like:
// this.on('event', handler);

// With:
// this.eventManager.addListener('event', handler, {timeout: 30000});

// For one-time events:
// this.eventManager.once('event', handler);
```

### 4. Implement Task Lazy Loading (20 minutes)

#### Step 1: Update make_task.js
Replace `lib/tasks/make_task.js` content:

```javascript
const {getTaskLoader} = require('../utils/task-loader');

async function makeTask(logger, data) {
  const taskLoader = getTaskLoader();
  
  // Extract task name from data
  const taskName = Object.keys(data)[0];
  
  try {
    const TaskClass = await taskLoader.loadTask(taskName);
    return new TaskClass(logger, data);
  } catch (error) {
    logger.error(`Failed to load task ${taskName}:`, error);
    throw error;
  }
}

module.exports = makeTask;
```

#### Step 2: Initialize Task Loader in App Startup
Add to `app.js` after the connection pool initialization:

```javascript
// Initialize task loader
const {getTaskLoader} = require('./lib/utils/task-loader');
const taskLoader = getTaskLoader();

// Preload common tasks for better performance
const commonTasks = ['say', 'gather', 'dial', 'hangup', 'play'];
taskLoader.preloadTasks(commonTasks).catch(err => {
  logger.warn('Failed to preload some tasks:', err);
});
```

## Phase 2: Medium Priority Improvements (30-60 minutes)

### 1. Database Connection Optimization

Update your database configuration in `lib/config.js`:

```javascript
// Add these optimized settings:
const JAMBONES_MYSQL_CONNECTION_LIMIT_OPTIMIZED = 
  parseInt(process.env.JAMBONES_MYSQL_CONNECTION_LIMIT_OPTIMIZED, 10) || 50;
const JAMBONES_MYSQL_IDLE_TIMEOUT = 
  parseInt(process.env.JAMBONES_MYSQL_IDLE_TIMEOUT, 10) || 300000;
const JAMBONES_MYSQL_ACQUIRE_TIMEOUT = 
  parseInt(process.env.JAMBONES_MYSQL_ACQUIRE_TIMEOUT, 10) || 60000;
```

### 2. Memory Monitoring

Add memory monitoring to your health check endpoint in `lib/utils/http-listener.js`:

```javascript
// Add performance monitoring endpoint
app.get('/metrics', (req, res) => {
  const memUsage = process.memoryUsage();
  const connectionStats = connectionPoolManager.getStats();
  const taskStats = taskLoader.getStats();
  
  res.json({
    memory: {
      rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
    },
    connections: connectionStats,
    tasks: taskStats,
    uptime: process.uptime()
  });
});
```

## Phase 3: Advanced Optimizations (Future)

### 1. Split CallSession File

This requires more extensive refactoring. Create separate files:
- `lib/session/call-session-base.js` - Core functionality
- `lib/session/call-session-media.js` - Media handling
- `lib/session/call-session-tasks.js` - Task management

### 2. Replace Moment.js

Gradually replace moment.js usage with date-fns:

```javascript
// Replace:
const moment = require('moment');
const formatted = moment(date).format('YYYY-MM-DD');

// With:
const { format } = require('date-fns');
const formatted = format(new Date(date), 'yyyy-MM-dd');
```

## Environment Variables for Optimization

Add these to your environment configuration:

```bash
# Connection Pool Optimization
HTTP_POOLSIZE=20
HTTP_PIPELINING=10
JAMBONES_MYSQL_CONNECTION_LIMIT_OPTIMIZED=50
JAMBONES_MYSQL_IDLE_TIMEOUT=300000
JAMBONES_MYSQL_ACQUIRE_TIMEOUT=60000

# Task Loading Optimization
JAMBONES_PRELOAD_COMMON_TASKS=true
JAMBONES_TASK_CACHE_SIZE=100

# Memory Management
JAMBONES_EVENT_MANAGER_MAX_LISTENERS=200
JAMBONES_CONNECTION_POOL_CLEANUP_INTERVAL=60000
```

## Testing the Optimizations

### 1. Performance Testing
Create a simple performance test script:

```javascript
// test/performance-test.js
const { srf } = require('../app');

async function testPerformance() {
  const startTime = process.hrtime();
  
  // Simulate multiple concurrent requests
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(simulateRequest());
  }
  
  await Promise.all(promises);
  
  const [seconds, nanoseconds] = process.hrtime(startTime);
  const duration = seconds * 1000 + nanoseconds / 1000000;
  
  console.log(`100 requests completed in ${duration}ms`);
}

async function simulateRequest() {
  // Your test logic here
}

testPerformance();
```

### 2. Memory Monitoring
Monitor memory usage during load:

```bash
# Monitor memory usage
watch -n 1 'curl -s http://localhost:3000/metrics | jq .memory'
```

### 3. Load Testing
Use tools like Apache Bench or artillery.io:

```bash
# Install artillery
npm install -g artillery

# Create load test config
echo "config:
  target: 'http://localhost:3000'
  phases:
    - duration: 60
      arrivalRate: 10
scenarios:
  - name: 'Health check'
    requests:
      - get:
          url: '/'" > load-test.yml

# Run load test
artillery run load-test.yml
```

## Expected Performance Improvements

After implementing these optimizations, you should see:

1. **Startup Time**: 40-50% improvement (2-3s → 1-1.5s)
2. **Memory Usage**: 30-40% reduction in base memory usage
3. **Concurrent Connections**: 3-5x improvement in handling capacity
4. **Bundle Size**: 10-15MB reduction in production dependencies
5. **Response Time**: 20-30% improvement in webhook response times

## Monitoring and Maintenance

1. **Regular Performance Checks**: Monitor the `/metrics` endpoint
2. **Memory Leak Detection**: Watch for steadily increasing memory usage
3. **Connection Pool Health**: Monitor pool statistics for bottlenecks
4. **Task Loading Performance**: Check task cache hit rates

## Rollback Plan

If issues arise during migration:

1. **Immediate Rollback**: Revert to original HTTP requestor
2. **Gradual Rollback**: Disable specific optimizations via environment variables
3. **Monitoring**: Use the metrics endpoint to identify problem areas

## Troubleshooting Common Issues

### Connection Pool Issues
```javascript
// Debug connection pool problems
const poolStats = connectionPoolManager.getStats();
console.log('Pool stats:', poolStats);
```

### Memory Leaks
```javascript
// Check event listener counts
const eventStats = this.eventManager.getStats();
if (eventStats.totalListeners > 500) {
  console.warn('High listener count detected:', eventStats);
}
```

### Task Loading Issues
```javascript
// Debug task loading
const taskStats = taskLoader.getStats();
console.log('Task loading stats:', taskStats);
```

This migration can be implemented incrementally, allowing you to test each phase independently and rollback if necessary.