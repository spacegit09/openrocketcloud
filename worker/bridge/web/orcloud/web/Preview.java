package orcloud.web;

import java.awt.Shape;
import java.awt.geom.PathIterator;
import java.awt.geom.Rectangle2D;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

import javax.swing.Timer;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.MotorMount;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.LineStyle;
import info.openrocket.core.util.ORColor;
import info.openrocket.swing.gui.rocketfigure.RocketComponentShapes;
import info.openrocket.swing.gui.scalefigure.RocketFigure;
import info.openrocket.swing.gui.scalefigure.RocketPanel;
import info.openrocket.swing.gui.util.ColorConversion;
import info.openrocket.swing.gui.util.SwingPreferences;

/**
 * The design's preview for its card on the page's dashboard (browser version): OpenRocket's own
 * side view, the shapes its design window draws (taken from a RocketFigure of the rocket) and the
 * motors of the selected configuration, as SVG paths in millimetres (the format is described in
 * server/src/preview.js). Made a while after the design opens, and again a few seconds after each
 * change; the page passes it to the design's room, which keeps it on the design's record. The
 * dashboard draws the designs that have none yet with {@link #of} (orcloud.bridge.FlightLab).
 */
public final class Preview {
	/** After the design opens: once start-up (the component presets) is done with. */
	private static final int FIRST_MS = 8000;
	/** After a change, once the edits have settled. */
	private static final int AFTER_CHANGE_MS = 3000;
	/**
	 * Kept small (a few thousand characters is usual): on a coarser grid when longer, which a card
	 * cannot show apart. server/src/preview.js accepts up to 200,000, and 60,000 for one shape.
	 */
	private static final int MAX_CHARS = 40_000;
	private static final int MAX_PATH = 30_000;
	/** The grid the drawing is on: this many steps across the rocket's size, at most 0.1 mm each. */
	private static final double GRID_STEPS = 2000;
	private static final double MIN_GRID = 0.0001;
	/** Simplified lines stay within this many grid steps of the line drawn. */
	private static final double TOLERANCE = 1.0;

	private final Rocket rocket;
	private final RocketFigure figure;
	private final Method updateShapes;
	private final Field sideShapes;
	private String sent = "";
	private Timer timer;

	/** The open design's (the browser version opens one). */
	private static volatile Preview current;

	private Preview(Rocket rocket) throws ReflectiveOperationException {
		this.rocket = rocket;
		figure = new RocketFigure(rocket);
		figure.setType(RocketPanel.VIEW_TYPE.SideView);
		updateShapes = RocketFigure.class.getDeclaredMethod("updateShapes", PriorityQueue.class);
		updateShapes.setAccessible(true);
		sideShapes = RocketFigure.class.getDeclaredField("figureShapes_side");
		sideShapes.setAccessible(true);
	}

	/** Hands the preview (JSON) to the page. */
	private static native void jsPreview(String json);

	/** Sends the design's preview from now on (on the UI thread). */
	public static void install(OpenRocketDocument doc) {
		Preview p;
		try {
			p = new Preview(doc.getRocket());
		} catch (ReflectiveOperationException | RuntimeException e) {
			System.err.println("Design preview unavailable: " + e);
			return;
		}
		Timer timer = new Timer(FIRST_MS, e -> p.send());
		timer.setRepeats(false);
		timer.start();
		p.timer = timer;
		current = p;
		doc.getRocket().addComponentChangeListener(e -> {
			timer.setInitialDelay(AFTER_CHANGE_MS);
			timer.restart();
		});
	}

	/** Sends a preview that is still waiting now, as the design closes (on the UI thread). */
	public static void flush() {
		Preview p = current;
		if (p != null && p.timer.isRunning()) {
			p.timer.stop();
			p.send();
		}
	}

	/** The rocket's preview (JSON), or null if it is too large to keep (on the UI thread). */
	public static String of(Rocket rocket) throws ReflectiveOperationException {
		return new Preview(rocket).compose();
	}

	/**
	 * Drawn on a grid of 1/2000 of the rocket's size (a fraction of a pixel on a card), coarser if
	 * that is too large to keep.
	 */
	private String compose() throws ReflectiveOperationException {
		List<Item> items = items();
		for (int coarser = 1; coarser <= 27; coarser *= 3) {
			String json = json(items, coarser);
			if (json != null) {
				return json;
			}
		}
		return null;
	}

