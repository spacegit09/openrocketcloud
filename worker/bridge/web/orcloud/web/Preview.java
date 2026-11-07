package orcloud.web;

import java.awt.Shape;
import java.awt.geom.PathIterator;
import java.awt.geom.Rectangle2D;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.PriorityQueue;

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
 * change; the page passes it to the design's room, which keeps it on the design's record.
 */
public final class Preview {
	/** After the design opens: once start-up (the component presets) is done with. */
	private static final int FIRST_MS = 8000;
	/** After a change, once the edits have settled. */
	private static final int AFTER_CHANGE_MS = 3000;
	private static final int MAX_CHARS = 190_000;

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

	private void send() {
		try {
			String json = json(1);
			if (json.length() > MAX_CHARS) {
				json = json(0); // whole millimetres
			}
			if (json.length() <= MAX_CHARS && !json.equals(sent)) {
				sent = json;
				jsPreview(json);
			}
		} catch (Exception e) {
			System.err.println("Design preview failed: " + e);
		}
	}

	@SuppressWarnings("unchecked")
	private String json(int decimals) throws ReflectiveOperationException {
		PriorityQueue<RocketComponentShapes> shapes = (PriorityQueue<RocketComponentShapes>) sideShapes.get(figure);
		updateShapes.invoke(figure, shapes);
		ApplicationPreferences prefs = Application.getPreferences();
		StringBuilder s = new StringBuilder();
		Rectangle2D bounds = null;
		// In the order the design window draws them.
		PriorityQueue<RocketComponentShapes> queue = new PriorityQueue<>(shapes);
		while (!queue.isEmpty()) {
			RocketComponentShapes r = queue.poll();
			RocketComponent c = r.getComponent();
			if (!r.hasShape || r.shape == null || c == null || !c.isVisible()) {
				continue;
			}
			LineStyle style = r.lineStyle != null ? r.lineStyle : prefs.getDefaultLineStyle(c.getClass());
			String color = null;
			ORColor own = r.color;
			ORColor usual = ((SwingPreferences) prefs).getDefaultColor(c.getClass());
			if (own != null && (usual == null || ColorConversion.toAwtColor(own).getRGB() != ColorConversion.toAwtColor(usual).getRGB())) {
				color = String.format("#%06x", ColorConversion.toAwtColor(own).getRGB() & 0xffffff);
			}
			bounds = add(s, r.shape, style, color, false, bounds, decimals);
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
				bounds = add(s, new Rectangle2D.Double(p.x, p.y - radius, length, 2 * radius), null, null, true, bounds, decimals);
			}
		}
		if (bounds == null) {
			return "{\"v\":1,\"s\":[]}"; // nothing to draw: the card shows its usual rocket
		}
		// SVG's y runs down; the design window's runs up.
		return "{\"v\":1,\"box\":[" + num(bounds.getMinX(), decimals) + "," + num(-bounds.getMaxY(), decimals) + ","
				+ num(bounds.getWidth(), decimals) + "," + num(bounds.getHeight(), decimals) + "],\"s\":[" + s + "]}";
	}

	private static Rectangle2D add(StringBuilder s, Shape shape, LineStyle style, String color, boolean motor, Rectangle2D bounds,
			int decimals) {
		String d = path(shape, decimals);
		if (d.isEmpty()) {
			return bounds;
		}
		if (s.length() > 0) {
			s.append(',');
		}
		s.append("{\"d\":\"").append(d).append('"');
		if (style == LineStyle.DASHED) {
			s.append(",\"k\":\"dashed\"");
		} else if (style == LineStyle.DOTTED) {
			s.append(",\"k\":\"dotted\"");
		} else if (style == LineStyle.DASHDOT) {
			s.append(",\"k\":\"dashdot\"");
		}
		if (color != null) {
			s.append(",\"c\":\"").append(color).append('"');
		}
		if (motor) {
			s.append(",\"m\":1");
		}
		s.append('}');
		Rectangle2D b = shape.getBounds2D();
		return bounds == null ? b : bounds.createUnion(b);
	}

	/** SVG path data in millimetres, y downwards. */
	private static String path(Shape shape, int decimals) {
		StringBuilder b = new StringBuilder();
		double[] c = new double[6];
		for (PathIterator it = shape.getPathIterator(null); !it.isDone(); it.next()) {
			int type = it.currentSegment(c);
			int points;
			switch (type) {
				case PathIterator.SEG_MOVETO:
					b.append('M');
					points = 1;
					break;
				case PathIterator.SEG_LINETO:
					b.append('L');
					points = 1;
					break;
				case PathIterator.SEG_QUADTO:
					b.append('Q');
					points = 2;
					break;
				case PathIterator.SEG_CUBICTO:
					b.append('C');
					points = 3;
					break;
				default:
					b.append('Z');
					points = 0;
			}
			for (int i = 0; i < points; i++) {
				if (i > 0) {
					b.append(' ');
				}
				b.append(num(c[2 * i], decimals)).append(' ').append(num(-c[2 * i + 1], decimals));
			}
		}
		return b.toString();
	}

	/** Metres as millimetres with up to `decimals` (0 or 1) decimals. */
	private static String num(double metres, int decimals) {
		if (!Double.isFinite(metres)) {
			return "0";
		}
		long tenths = Math.round(metres * 10000);
		if (decimals == 0) {
			return Long.toString(Math.round(metres * 1000));
		}
		String sign = tenths < 0 ? "-" : "";
		long a = Math.abs(tenths);
		return a % 10 == 0 ? sign + (a / 10) : sign + (a / 10) + "." + (a % 10);
	}
}
