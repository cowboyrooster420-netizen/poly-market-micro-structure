import { configManager } from '../config/ConfigManager';

// Global test setup
beforeAll(async () => {
  // Set test environment
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'error'; // Reduce log noise in tests
  
  // Disable file watching in config manager during tests
  if ((configManager as any).cleanupInterval) {
    clearInterval((configManager as any).cleanupInterval);
  }
});

afterAll(async () => {
  // Global cleanup
  // Any global cleanup code here
});

// Mock console methods to reduce test output noise
const originalConsoleLog = console.log;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;

beforeEach(() => {
  // Mock console methods unless DEBUG is set
  if (!process.env.DEBUG) {
    console.log = jest.fn();
    console.warn = jest.fn();
    console.error = jest.fn();
  }
});

afterEach(() => {
  // Restore console methods
  if (!process.env.DEBUG) {
    console.log = originalConsoleLog;
    console.warn = originalConsoleWarn;
    console.error = originalConsoleError;
  }
  
  // Clear all mocks
  jest.clearAllMocks();
});