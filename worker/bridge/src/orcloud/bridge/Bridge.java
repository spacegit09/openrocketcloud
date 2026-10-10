package orcloud.bridge;

import java.awt.event.WindowAdapter;
import java.awt.event.WindowEvent;
import java.io.File;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import javax.swing.JOptionPane;
import javax.swing.SwingUtilities;
import javax.swing.Timer;

import info.openrocket.core.appearance.DecalImage;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.rocketcomponent.ComponentChangeEvent;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.util.ModID;
import info.openrocket.swing.gui.main.BasicFrame;

/**
 * The live-share engine. All document and model state is confined to the Swing event
 * thread; network callbacks hop onto it with invokeLater.
 *
 * Sync scheme (server-ordered, per-property last-writer-wins):
 *   server   = last state confirmed by the server
 *   pending  = local op batches sent but not yet echoed back
 *   expected = server + pending = the shared view of the open document
 * Local edits: OpenRocket's change events say which components the user touched; the
 * document is snapshotted and those components (plus any structural change, simulations
 * and document-level data) are diffed against {@code expected}. Only reporting what the
 * user edited keeps OpenRocket's lazily re-derived values from bouncing between clients.
 * Remote edits: {@code server} advances and the document is moved to server + pending,
 * property by property where possible so open dialogs stay open.
 */
final class Bridge implements Link.Handler {
	private static final int DEBOUNCE_MS = 200;

	private final Link conn;
	private final String token;
	private final Path workDir;
	private final CountDownLatch firstWelcome = new CountDownLatch(1);
	private volatile Path file;
	private volatile Model fileModel; // the shared state the opened file was written from

	// --- event-thread state
	private OpenRocketDocument doc;
	private BasicFrame frame;
	private Model server;
	private long version;
	private String clientId;
	private Model expected;
	private final List<Pending> pending = new ArrayList<>();
	private long nextSeq = 1;
	private boolean applying;
	private boolean deferred;
	private int quietTicks;
	private String lastPresence = "";

	// Local edits since the last snapshot.
	private boolean dirty;
	private boolean dirtyAll;
	private final Set<String> dirtyIds = new HashSet<>();

	private final IdentityHashMap<Simulation, String> simIds = new IdentityHashMap<>();
	private final IdentityHashMap<FlightData, String> flightData = new IdentityHashMap<>();
	private final IdentityHashMap<DecalImage, String> decals = new IdentityHashMap<>();
	// Results that came from the shared copy (not computed here); never re-published.
	private final Set<FlightData> foreignResults = Collections.newSetFromMap(new IdentityHashMap<>());
	private ModID warmedUp;

	// Remote-edit bookkeeping for undo: "id\0key" -> stamp of the last remote write.
	private final Map<String, Long> touched = new HashMap<>();
	private long stamp;
	private final IdentityHashMap<Object, Long> undoStamps = new IdentityHashMap<>();
	private Long undoRestoredStamp;

	private Timer debounce;

	private static final class Pending {
		final long seq;
		final List<Map<String, Object>> ops;

		Pending(long seq, List<Map<String, Object>> ops) {
			this.seq = seq;
			this.ops = ops;
		}
	}

	Bridge(URI collabUrl, String token, Path workDir) {
		this(handler -> new Conn(collabUrl, handler), token, workDir);
	}

	Bridge(java.util.function.Function<Link.Handler, Link> link, String token, Path workDir) {
		this.token = token;
		this.workDir = workDir;
		this.conn = link.apply(this);
	}

	void start() {
		conn.start();
	}

	Path awaitFile(long timeout, TimeUnit unit) throws InterruptedException {
		if (!firstWelcome.await(timeout, unit)) {
			throw new IllegalStateException("Collaboration server did not answer");
		}
		if (file == null) {
			throw new IllegalStateException("No shared document received");
		}
		return file;
	}

	// =================================================================== network callbacks

	@Override
	public void onOpen() {
		Map<String, Object> hello = new LinkedHashMap<>();
		hello.put("type", "hello");
		hello.put("token", token);
		conn.send(hello);
	}

	@Override
	public void onMessage(Map<String, Object> msg) {
		if ("welcome".equals(msg.get("type")) && file == null) {
			onFirstWelcome(msg); // OpenRocket is not running yet; write the file right away
			return;
		}
		SwingUtilities.invokeLater(() -> {
			try {
				handle(msg);
			} catch (Exception e) {
				Log.warn("Failed handling " + msg.get("type") + ": " + e);
				e.printStackTrace(System.out);
			}
		});
	}