	private void send() {
		try {
			String json = compose();
			if (json != null && !json.equals(sent)) {
				sent = json;
				jsPreview(json);
			}
		} catch (Exception e) {
			System.err.println("Design preview failed: " + e);
		}
	}

	/** A shape as the design window draws it. */
	private static final class Item {
		final Shape shape;
		final LineStyle style;
		final String color; // a colour chosen in OpenRocket, or null
		final boolean motor;

		Item(Shape shape, LineStyle style, String color, boolean motor) {
			this.shape = shape;
			this.style = style;
			this.color = color;
			this.motor = motor;
		}
	}

	@SuppressWarnings("unchecked")
	private List<Item> items() throws ReflectiveOperationException {
		PriorityQueue<RocketComponentShapes> shapes = (PriorityQueue<RocketComponentShapes>) sideShapes.get(figure);
		updateShapes.invoke(figure, shapes);
		ApplicationPreferences prefs = Application.getPreferences();
		List<Item> items = new ArrayList<>();
		// In the order the design window draws them.
		PriorityQueue<RocketComponentShapes> queue = new PriorityQueue<>(shapes);
		while (!queue.isEmpty()) {
			RocketComponentShapes r = queue.poll();
			RocketComponent c = r.getComponent();
			if (!r.hasShape || r.shape == null || c == null || !c.isVisible()) {
				continue;
			}
			ORColor own = r.color;
			if (own != null && ColorConversion.toAwtColor(own).getAlpha() == 0) {
				continue; // not drawn (the area of an imported 3D model, kept for clicking)
			}
			LineStyle style = r.lineStyle != null ? r.lineStyle : prefs.getDefaultLineStyle(c.getClass());
			String color = null;
			ORColor usual = ((SwingPreferences) prefs).getDefaultColor(c.getClass());
			if (own != null && (usual == null || ColorConversion.toAwtColor(own).getRGB() != ColorConversion.toAwtColor(usual).getRGB())) {
				color = String.format("#%06x", ColorConversion.toAwtColor(own).getRGB() & 0xffffff);
			}
			items.add(new Item(r.shape, style, color, false));
		}
		FlightConfiguration config = rocket.getSelectedConfiguration();
		for (MotorConfiguration mc : config.getActiveMotors()) {
			MotorMount mount = mc.getMount();
			Motor motor = mc.getMotor();
			if (motor == null || mount == null || !((RocketComponent) mount).isVisible()) {
				continue;
			}
			double length = motor.getLength();
			double radius = motor.getDiameter() / 2;
			for (Coordinate at : mount.getComponentLocations()) {
				Coordinate p = at.add(mount.getMotorPosition(config.getId()));
				items.add(new Item(new Rectangle2D.Double(p.x, p.y - radius, length, 2 * radius), null, null, true));
			}
		}
		return items;
	}

	/** The preview on a grid `coarser` times the finest, or null if it is too large to keep. */
	private static String json(List<Item> items, int coarser) {
		Rectangle2D bounds = null;
		for (Item it : items) {
			Rectangle2D b = it.shape.getBounds2D();
			bounds = bounds == null ? b : bounds.createUnion(b);
		}
		if (bounds == null) {
			return "{\"v\":1,\"s\":[]}"; // nothing to draw: the card shows its usual rocket
		}
		double grid = Math.max(MIN_GRID, Math.max(bounds.getWidth(), bounds.getHeight()) / GRID_STEPS) * coarser;
		StringBuilder s = new StringBuilder();
		for (Item it : items) {
			String d = path(it.shape, grid);
			if (d.isEmpty()) {
				continue;
			}
			if (d.length() > MAX_PATH) {
				return null;
			}
			if (s.length() > 0) {
				s.append(',');
			}
			s.append("{\"d\":\"").append(d).append('"');
			if (it.style == LineStyle.DASHED) {
				s.append(",\"k\":\"dashed\"");
			} else if (it.style == LineStyle.DOTTED) {
				s.append(",\"k\":\"dotted\"");
			} else if (it.style == LineStyle.DASHDOT) {
				s.append(",\"k\":\"dashdot\"");
			}
			if (it.color != null) {
				s.append(",\"c\":\"").append(it.color).append('"');
			}
			if (it.motor) {
				s.append(",\"m\":1");
			}
			s.append('}');
			if (s.length() > MAX_CHARS) {
				return null;
			}
		}
		// SVG's y runs down; the design window's runs up.
		return "{\"v\":1,\"box\":[" + mm(bounds.getMinX()) + "," + mm(-bounds.getMaxY()) + "," + mm(bounds.getWidth()) + ","
				+ mm(bounds.getHeight()) + "],\"s\":[" + s + "]}";
	}

