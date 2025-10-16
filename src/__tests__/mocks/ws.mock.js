// Mock WebSocket implementation for testing
class MockWebSocket {
  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 1; // OPEN
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    
    this.eventListeners = {};
    
    // Simulate connection opening
    setTimeout(() => {
      if (this.onopen) {
        this.onopen({ type: 'open' });
      }
      this.emit('open');
    }, 10);
  }
  
  send(data) {
    // Mock send - just return success
    return true;
  }
  
  close(code, reason) {
    this.readyState = this.CLOSED;
    if (this.onclose) {
      this.onclose({ type: 'close', code, reason });
    }
    this.emit('close', code, reason);
  }
  
  on(event, listener) {
    if (!this.eventListeners[event]) {
      this.eventListeners[event] = [];
    }
    this.eventListeners[event].push(listener);
  }
  
  off(event, listener) {
    if (this.eventListeners[event]) {
      const index = this.eventListeners[event].indexOf(listener);
      if (index > -1) {
        this.eventListeners[event].splice(index, 1);
      }
    }
  }
  
  emit(event, ...args) {
    if (this.eventListeners[event]) {
      this.eventListeners[event].forEach(listener => {
        try {
          listener(...args);
        } catch (error) {
          // Ignore listener errors in tests
        }
      });
    }
  }
  
  // Simulate receiving a message
  simulateMessage(data) {
    const event = {
      type: 'message',
      data: typeof data === 'string' ? data : JSON.stringify(data)
    };
    
    if (this.onmessage) {
      this.onmessage(event);
    }
    this.emit('message', event);
  }
  
  // Simulate an error
  simulateError(error) {
    const event = { type: 'error', error };
    
    if (this.onerror) {
      this.onerror(event);
    }
    this.emit('error', event);
  }
}

module.exports = MockWebSocket;