	@Override
	public void onClosed(String reason) {
		// Pending batches stay queued and are resent after the next welcome.
	}

	@SuppressWarnings("unchecked")
	private synchronized void onFirstWelcome(Map<String, Object> msg) {
		try {
			Model m = Model.fromJson((Map<String, Object>) msg.get("model"));
			String name = String.valueOf(msg.getOrDefault("name", "Rocket"));
			String safe = name.replaceAll("[^\\p{L}\\p{N} ._()-]", "_").trim();
			Path p = workDir.resolve((safe.isEmpty() ? "Rocket" : safe) + ".ork");
			OrDoc.writeOrk(m, p);
			writeMotors(msg.get("motors"));
			fileModel = m.copy();
			Map<String, Object> copy = new HashMap<>(msg);
			copy.put("_model", m);
			SwingUtilities.invokeLater(() -> handleWelcome(copy));
			file = p;
		} catch (Exception e) {
			Log.warn("Could not write the shared design: " + e);
			e.printStackTrace(System.out);
		}
		firstWelcome.countDown();
	}

	/** Custom motor files shared with this design; OpenRocket loads them when it starts. */
	@SuppressWarnings("unchecked")
	private static void writeMotors(Object list) {
		Path dir = OrDoc.motorDir();
		try {
			Files.createDirectories(dir);
			try (var old = Files.list(dir)) {
				for (Path f : (Iterable<Path>) old::iterator) {
					Files.deleteIfExists(f);
				}
			}
			if (!(list instanceof List)) {
				return;
			}
			int n = 0;
			for (Object o : (List<Object>) list) {
				Map<String, Object> m = (Map<String, Object>) o;
				String name = String.valueOf(m.get("name")).replaceAll("[^A-Za-z0-9._-]", "_");
				if (name.matches("(?i).*\\.(eng|rse)") && m.get("content") instanceof String) {
					Files.writeString(dir.resolve(name), (String) m.get("content"), StandardCharsets.UTF_8);
					n++;
				}
			}
			if (n > 0) {
				Log.info("Loaded " + n + " custom motor file(s)");
			}
		} catch (Exception e) {
			Log.warn("Could not write custom motors: " + e);
		}
	}

	private void handle(Map<String, Object> msg) {
		switch (String.valueOf(msg.get("type"))) {
		case "welcome":
			handleWelcome(msg);
			break;
		case "ops":
			handleOps(msg);
			break;
		case "ack":
			handleAck(msg);
			break;
		case "kick":
			kicked(String.valueOf(msg.getOrDefault("message", "This session was closed.")));
			break;
		case "error":
			Log.warn("Server error: " + msg.get("message"));
			break;
		default:
			break;
		}
	}

	@SuppressWarnings("unchecked")
	private void handleWelcome(Map<String, Object> msg) {
		server = msg.get("_model") instanceof Model ? ((Model) msg.get("_model")).copy()
				: Model.fromJson((Map<String, Object>) msg.get("model"));
		version = num(msg.get("version"));
		clientId = String.valueOf(msg.get("clientId"));
		long lastSeq = num(msg.get("lastSeq"));
		pending.removeIf(p -> p.seq <= lastSeq);
		Log.info("Joined at version " + version + " as " + clientId
				+ (pending.isEmpty() ? "" : " (resending " + pending.size() + " batches)"));
		for (Pending p : pending) {
			sendPending(p);
		}
		if (doc != null) {
			rebuild();
			markSavedIfSynced();
			sendAttached();
		}
	}

	@SuppressWarnings("unchecked")
	private void handleOps(Map<String, Object> msg) {
		if (server == null) {
			return;
		}
		long v = num(msg.get("version"));
		if (v <= version) {
			return;
		}
		if (v != version + 1) {
			Log.warn("Missed updates (" + version + " -> " + v + "), resyncing");
			conn.reconnect();
			return;
		}
		if (doc != null) {
			scanUndoHistory();
			if (dirty) {
				snapshotAndSend(); // capture unsent local edits before the document moves
			}
		}
		List<Map<String, Object>> ops = (List<Map<String, Object>>) msg.get("ops");
		server.applyAll(ops);
		version = v;
		if (Objects.equals(clientId, msg.get("from"))) {
			long seq = num(msg.get("seq"));
			pending.removeIf(p -> p.seq <= seq);
		} else {
			recordRemoteTouches(ops);
		}
		if (doc != null) {
			rebuild();
			markSavedIfSynced();
		}
	}

