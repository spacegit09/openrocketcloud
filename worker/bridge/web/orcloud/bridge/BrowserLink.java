package orcloud.bridge;

import java.util.Map;
import java.util.concurrent.CompletableFuture;

import javax.swing.SwingUtilities;

import orcloud.web.Preview;

/**
 * Browser build (CheerpJ): the bridge's connection runs through the page, which holds the
 * connection to the design's Base44 actor (web/src/session/java.js implements the natives).
 * The page hands over events as strings: "o" connected, "c" + reason disconnected, "m" + JSON a
 * message from the hub, "x" the user closes the design.
 */
final class BrowserLink implements Link {
	private static native void jsSend(String json);

	/** Waits for the next event from the page. */
	private static native String jsReceive();

	private static native void jsReconnect();

	private static native void jsClose();

	/** Tells the page that OpenRocket is open with the shared design. */
	private static native String jsReady();

	/** Returns the page's latest placement for OpenRocket's menus (see orcloud.web.MenuRow), or null. */
	static String ready() {
		return jsReady();
	}

	private final Link.Handler handler;
	private volatile boolean open;
	private volatile boolean closed;

	BrowserLink(Link.Handler handler) {
		this.handler = handler;
	}

	@Override
	public void start() {
		Thread t = new Thread(this::pump, "liveshare-receive");
		t.setDaemon(true);
		t.start();
	}

	@SuppressWarnings("unchecked")
	private void pump() {
		while (!closed) {
			String event = jsReceive();
			if (event == null || event.isEmpty()) {
				continue;
			}
			try {
				switch (event.charAt(0)) {
				case 'o':
					open = true;
					handler.onOpen();
					break;
				case 'c':
					open = false;
					handler.onClosed(event.substring(1));
					break;
				case 'm':
					handler.onMessage((Map<String, Object>) Json.parse(event.substring(1)));
					break;
				case 'x':
					// The card's drawing first, if it is waiting on the last edits.
					SwingUtilities.invokeLater(Preview::flush);
					handler.onCloseRequested();
					break;
				default:
					break;
				}
			} catch (Exception e) {
				Log.warn("Bad event from the page: " + e);
			}
		}
	}

	@Override
	public CompletableFuture<Void> send(Map<String, Object> msg) {
		jsSend(Json.stringify(msg)); // the page queues it until the actor connection is open
		return CompletableFuture.completedFuture(null);
	}

	@Override
	public void reconnect() {
		open = false;
		handler.onClosed("resync");
		jsReconnect();
	}

	@Override
	public boolean isOpen() {
		return open;
	}

	@Override
	public void close() {
		closed = true;
		jsClose();
	}
}
