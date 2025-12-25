/**
 * WebSocket client connection handler
 */
type WebSocketClient = {
  send: (data: string) => void;
  close?: () => void;
};

/**
 * WebSocket topic subscription
 */
type Topic = "engine" | "video";

/**
 * WebSocket message types
 */
type WebSocketMessage =
  | { type: "subscribe"; topics: Topic[] }
  | { type: "unsubscribe"; topics: Topic[] }
  | { type: "engine.status"; [key: string]: any }
  | { type: "engine.macros"; [key: string]: any }
  | { type: "engine.macroStatus"; [key: string]: any }
  | { type: "engine.connected"; [key: string]: any }
  | { type: "engine.disconnected" }
  | { type: "engine.error"; [key: string]: any }
  | { type: "video.status"; [key: string]: any };

/**
 * WebSocket manager
 *
 * Manages WebSocket clients with topic-based subscription.
 * Clients can subscribe to specific topics (engine, video) and receive
 * only events for those topics.
 */
export class WebSocketManager {
  private clients: Map<WebSocketClient, Set<Topic>> = new Map();

  /**
   * Register a new WebSocket client
   */
  registerClient(client: WebSocketClient): void {
    this.clients.set(client, new Set());
  }

  /**
   * Unregister a WebSocket client
   */
  unregisterClient(client: WebSocketClient): void {
    this.clients.delete(client);
  }

  /**
   * Subscribe client to topics
   */
  subscribe(client: WebSocketClient, topics: Topic[]): void {
    const clientTopics = this.clients.get(client);
    if (clientTopics) {
      topics.forEach((topic) => clientTopics.add(topic));
    }
  }

  /**
   * Unsubscribe client from topics
   */
  unsubscribe(client: WebSocketClient, topics: Topic[]): void {
    const clientTopics = this.clients.get(client);
    if (clientTopics) {
      topics.forEach((topic) => clientTopics.delete(topic));
    }
  }

  /**
   * Get topics for a client
   */
  getClientTopics(client: WebSocketClient): Set<Topic> {
    return this.clients.get(client) || new Set();
  }

  /**
   * Broadcast message to all clients subscribed to the topic
   */
  broadcast(topic: Topic, message: WebSocketMessage): void {
    const messageJson = JSON.stringify(message);

    this.clients.forEach((topics, client) => {
      if (topics.has(topic)) {
        try {
          client.send(messageJson);
        } catch (error) {
          // Client disconnected, remove it
          this.clients.delete(client);
        }
      }
    });
  }

  /**
   * Send message to a specific client
   */
  sendToClient(client: WebSocketClient, message: WebSocketMessage): void {
    try {
      const messageJson = JSON.stringify(message);
      client.send(messageJson);
    } catch (error) {
      // Client disconnected, remove it
      this.clients.delete(client);
    }
  }

  /**
   * Send snapshot to client for all subscribed topics
   */
  sendSnapshot(
    client: WebSocketClient,
    getSnapshot: (topic: Topic) => WebSocketMessage | null
  ): void {
    const topics = this.getClientTopics(client);

    topics.forEach((topic) => {
      const snapshot = getSnapshot(topic);
      if (snapshot) {
        this.sendToClient(client, snapshot);
      }
    });
  }

  /**
   * Get number of connected clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Get number of clients subscribed to a topic
   */
  getTopicSubscriberCount(topic: Topic): number {
    let count = 0;
    this.clients.forEach((topics) => {
      if (topics.has(topic)) {
        count++;
      }
    });
    return count;
  }
}

/**
 * Singleton instance
 */
export const websocketManager = new WebSocketManager();