	/**
	 * SVG path data in millimetres, y downwards, with its points on the grid (metres). Runs of
	 * straight lines are joined where they meet and simplified within the grid: an imported 3D
	 * model's outline comes as thousands of separate edges of its mesh. Runs with curves are kept as
	 * they are.
	 */
	private static String path(Shape shape, double grid) {
		StringBuilder b = new StringBuilder();
		List<long[]> lines = new ArrayList<>(); // straight runs: x0, y0, x1, y1, ... in grid steps
		List<Boolean> closed = new ArrayList<>();
		List<long[]> run = new ArrayList<>(); // the current run's segments: { type, x, y[, x, y[, x, y]] }
		long[] start = { 0, 0 };
		double[] c = new double[6];
		for (PathIterator it = shape.getPathIterator(null); ; it.next()) {
			boolean done = it.isDone();
			int type = done ? PathIterator.SEG_MOVETO : it.currentSegment(c);
			if (type == PathIterator.SEG_MOVETO || type == PathIterator.SEG_CLOSE) {
				endRun(run, type == PathIterator.SEG_CLOSE, b, lines, closed, grid);
				if (done) {
					break;
				}
				if (type == PathIterator.SEG_CLOSE) {
					continue;
				}
			}
			int points = type == PathIterator.SEG_QUADTO ? 2 : type == PathIterator.SEG_CUBICTO ? 3 : 1;
			long[] seg = new long[1 + 2 * points];
			seg[0] = type;
			for (int i = 0; i < points; i++) {
				seg[1 + 2 * i] = Math.round(c[2 * i] / grid);
				seg[2 + 2 * i] = Math.round(-c[2 * i + 1] / grid);
			}
			if (type == PathIterator.SEG_MOVETO) {
				start = new long[] { seg[1], seg[2] };
			} else if (run.isEmpty()) {
				run.add(new long[] { PathIterator.SEG_MOVETO, start[0], start[1] }); // goes on after a close
			}
			run.add(seg);
		}
		for (long[] line : join(lines, closed)) {
			long[] p = simplify(line);
			for (int i = 0; i < p.length; i += 2) {
				b.append(i == 0 ? 'M' : 'L').append(step(p[i], grid)).append(' ').append(step(p[i + 1], grid));
			}
			if (p.length > 4 && p[0] == p[p.length - 2] && p[1] == p[p.length - 1]) {
				b.append('Z');
			}
		}
		return b.toString();
	}

	/** Ends a run of segments: one with curves goes into the path data, a straight one into `lines`. */
	private static void endRun(List<long[]> run, boolean close, StringBuilder b, List<long[]> lines, List<Boolean> closed, double grid) {
		boolean curved = false;
		for (long[] seg : run) {
			curved |= seg[0] == PathIterator.SEG_QUADTO || seg[0] == PathIterator.SEG_CUBICTO;
		}
		if (curved) {
			for (long[] seg : run) {
				b.append(seg[0] == PathIterator.SEG_MOVETO ? 'M' : seg[0] == PathIterator.SEG_LINETO ? 'L' : seg[0] == PathIterator.SEG_QUADTO ? 'Q' : 'C');
				for (int i = 1; i < seg.length; i += 2) {
					b.append(i > 1 ? " " : "").append(step(seg[i], grid)).append(' ').append(step(seg[i + 1], grid));
				}
			}
			if (close) {
				b.append('Z');
			}
		} else {
			List<Long> points = new ArrayList<>();
			for (long[] seg : run) {
				int n = points.size();
				if (n < 2 || points.get(n - 2) != seg[1] || points.get(n - 1) != seg[2]) {
					points.add(seg[1]);
					points.add(seg[2]);
				}
			}
			if (points.size() >= 4) {
				lines.add(toArray(points));
				closed.add(close);
			}
		}
		run.clear();
	}

	private static long[] toArray(List<Long> v) {
		long[] a = new long[v.size()];
		for (int i = 0; i < a.length; i++) {
			a[i] = v.get(i);
		}
		return a;
	}

