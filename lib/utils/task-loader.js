const path = require('path');
const fs = require('fs');

/**
 * Task loader with lazy loading and caching for improved performance
 */
class TaskLoader {
  constructor() {
    this.taskCache = new Map();
    this.taskMap = new Map();
    this.loadingPromises = new Map();
    this.taskDirectory = path.join(__dirname, '../tasks');
    this.initialized = false;
  }

  /**
   * Initialize the task loader by scanning for available tasks
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      const taskFiles = await this.scanTaskDirectory();
      
      // Build task map without loading modules
      for (const file of taskFiles) {
        const taskName = this.getTaskNameFromFile(file);
        if (taskName) {
          this.taskMap.set(taskName, path.join(this.taskDirectory, file));
        }
      }
      
      this.initialized = true;
    } catch (error) {
      console.error('Error initializing task loader:', error);
      throw error;
    }
  }

  /**
   * Scan the task directory for available task files
   * @returns {Array<string>} Array of task file names
   */
  async scanTaskDirectory() {
    return new Promise((resolve, reject) => {
      fs.readdir(this.taskDirectory, (err, files) => {
        if (err) {
          reject(err);
          return;
        }
        
        // Filter for .js files, excluding directories and special files
        const taskFiles = files.filter(file => 
          file.endsWith('.js') && 
          !file.startsWith('.') &&
          file !== 'make_task.js' &&
          file !== 'task.js'
        );
        
        resolve(taskFiles);
      });
    });
  }

  /**
   * Get task name from file name
   * @param {string} fileName - The file name
   * @returns {string|null} Task name or null if not a valid task
   */
  getTaskNameFromFile(fileName) {
    if (!fileName.endsWith('.js')) return null;
    
    // Convert file name to task name
    const baseName = fileName.slice(0, -3); // Remove .js extension
    
    // Handle special cases
    const taskNameMappings = {
      'sip_decline': 'sip:decline',
      'sip_refer': 'sip:refer', 
      'sip_request': 'sip:request',
      'rest_dial': 'rest:dial',
      'say-legacy': 'say:legacy',
      'stt-task': 'stt',
      'tts-task': 'tts'
    };
    
    return taskNameMappings[baseName] || baseName;
  }

  /**
   * Load a task by name with lazy loading
   * @param {string} taskName - The name of the task to load
   * @returns {Promise<Object>} The loaded task module
   */
  async loadTask(taskName) {
    if (!this.initialized) {
      await this.initialize();
    }
    
    // Check cache first
    if (this.taskCache.has(taskName)) {
      return this.taskCache.get(taskName);
    }
    
    // Check if loading is already in progress
    if (this.loadingPromises.has(taskName)) {
      return this.loadingPromises.get(taskName);
    }
    
    // Get task file path
    const taskPath = this.taskMap.get(taskName);
    if (!taskPath) {
      throw new Error(`Task '${taskName}' not found`);
    }
    
    // Create loading promise
    const loadingPromise = this.loadTaskModule(taskPath, taskName);
    this.loadingPromises.set(taskName, loadingPromise);
    
    try {
      const taskModule = await loadingPromise;
      
      // Cache the loaded task
      this.taskCache.set(taskName, taskModule);
      
      return taskModule;
    } finally {
      // Remove from loading promises
      this.loadingPromises.delete(taskName);
    }
  }

  /**
   * Load a task module from file system
   * @param {string} taskPath - Path to the task file
   * @param {string} taskName - Name of the task
   * @returns {Promise<Object>} The loaded task module
   */
  async loadTaskModule(taskPath, taskName) {
    try {
      // Clear module cache to ensure fresh load if needed
      delete require.cache[require.resolve(taskPath)];
      
      const taskModule = require(taskPath);
      
      // Validate task module
      if (!taskModule || typeof taskModule !== 'function') {
        throw new Error(`Invalid task module: ${taskName}`);
      }
      
      return taskModule;
    } catch (error) {
      console.error(`Error loading task '${taskName}':`, error);
      throw error;
    }
  }

  /**
   * Preload specific tasks that are commonly used
   * @param {Array<string>} taskNames - Array of task names to preload
   */
  async preloadTasks(taskNames) {
    const preloadPromises = taskNames.map(taskName => 
      this.loadTask(taskName).catch(error => {
        console.warn(`Failed to preload task '${taskName}':`, error.message);
        return null;
      })
    );
    
    await Promise.allSettled(preloadPromises);
  }

  /**
   * Get all available task names
   * @returns {Array<string>} Array of available task names
   */
  getAvailableTaskNames() {
    if (!this.initialized) {
      throw new Error('Task loader not initialized');
    }
    
    return Array.from(this.taskMap.keys());
  }

  /**
   * Check if a task is available
   * @param {string} taskName - Name of the task
   * @returns {boolean} True if task is available
   */
  hasTask(taskName) {
    if (!this.initialized) {
      return false;
    }
    
    return this.taskMap.has(taskName);
  }

  /**
   * Get task loading statistics
   * @returns {Object} Task loading statistics
   */
  getStats() {
    return {
      totalTasks: this.taskMap.size,
      cachedTasks: this.taskCache.size,
      loadingTasks: this.loadingPromises.size,
      cacheHitRate: this.taskCache.size / Math.max(1, this.taskMap.size),
      initialized: this.initialized
    };
  }

  /**
   * Clear task cache
   * @param {string} taskName - Optional task name to clear, or clear all if not specified
   */
  clearCache(taskName) {
    if (taskName) {
      this.taskCache.delete(taskName);
    } else {
      this.taskCache.clear();
    }
  }

  /**
   * Load multiple tasks in parallel
   * @param {Array<string>} taskNames - Array of task names to load
   * @returns {Promise<Object>} Object mapping task names to loaded modules
   */
  async loadTasks(taskNames) {
    const loadPromises = taskNames.map(async taskName => {
      try {
        const taskModule = await this.loadTask(taskName);
        return { taskName, taskModule, success: true };
      } catch (error) {
        return { taskName, error, success: false };
      }
    });
    
    const results = await Promise.allSettled(loadPromises);
    
    const loadedTasks = {};
    const errors = [];
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const { taskName, taskModule, success, error } = result.value;
        if (success) {
          loadedTasks[taskName] = taskModule;
        } else {
          errors.push({ taskName, error });
        }
      } else {
        errors.push({ taskName: taskNames[index], error: result.reason });
      }
    });
    
    if (errors.length > 0) {
      console.warn('Some tasks failed to load:', errors);
    }
    
    return loadedTasks;
  }
}

// Singleton instance
let taskLoaderInstance = null;

/**
 * Get the singleton task loader instance
 * @returns {TaskLoader} The task loader instance
 */
function getTaskLoader() {
  if (!taskLoaderInstance) {
    taskLoaderInstance = new TaskLoader();
  }
  return taskLoaderInstance;
}

/**
 * Helper function to load a task (backward compatibility)
 * @param {string} taskName - Name of the task to load
 * @returns {Promise<Object>} The loaded task module
 */
async function loadTask(taskName) {
  const loader = getTaskLoader();
  return loader.loadTask(taskName);
}

module.exports = {
  TaskLoader,
  getTaskLoader,
  loadTask
};