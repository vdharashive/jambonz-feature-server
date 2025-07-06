const EventEmitter = require('events');

/**
 * Enhanced event manager to prevent memory leaks and improve performance
 */
class EventManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxListeners = options.maxListeners || 100;
    this.listeners = new Map();
    this.onceListeners = new Set();
    this.timeoutListeners = new Map();
    this.created = Date.now();
    this.listenerCount = 0;
    
    // Set max listeners to prevent memory leak warnings
    this.setMaxListeners(this.maxListeners);
  }

  /**
   * Add an event listener with automatic cleanup tracking
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   * @param {Object} options - Listener options
   * @returns {Function} Cleanup function
   */
  addListener(event, listener, options = {}) {
    const { once = false, timeout = null, context = null } = options;
    
    let actualListener = listener;
    
    if (context) {
      actualListener = listener.bind(context);
    }
    
    // Handle once listeners
    if (once) {
      const onceListener = (...args) => {
        this.removeListener(event, onceListener);
        this.onceListeners.delete(onceListener);
        if (this.timeoutListeners.has(onceListener)) {
          clearTimeout(this.timeoutListeners.get(onceListener));
          this.timeoutListeners.delete(onceListener);
        }
        actualListener(...args);
      };
      
      this.onceListeners.add(onceListener);
      actualListener = onceListener;
    }
    
    // Handle timeout
    if (timeout) {
      const timeoutHandle = setTimeout(() => {
        this.removeListener(event, actualListener);
        this.timeoutListeners.delete(actualListener);
        if (this.onceListeners.has(actualListener)) {
          this.onceListeners.delete(actualListener);
        }
      }, timeout);
      
      this.timeoutListeners.set(actualListener, timeoutHandle);
    }
    
    // Track listeners
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(actualListener);
    this.listenerCount++;
    
    // Add to EventEmitter
    super.addListener(event, actualListener);
    
    // Return cleanup function
    return () => {
      this.removeListener(event, actualListener);
    };
  }

  /**
   * Remove an event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   */
  removeListener(event, listener) {
    // Clean up tracking
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(listener);
      if (this.listeners.get(event).size === 0) {
        this.listeners.delete(event);
      }
    }
    
    if (this.onceListeners.has(listener)) {
      this.onceListeners.delete(listener);
    }
    
    if (this.timeoutListeners.has(listener)) {
      clearTimeout(this.timeoutListeners.get(listener));
      this.timeoutListeners.delete(listener);
    }
    
    this.listenerCount--;
    
    // Remove from EventEmitter
    super.removeListener(event, listener);
  }

  /**
   * Add a one-time event listener
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   * @param {Object} options - Listener options
   * @returns {Function} Cleanup function
   */
  once(event, listener, options = {}) {
    return this.addListener(event, listener, { ...options, once: true });
  }

  /**
   * Add a timed event listener that auto-removes after timeout
   * @param {string} event - Event name
   * @param {Function} listener - Event listener function
   * @param {number} timeout - Timeout in milliseconds
   * @param {Object} options - Additional options
   * @returns {Function} Cleanup function
   */
  timedListener(event, listener, timeout, options = {}) {
    return this.addListener(event, listener, { ...options, timeout });
  }

  /**
   * Remove all listeners for a specific event
   * @param {string} event - Event name
   */
  removeAllListeners(event) {
    if (event) {
      // Clean up specific event
      const listeners = this.listeners.get(event);
      if (listeners) {
        for (const listener of listeners) {
          this.removeListener(event, listener);
        }
      }
    } else {
      // Clean up all events
      for (const [eventName, listeners] of this.listeners) {
        for (const listener of listeners) {
          this.removeListener(eventName, listener);
        }
      }
    }
    
    super.removeAllListeners(event);
  }

  /**
   * Get listener count for an event
   * @param {string} event - Event name
   * @returns {number} Number of listeners
   */
  listenerCount(event) {
    if (event) {
      return this.listeners.get(event)?.size || 0;
    }
    return this.listenerCount;
  }

  /**
   * Get statistics about the event manager
   * @returns {Object} Statistics
   */
  getStats() {
    const events = {};
    for (const [event, listeners] of this.listeners) {
      events[event] = listeners.size;
    }
    
    return {
      totalListeners: this.listenerCount,
      events,
      onceListeners: this.onceListeners.size,
      timedListeners: this.timeoutListeners.size,
      age: Date.now() - this.created
    };
  }

  /**
   * Cleanup all listeners and timers
   */
  cleanup() {
    // Clear all timeouts
    for (const timeout of this.timeoutListeners.values()) {
      clearTimeout(timeout);
    }
    
    // Clear all tracking
    this.listeners.clear();
    this.onceListeners.clear();
    this.timeoutListeners.clear();
    this.listenerCount = 0;
    
    // Remove all EventEmitter listeners
    super.removeAllListeners();
  }

  /**
   * Emit an event with error handling
   * @param {string} event - Event name
   * @param {...any} args - Event arguments
   * @returns {boolean} True if event had listeners
   */
  safeEmit(event, ...args) {
    try {
      return this.emit(event, ...args);
    } catch (error) {
      console.error(`Error in event listener for ${event}:`, error);
      return false;
    }
  }
}

/**
 * Factory function to create a new event manager
 * @param {Object} options - Configuration options
 * @returns {EventManager} New event manager instance
 */
function createEventManager(options = {}) {
  return new EventManager(options);
}

module.exports = {
  EventManager,
  createEventManager
};