	private void handleAck(Map<String, Object> msg) {
		long seq = num(msg.get("seq"));
		pending.removeIf(p -> p.seq <= seq);
		if (doc != null) {
			rebuild();
			markSavedIfSynced();
		}
	}

	private void kicked(String message) {
		Log.info("Session closed by server: " + message);
		conn.close();
		if (frame != null) {
			JOptionPane.showMessageDialog(frame, message, "Live share", JOptionPane.INFORMATION_MESSAGE);
		}
		System.exit(0);
	}

	private void sendPending(Pending p) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("type", "ops");
		m.put("seq", p.seq);
		m.put("base", version);
		m.put("ops", p.ops);
		conn.send(m);
	}

	private static long num(Object o) {
		return o instanceof Number ? ((Number) o).longValue() : 0;
	}

	// =================================================================== attaching to OpenRocket

	/** Called on the event thread once OpenRocket has opened the shared file. */
	void attach(File f) {
		BasicFrame bf = OrDoc.findFrame(f);
		if (bf == null) {
			Timer retry = new Timer(250, null);
			retry.setRepeats(false);
			retry.addActionListener(e -> attach(f));
			retry.start();
			return;
		}
		try {
			doc = OrDoc.documentOf(bf);
		} catch (Exception e) {
			Log.warn("Cannot access the opened document: " + e);
			System.exit(3);
		}
		frame = bf;

		// OpenRocket opened the file written from `fileModel`; simulations keep its order.
		List<String> simOrder = children(fileModel, Model.SIMS);
		List<Simulation> sims = doc.getSimulations();
		for (int i = 0; i < sims.size(); i++) {
			simIds.put(sims.get(i), i < simOrder.size() ? simOrder.get(i) : UUID.randomUUID().toString());
			if (sims.get(i).getSimulatedData() != null) {
				foreignResults.add(sims.get(i).getSimulatedData());
			}
		}
		expected = fileModel.copy();
		Log.info("Attached to \"" + doc.getRocket().getName() + "\" (" + expected.objs.size() + " shared objects)");

		doc.getRocket().addComponentChangeListener(this::componentChanged);
		doc.addDocumentChangeListener(e -> localChange());
		doc.addUndoRedoListener(this::scanUndoHistory);
		bf.addWindowListener(new WindowAdapter() {
			@Override
			public void windowClosed(WindowEvent e) {
				Log.info("Shared design window closed, ending session");
				System.exit(0);
			}
		});
		Runtime.getRuntime().addShutdownHook(new Thread(this::finalFlush, "liveshare-flush"));

		debounce = new Timer(DEBOUNCE_MS, e -> snapshotAndSend());
		debounce.setRepeats(false);
		new Timer(1000, e -> tick()).start();

		scanUndoHistory();
		rebuild();         // catch up with edits made while OpenRocket was starting
		snapshotAndSend(); // simulations/decals as OpenRocket loaded them
		markSavedIfSynced();
		sendAttached();
	}

	/** Tells the server OpenRocket is up with the shared design open. */
	private void sendAttached() {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("type", "attached");
		conn.send(m);
	}

	private static List<String> children(Model m, String parent) {
		return m.childIndex().getOrDefault(parent, Collections.emptyList());
	}

	private void componentChanged(ComponentChangeEvent e) {
		if (applying) {
			return;
		}
		if (e.isUndoChange()) {
			// Undo/redo restored a whole-rocket snapshot. Remember which one, so remote edits
			// made after it can be kept (see keepRemoteEditsThroughUndo).
			Object state = OrDoc.currentUndoState(doc);
			Long st = state == null ? null : undoStamps.get(state);
			undoRestoredStamp = st != null ? st : stamp;
			dirtyAll = true;
		} else if (e.getSource() instanceof RocketComponent) {
			RocketComponent c = (RocketComponent) e.getSource();
			dirtyIds.add(c.getID().toString());
			if (e.isTreeChange()) {
				for (Iterator<RocketComponent> it = c.iterator(false); it.hasNext();) {
					dirtyIds.add(it.next().getID().toString());
				}
			}
		} else {
			dirtyAll = true;
		}
		scanUndoHistory();
		localChange();
	}

	private void localChange() {
		if (applying || doc == null) {
			return;
		}
		dirty = true;
		debounce.restart();
	}

	private void tick() {
		if (doc == null) {
			return;
		}
		quietTicks++;
		if (deferred && !OrDoc.modalDialogOpen()) {
			rebuild();
		}
		if (dirty || quietTicks >= 5) {
			// Some edits (photo studio, custom expressions...) fire no events.
			quietTicks = 0;
			snapshotAndSend();
		}
		sendPresence();
	}

	// =================================================================== document -> model

	private Model snapshot() throws Exception {
		ensureUniqueComponentIds();
		List<Simulation> sims = new ArrayList<>(doc.getSimulations());
		List<String> ids = new ArrayList<>();
		Set<Simulation> live = Collections.newSetFromMap(new IdentityHashMap<>());
		for (Simulation s : sims) {
			ids.add(simIds.computeIfAbsent(s, x -> UUID.randomUUID().toString()));
			live.add(s);
		}
		simIds.keySet().retainAll(live);

		// OpenRocket refreshes some derived "auto" values lazily, during a save. After an
		// edit, save once to let them settle.
		if (doc.getRocket().getModID() != warmedUp) {
			OrDoc.save(doc, false);
			warmedUp = doc.getRocket().getModID();
		}
		Model m = OrDoc.toModel(doc, ids, decals);

		// Full flight data is serialised only when a simulation produced new results.
		Set<FlightData> current = Collections.newSetFromMap(new IdentityHashMap<>());
		boolean needFull = false;
		for (Simulation s : sims) {
			FlightData d = s.getSimulatedData();
			if (d != null && d.getBranchCount() > 0) {
				current.add(d);
				needFull |= !flightData.containsKey(d);
			}
		}
		flightData.keySet().retainAll(current);
		Set<FlightData> live2 = Collections.newSetFromMap(new IdentityHashMap<>());
		for (Simulation s : sims) {
			if (s.getSimulatedData() != null) {
				live2.add(s.getSimulatedData());
			}
		}
		foreignResults.retainAll(live2);
		if (needFull) {
			Xml.El full = Xml.parse(OrDoc.save(doc, true)).first("simulations");
			List<Xml.El> simEls = new ArrayList<>();
			if (full != null) {
				for (Xml.El el : full.elements()) {
					if (el.tag.equals("simulation")) {
						simEls.add(el);
					}
				}
			}
			for (int i = 0; i < sims.size() && i < simEls.size(); i++) {
				FlightData d = sims.get(i).getSimulatedData();
				Xml.El fd = simEls.get(i).first("flightdata");
				if (d != null && fd != null && current.contains(d)) {
					flightData.put(d, Xml.canonical(fd));
				}
			}
		}
		// Simulation results: publish results computed here when the shared copy has no current
		// results for this design; otherwise mirror the shared results. OpenRocket re-runs
		// outdated simulations by itself on every client (each with its own random seed), so
		// without this every client would keep re-publishing slightly different numbers.
		String rocket = expected == null ? "" : expected.rocketFingerprint();
		for (int i = 0; i < sims.size(); i++) {
			Model.Obj o = m.get(ids.get(i));
			if (o == null) {
				continue;
			}
			Simulation sim = sims.get(i);
			String status = OrDoc.statusAttr(sim);
			o.v.put(Model.ATTRS, Xml.attrsCanonical(Collections.singletonMap("status", status)));
			FlightData data = sim.getSimulatedData();
			if (data == null) {
				continue;
			}
			Model.Obj shared = expected == null ? null : expected.get(ids.get(i));
			String basis = Model.basis(rocket, o);
			boolean sharedCurrent = shared != null && shared.v.containsKey("flightdata")
					&& "uptodate".equals(statusOf(shared)) && basis.equals(shared.v.get("#basis"));
			boolean computedHere = !foreignResults.contains(data);
			if (computedHere && !sharedCurrent && "uptodate".equals(status)) {
				String fd = flightData.get(data);
				if (fd != null) {
					o.v.put("flightdata", fd);
				}
				putKey(o, "#basis", basis);
			} else if (shared != null && shared.v.containsKey("flightdata")) {
				o.v.put("flightdata", shared.v.get("flightdata"));
				if (shared.v.containsKey("#basis")) {
					putKey(o, "#basis", shared.v.get("#basis"));
				}
			} else if (flightData.containsKey(data)) {
				o.v.put("flightdata", flightData.get(data));
			}
		}
		return m;
	}

	private static void putKey(Model.Obj o, String key, String value) {
		if (!o.k.contains(key)) {
			o.k.add(key);
		}
		o.v.put(key, value);
	}

	/** Shared ids must be unique; repair the rare duplicate a paste can leave behind. */
	private void ensureUniqueComponentIds() {
		Set<UUID> seen = new HashSet<>();
		for (RocketComponent c : doc.getRocket()) {
			if (!seen.add(c.getID())) {
				c.setID(UUID.randomUUID());
				seen.add(c.getID());
				dirtyIds.add(c.getID().toString());
			}
		}
	}

	// =================================================================== local -> server

	private void snapshotAndSend() {
		if (doc == null || expected == null) {
			return;
		}
		if (debounce != null) {
			debounce.stop();
		}
		Set<String> scope = dirtyAll ? null : new HashSet<>(dirtyIds);
		Long undoSince = undoRestoredStamp;
		dirty = false;
		dirtyAll = false;
		dirtyIds.clear();
		undoRestoredStamp = null;
		Model snap;
		try {
			snap = snapshot();
		} catch (Exception e) {
			Log.warn("Snapshot failed: " + e);
			e.printStackTrace(System.out);
			return;
		}
		Model base = expected;
		List<Map<String, Object>> ops = Model.diff(base, snap, scope);
		if (undoSince != null) {
			ops = keepRemoteEditsThroughUndo(base, ops, undoSince);
		} else {
			Model next = base.copy();
			next.applyAll(ops);
			expected = next;
		}
		if (!ops.isEmpty()) {
			Pending p = new Pending(nextSeq++, ops);
			pending.add(p);
			Log.debug("Sending seq " + p.seq + ": " + brief(ops));
			if (conn.isOpen()) {
				sendPending(p);
			}
		}
		markSavedIfSynced();
	}

	@SuppressWarnings("unchecked")
	private static String brief(List<Map<String, Object>> ops) {
		StringBuilder sb = new StringBuilder();
		for (Map<String, Object> op : ops) {
			String id = String.valueOf(op.get("id"));
			sb.append(' ').append(op.get("op")).append(' ').append(id, 0, Math.min(8, id.length()));
			if (op.get("v") instanceof Map) {
				sb.append(((Map<String, Object>) op.get("v")).keySet());
			}
		}
		return sb.toString();
	}

	/**
	 * OpenRocket's undo restores a whole-rocket snapshot, which would also roll back what
	 * collaborators changed since. Leave those parts out and put them back in the document,
	 * so undo only reverts this user's own edits. Sets {@code expected}.
	 */
	@SuppressWarnings("unchecked")
	private List<Map<String, Object>> keepRemoteEditsThroughUndo(Model base, List<Map<String, Object>> ops, long since) {
		List<Map<String, Object>> kept = new ArrayList<>();
		boolean dropped = false;
		for (Map<String, Object> op : ops) {
			String id = (String) op.get("id");
			String kind = (String) op.get("op");
			if (kind.equals("set")) {
				Map<String, Object> nv = new LinkedHashMap<>();
				for (Map.Entry<String, Object> e : ((Map<String, Object>) op.get("v")).entrySet()) {
					if (touchedSince(id, e.getKey(), since)) {
						dropped = true;
					} else {
						nv.put(e.getKey(), e.getValue());
					}
				}
				if (!nv.isEmpty() || op.containsKey("k")) {
					Map<String, Object> copy = new LinkedHashMap<>(op);
					copy.put("v", nv);
					kept.add(copy);
				}
			} else if (touchedSince(id, "#exist", since) || (kind.equals("move") && touchedSince(id, "#pos", since))) {
				dropped = true;
			} else {
				kept.add(op);
			}
		}
		Model undone = base.copy();
		undone.applyAll(ops);
		if (!dropped) {
			expected = undone;
			return ops;
		}
		Model target = base.copy();
		kept = target.applyAll(kept);
		Log.info("Undo: kept " + (ops.size() - kept.size()) + "+ collaborator edits");
		expected = undone;
		applyToDocument(undone, target);
		return kept;
	}

	private boolean touchedSince(String id, String key, long since) {
		Long t = touched.get(id + '\u0000' + key);
		return t != null && t > since;
	}

	@SuppressWarnings("unchecked")
	private void recordRemoteTouches(List<Map<String, Object>> ops) {
		stamp++;
		for (Map<String, Object> op : ops) {
			String id = (String) op.get("id");
			switch (String.valueOf(op.get("op"))) {
			case "put":
			case "del":
				touched.put(id + "\u0000#exist", stamp);
				break;
			case "move":
				touched.put(id + "\u0000#pos", stamp);
				break;
			case "set":
				for (String key : ((Map<String, Object>) op.get("v")).keySet()) {
					touched.put(id + '\u0000' + key, stamp);
				}
				break;
			default:
				break;
			}
		}
	}

	private void scanUndoHistory() {
		if (doc == null) {
			return;
		}
		Set<Object> present = Collections.newSetFromMap(new IdentityHashMap<>());
		for (Object state : OrDoc.undoHistory(doc)) {
			present.add(state);
			undoStamps.putIfAbsent(state, stamp);
		}
		undoStamps.keySet().retainAll(present);
	}

	private void markSavedIfSynced() {
		if (doc != null && pending.isEmpty() && !dirty && !deferred) {
			doc.setSaved(true);
			String title = frame == null ? null : frame.getTitle();
			if (title != null && title.startsWith("*")) {
				frame.setTitle(title.substring(1));
			}
		}
	}

	private void sendPresence() {
		List<String> sel = frame == null ? Collections.emptyList() : OrDoc.selectedIds(frame);
		String key = String.join(",", sel);
		if (key.equals(lastPresence) || !conn.isOpen()) {
			return;
		}
		lastPresence = key;
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("type", "presence");
		m.put("selection", sel);
		conn.send(m);
	}

	/** Last-chance push of unsent edits when the JVM exits (window closed or container stop). */
	private void finalFlush() {
		try {
			if (doc == null || expected == null || server == null) {
				return;
			}
			if (dirty) {
				Model snap = snapshot();
				List<Map<String, Object>> ops = Model.diff(expected, snap, dirtyAll ? null : new HashSet<>(dirtyIds));
				if (!ops.isEmpty()) {
					pending.add(new Pending(nextSeq++, ops));
				}
			}
			for (Pending p : new ArrayList<>(pending)) {
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("type", "ops");
				m.put("seq", p.seq);
				m.put("ops", p.ops);
				conn.send(m).get(5, TimeUnit.SECONDS);
			}
		} catch (Exception e) {
			Log.warn("Final flush incomplete: " + e);
		}
	}

	// =================================================================== server -> document

	private void rebuild() {
		if (doc == null || server == null || expected == null) {
			return;
		}
		Model target = server.copy();
		for (Pending p : pending) {
			target.applyAll(p.ops);
		}
		if (Model.sameContent(target, expected)) {
			expected = target;
			deferred = false;
			return;
		}
		applyToDocument(expected, target);
	}

	private static final class Plan {
		boolean reloadRocket;
		boolean sims;
		boolean raw;
		final List<String[]> leafSets = new ArrayList<>(); // {id, key, xml}

		boolean empty() {
			return !reloadRocket && !sims && !raw && leafSets.isEmpty();
		}
	}

	private static Plan plan(Model cur, Model target) {
		Plan plan = new Plan();
		Set<String> rocketCur = cur.rocketSubtree();
		Set<String> rocketTarget = target.rocketSubtree();
		Set<String> ids = new TreeSet<>(cur.objs.keySet());
		ids.addAll(target.objs.keySet());
		for (String id : ids) {
			Model.Obj c = cur.get(id);
			Model.Obj t = target.get(id);
			Model.Obj any = t != null ? t : c;
			boolean rocket = rocketTarget.contains(id) || rocketCur.contains(id);
			boolean sim = Model.SIMS.equals(id) || Model.SIMS.equals(any.p);
			boolean docLevel = Model.RAW.equals(any.t) || Model.ATT.equals(any.t);
			if (c == null || t == null || !c.t.equals(t.t) || !Objects.equals(c.p, t.p)) {
				plan.reloadRocket |= rocket || Model.ATT.equals(any.t);
				plan.sims |= sim;
				plan.raw |= Model.RAW.equals(any.t);
				continue;
			}
			Set<String> keys = new TreeSet<>(c.v.keySet());
			keys.addAll(t.v.keySet());
			for (String key : keys) {
				String tv = t.v.get(key);
				if (Objects.equals(c.v.get(key), tv)) {
					continue;
				}
				if (rocket) {
					Xml.El el;
					try {
						el = tv == null ? null : Xml.parse(tv);
					} catch (Exception e) {
						el = null;
					}
					if (el != null && !el.hasElementChildren() && key.equals(el.tag)) {
						plan.leafSets.add(new String[] { id, key, tv });
					} else {
						plan.reloadRocket = true;
					}
				} else if (sim) {
					plan.sims = true;
				} else if (Model.ATT.equals(any.t)) {
					plan.reloadRocket = true; // decal images are re-read through a reload
				} else if (docLevel) {
					plan.raw = true;
				}
			}
		}
		Map<String, List<String>> ci = cur.childIndex();
		Map<String, List<String>> ti = target.childIndex();
		Set<String> parents = new HashSet<>(ci.keySet());
		parents.addAll(ti.keySet());
		for (String parent : parents) {
			if (!Objects.equals(ci.get(parent), ti.get(parent))) {
				if (rocketTarget.contains(parent) || rocketCur.contains(parent)) {
					plan.reloadRocket = true;
				} else if (Model.SIMS.equals(parent)) {
					plan.sims = true;
				}
			}
		}
		return plan;
	}

	private void applyToDocument(Model cur, Model target) {
		Plan plan = plan(cur, target);
		if (plan.empty()) {
			expected = target;
			deferred = false;
			return;
		}
		boolean onlyLeaves = !plan.reloadRocket && !plan.sims && !plan.raw;
		if (!onlyLeaves && OrDoc.modalDialogOpen()) {
			// Replacing components under an open modal dialog would invalidate what it edits;
			// retried every second until the dialog closes.
			deferred = true;
			return;
		}
		deferred = false;
		Log.debug("Applying remote changes: " + (plan.reloadRocket ? "reload rocket " : "")
				+ (plan.leafSets.isEmpty() ? "" : plan.leafSets.size() + " properties in place ")
				+ (plan.sims ? "simulations " : "") + (plan.raw ? "document settings" : ""));
		List<String> selection = OrDoc.selectedIds(frame);
		boolean reloaded = false;
		applying = true;
		try {
			if (plan.reloadRocket || !OrDoc.applyLeaves(doc, target, plan.leafSets)) {
				reloadRocket(target);
				reloaded = true;
			}
			syncSimulations(target);
			if (plan.raw) {
				syncDocumentElements(target);
			}
		} catch (Exception e) {
			Log.warn("Applying remote changes failed: " + e);
			e.printStackTrace(System.out);
		} finally {
			applying = false;
		}
		if (reloaded) {
			OrDoc.select(frame, doc, selection);
		}
		verify(target, plan, reloaded);
	}

	private void reloadRocket(Model target) throws Exception {
		OpenRocketDocument loaded = OrDoc.load(target);
		doc.getRocket().loadFrom(loaded.getRocket());
		OrDoc.fixupAfterLoadFrom(doc.getRocket(), loaded.getRocket());
	}

	private static String statusOf(Model.Obj sim) {
		try {
			return Xml.parse("<x" + sim.v.getOrDefault(Model.ATTRS, "") + "/>").attrs.getOrDefault("status", "");
		} catch (Exception e) {
			return "";
		}
	}

	private void syncSimulations(Model target) throws Exception {
		List<String> want = children(target, Model.SIMS);
		Model snap = snapshot();
		Map<String, Simulation> byId = new HashMap<>();
		for (Simulation s : doc.getSimulations()) {
			byId.put(simIds.get(s), s);
		}
		Set<String> replace = new HashSet<>();
		for (String id : want) {
			Model.Obj t = target.get(id);
			Model.Obj s = snap.get(id);
			Simulation live = byId.get(id);
			if (live == null || s == null) {
				replace.add(id);
				continue;
			}
			Set<String> differing = new HashSet<>();
			Set<String> keys = new HashSet<>(t.v.keySet());
			keys.addAll(s.v.keySet());
			for (String key : keys) {
				if (!Model.equivalent(t.v.get(key), s.v.get(key))) {
					differing.add(key);
				}
			}
			if (differing.isEmpty()) {
				continue;
			}
			if (differing.equals(Collections.singleton(Model.ATTRS))
					&& "uptodate".equals(statusOf(t)) && "outdated".equals(statusOf(s))) {
				live.syncModID(); // results still valid; a reload only re-created the configurations
				continue;
			}
			if (differing.equals(Collections.singleton("name"))) {
				live.setName(Xml.parse(t.v.get("name")).text());
				continue;
			}
			replace.add(id);
		}
		for (Simulation s : new ArrayList<>(doc.getSimulations())) {
			String id = simIds.get(s);
			if (id == null || !want.contains(id)) {
				doc.removeSimulation(s);
				simIds.remove(s);
			}
		}
		if (!replace.isEmpty()) {
			OpenRocketDocument loaded = OrDoc.load(target);
			List<Simulation> loadedSims = loaded.getSimulations();
			if (loadedSims.size() != want.size()) {
				Log.warn("Simulation count mismatch after load (" + loadedSims.size() + " vs " + want.size() + ")");
			}
			for (int i = 0; i < want.size() && i < loadedSims.size(); i++) {
				String id = want.get(i);
				if (!replace.contains(id)) {
					continue;
				}
				Model.Obj t = target.get(id);
				boolean current = t.v.containsKey("flightdata")
						&& Model.basis(target.rocketFingerprint(), t).equals(t.v.get("#basis"));
				// Results computed for an earlier version of the design are shown as outdated.
				Simulation fresh = OrDoc.adoptSimulation(doc, loadedSims.get(i), current ? statusOf(t) : "outdated");
				Log.debug("Replacing simulation " + fresh.getName() + " (" + statusOf(target.get(id)) + ")");
				Simulation old = byId.get(id);
				int index = Math.min(i, doc.getSimulationCount());
				if (old != null && doc.getSimulations().contains(old)) {
					index = doc.getSimulationIndex(old);
					doc.removeSimulation(old);
					simIds.remove(old);
				}
				doc.addSimulation(fresh, index);
				simIds.put(fresh, id);
				if (fresh.getSimulatedData() != null) {
					foreignResults.add(fresh.getSimulatedData());
				}
				fresh.syncModID();
			}
		}
		for (int i = 0; i < want.size(); i++) {
			String id = want.get(i);
			if (i < doc.getSimulationCount() && id.equals(simIds.get(doc.getSimulation(i)))) {
				continue;
			}
			for (Simulation s : new ArrayList<>(doc.getSimulations())) {
				if (id.equals(simIds.get(s))) {
					doc.removeSimulation(s);
					doc.addSimulation(s, Math.min(i, doc.getSimulationCount()));
					break;
				}
			}
		}
	}

	private void syncDocumentElements(Model target) throws Exception {
		OpenRocketDocument loaded = OrDoc.load(target);
		OrDoc.copyCustomExpressions(loaded, doc);
		OrDoc.copyPhotoSettings(loaded, doc);
		try {
			OrDoc.copyDocumentPreferences(loaded, doc);
		} catch (Exception e) {
			Log.warn("Document preferences not synced: " + e);
		}
	}

	/**
	 * Checks that what was applied took effect: rocket structure, the properties set in place
	 * and the simulations. Values OpenRocket derives itself are not compared (they are
	 * recomputed by every client). One full reload is tried before giving up.
	 */
	private void verify(Model target, Plan plan, boolean reloaded) {
		expected = target;
		Model snap;
		try {
			snap = snapshot();
		} catch (Exception e) {
			Log.warn("Verification snapshot failed: " + e);
			return;
		}
		List<String> problems = new ArrayList<>();
		if (!Model.sameRocketStructure(target, snap)) {
			problems.add("rocket structure");
		}
		for (String[] leaf : plan.leafSets) {
			Model.Obj o = snap.get(leaf[0]);
			if (o == null || !Model.equivalent(o.v.get(leaf[1]), leaf[2])) {
				problems.add(leaf[0] + "." + leaf[1]);
			}
		}
		if (!problems.isEmpty() && !reloaded && !OrDoc.modalDialogOpen()) {
			Log.debug("Applied in place but " + problems + " differ; reloading rocket");
			List<String> selection = OrDoc.selectedIds(frame);
			applying = true;
			try {
				reloadRocket(target);
				syncSimulations(target);
			} catch (Exception e) {
				Log.warn("Reload failed: " + e);
			} finally {
				applying = false;
			}
			OrDoc.select(frame, doc, selection);
			verify(target, plan, true);
			return;
		}
		for (String id : children(target, Model.SIMS)) {
			Model.Obj t = target.get(id);
			Model.Obj s = snap.get(id);
			if (s == null || !t.k.equals(s.k)) {
				problems.add("simulation " + id);
			}
		}
		if (!problems.isEmpty()) {
			Log.info("Document differs from shared state after applying remote changes: " + problems);
		}
	}
}
