package orcloud.bridge;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * WebSocket connection to the collaboration server with automatic reconnect. Sends are
 * serialized on one thread (java.net.http.WebSocket allows one outstanding send).
 */
final class Conn implements WebSocket.Listener {
	interface Handler {
		void onOpen();

		void onMessage(Map<String, Object> msg);

		void onClosed(String reason);
	}

	private final URI uri;
	private final Handler handler;
	private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
	private final ExecutorService sender = Executors.newSingleThreadExecutor(r -> daemon(r, "liveshare-send"));
	private final ScheduledExecutorService timer = Executors.newSingleThreadScheduledExecutor(r -> daemon(r, "liveshare-timer"));
	private final StringBuilder partial = new StringBuilder();
	private volatile WebSocket ws;
	private volatile boolean closed;
	private long backoffMs = 500;

	Conn(URI uri, Handler handler) {
		this.uri = uri;
		this.handler = handler;
	}

	private static Thread daemon(Runnable r, String name) {
		Thread t = new Thread(r, name);
		t.setDaemon(true);
		return t;
	}

	void start() {
		connect();
		timer.scheduleAtFixedRate(() -> {
			WebSocket w = ws;
			if (w != null) {
				w.sendPing(ByteBuffer.allocate(0));
			}
		}, 20, 20, TimeUnit.SECONDS);
	}

	private void connect() {
		if (closed) {
			return;
		}
		client.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(10)).buildAsync(uri, this)
				.whenComplete((w, err) -> {
					if (err != null) {
						Log.warn("Connect to " + uri + " failed: " + err.getMessage());
						scheduleReconnect();
					}
				});
	}

	private synchronized void scheduleReconnect() {
		if (closed) {
			return;
		}
		long delay = backoffMs;
		backoffMs = Math.min(backoffMs * 2, 10_000);
		timer.schedule(this::connect, delay, TimeUnit.MILLISECONDS);
	}

	/** Drops the connection and reconnects (the server then sends a fresh welcome). */
	void reconnect() {
		WebSocket w = ws;
		ws = null;
		if (w != null) {
			w.abort();
		}
		partial.setLength(0);
		handler.onClosed("resync");
		scheduleReconnect();
	}

	boolean isOpen() {
		return ws != null;
	}

	CompletableFuture<Void> send(Map<String, Object> msg) {
		String text = Json.stringify(msg);
		CompletableFuture<Void> done = new CompletableFuture<>();
		sender.execute(() -> {
			WebSocket w = ws;
			try {
				if (w != null) {
					w.sendText(text, true).get(60, TimeUnit.SECONDS);
				}
				done.complete(null);
			} catch (Exception e) {
				Log.warn("Send failed: " + e);
				done.completeExceptionally(e);
			}
		});
		return done;
	}

	void close() {
		closed = true;
		WebSocket w = ws;
		if (w != null) {
			w.sendClose(WebSocket.NORMAL_CLOSURE, "bye");
		}
	}

	@Override
	public void onOpen(WebSocket webSocket) {
		synchronized (this) {
			backoffMs = 500;
		}
		ws = webSocket;
		Log.info("Connected to collaboration server");
		handler.onOpen();
		webSocket.request(1);
	}

	@Override
	@SuppressWarnings("unchecked")
	public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
		partial.append(data);
		if (last) {
			String text = partial.toString();
			partial.setLength(0);
			try {
				handler.onMessage((Map<String, Object>) Json.parse(text));
			} catch (Exception e) {
				Log.warn("Bad message from server: " + e);
			}
		}
		webSocket.request(1);
		return null;
	}

	@Override
	public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
		lost(webSocket, statusCode + " " + reason);
		return null;
	}

	@Override
	public void onError(WebSocket webSocket, Throwable error) {
		lost(webSocket, String.valueOf(error));
	}

	private void lost(WebSocket webSocket, String reason) {
		if (ws != webSocket) {
			return; // a socket we already dropped on purpose
		}
		ws = null;
		partial.setLength(0);
		Log.warn("Disconnected: " + reason);
		handler.onClosed(reason);
		scheduleReconnect();
	}
}
