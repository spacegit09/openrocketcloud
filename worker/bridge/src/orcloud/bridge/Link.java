package orcloud.bridge;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * The bridge's connection to the live-share hub: a WebSocket to the server ({@link Conn}), or in
 * the browser build the page's connection to the design's Base44 actor ({@code BrowserLink}).
 */
interface Link {
	interface Handler {
		void onOpen();

		void onMessage(Map<String, Object> msg);

		void onClosed(String reason);
	}

	void start();

	CompletableFuture<Void> send(Map<String, Object> msg);

	/** Drops the connection and reconnects (the hub then sends a fresh welcome). */
	void reconnect();

	boolean isOpen();

	void close();
}