	/**
	 * Joins open runs that meet end to end, after dropping repeated single edges; closed runs (made
	 * to end where they start) are left as they are.
	 */
	private static List<long[]> join(List<long[]> lines, List<Boolean> closed) {
		List<long[]> out = new ArrayList<>();
		Map<Long, List<Integer>> ends = new HashMap<>(); // a point -> the open runs ending there
		List<long[]> open = new ArrayList<>();
		Set<String> edges = new HashSet<>();
		for (int i = 0; i < lines.size(); i++) {
			long[] l = lines.get(i);
			if (closed.get(i)) {
				long[] z = Arrays.copyOf(l, l.length + 2);
				z[l.length] = l[0];
				z[l.length + 1] = l[1];
				out.add(z);
				continue;
			}
			if (l.length == 4) {
				long a = key(l[0], l[1]), b = key(l[2], l[3]);
				if (!edges.add(Math.min(a, b) + ":" + Math.max(a, b))) {
					continue; // the same edge again
				}
			}
			open.add(l);
		}
		for (int i = 0; i < open.size(); i++) {
			long[] l = open.get(i);
			ends.computeIfAbsent(key(l[0], l[1]), k -> new ArrayList<>()).add(i);
			ends.computeIfAbsent(key(l[l.length - 2], l[l.length - 1]), k -> new ArrayList<>()).add(i);
		}
		boolean[] used = new boolean[open.size()];
		for (int i = 0; i < open.size(); i++) {
			if (used[i]) {
				continue;
			}
			used[i] = true;
			List<Long> chain = new ArrayList<>();
			for (long v : open.get(i)) {
				chain.add(v);
			}
			// Forwards from its end, then backwards from its start.
			for (int pass = 0; pass < 2; pass++) {
				while (true) {
					long at = key(chain.get(chain.size() - 2), chain.get(chain.size() - 1));
					int next = -1;
					for (int j : ends.getOrDefault(at, List.of())) {
						if (!used[j]) {
							next = j;
							break;
						}
					}
					if (next < 0) {
						break;
					}
					used[next] = true;
					long[] n = open.get(next);
					boolean forward = key(n[0], n[1]) == at;
					for (int k = 2; k < n.length; k += 2) {
						int idx = forward ? k : n.length - 2 - k;
						chain.add(n[idx]);
						chain.add(n[idx + 1]);
					}
				}
				Collections.reverse(chain);
				// The pairs were reversed too: put each point's x before its y again.
				for (int k = 0; k < chain.size(); k += 2) {
					Collections.swap(chain, k, k + 1);
				}
			}
			out.add(toArray(chain));
		}
		return out;
	}

	private static long key(long x, long y) {
		return (x << 32) ^ (y & 0xffffffffL);
	}

	/** Douglas-Peucker: the points that keep the line within the grid. */
	private static long[] simplify(long[] p) {
		int n = p.length / 2;
		if (n <= 2) {
			return p;
		}
		boolean[] keep = new boolean[n];
		keep[0] = keep[n - 1] = true;
		Deque<int[]> todo = new ArrayDeque<>();
		todo.push(new int[] { 0, n - 1 });
		while (!todo.isEmpty()) {
			int[] r = todo.pop();
			int a = r[0], z = r[1];
			double ax = p[2 * a], ay = p[2 * a + 1], dx = p[2 * z] - ax, dy = p[2 * z + 1] - ay;
			double len = Math.hypot(dx, dy);
			int far = -1;
			double worst = TOLERANCE;
			for (int i = a + 1; i < z; i++) {
				double ex = p[2 * i] - ax, ey = p[2 * i + 1] - ay;
				double dist = len == 0 ? Math.hypot(ex, ey) : Math.abs(ex * dy - ey * dx) / len;
				if (dist > worst) {
					worst = dist;
					far = i;
				}
			}
			if (far >= 0) {
				keep[far] = true;
				todo.push(new int[] { a, far });
				todo.push(new int[] { far, z });
			}
		}
		long[] out = new long[p.length];
		int k = 0;
		for (int i = 0; i < n; i++) {
			if (keep[i]) {
				out[k++] = p[2 * i];
				out[k++] = p[2 * i + 1];
			}
		}
		return Arrays.copyOf(out, k);
	}

	/** A grid position as millimetres. */
	private static String step(long steps, double grid) {
		return mm(steps * grid);
	}

	/** Metres as millimetres, to a tenth. */
	private static String mm(double metres) {
		if (!Double.isFinite(metres)) {
			return "0";
		}
		long tenths = Math.round(metres * 10000);
		String sign = tenths < 0 ? "-" : "";
		long a = Math.abs(tenths);
		return a % 10 == 0 ? sign + (a / 10) : sign + (a / 10) + "." + (a % 10);
	}
}
