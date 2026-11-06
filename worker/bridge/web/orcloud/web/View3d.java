package orcloud.web;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.Point;
import java.awt.Rectangle;
import java.awt.RenderingHints;
import java.awt.Window;
import java.awt.event.ComponentAdapter;
import java.awt.event.ComponentEvent;
import java.awt.event.HierarchyBoundsAdapter;
import java.awt.event.HierarchyEvent;
import java.awt.event.InputEvent;
import java.awt.event.MouseEvent;
import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

import javax.swing.JComponent;
import javax.swing.SwingUtilities;

import info.openrocket.core.appearance.DecalImage;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.wavefrontobj.ObjUtils.LevelOfDetail;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.util.BoundingBox;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.ORColor;
import info.openrocket.swing.gui.figureelements.CGCaret;
import info.openrocket.swing.gui.figureelements.CPCaret;
import info.openrocket.swing.gui.figureelements.FigureElement;
import info.openrocket.swing.gui.util.SwingPreferences;
import orcloud.view3d.Looks;
import orcloud.view3d.RocketMesh;

/**
 * OpenRocket's 3D view in the browser: the page draws it with WebGL (web/src/view3d.js) in a canvas
 * laid over the view's panel, and this side tells the page what to draw: the meshes and looks of
 * the selected configuration ({@link RocketMesh}, {@link Looks}), decal images, the selection, the
 * CG and CP marks, the rocket information painted by OpenRocket's figure elements, and where the
 * panel is. Clicks on parts come back as events. All of it runs on the Swing thread, coalesced.
 */
public final class View3d {
	private static native void jsScene(int view, String json, int[] faceSizes, int faceCount, float[] vertices, int floatCount);

	private static native void jsTexture(int id, byte[] data, int length);

	private static native void jsPlace(int view, int windowX, int windowY, int windowWidth, int windowHeight, int x, int y,
			int width, int height);

	private static native void jsState(int view, String json);

	private static native void jsOverlay(int view, int width, int height, int[] argb);

	private static native void jsCarets(int size, int[] cg, int[] cp);

	/** Waits for the next event from the page: "click view generation part x y button modifiers". */
	private static native String jsNext();

	private static final int CARET_SIZE = 20;
	private static final Map<Integer, View3d> views = new ConcurrentHashMap<>();
	private static final Map<DecalImage, Integer> textures = new HashMap<>();
	private static final Map<Class<?>, ORColor> figureColors = new HashMap<>();
	private static int nextView, nextTexture;
	private static boolean started;

	private final int id;
	private final JComponent panel;
	private final OpenRocketDocument document;
	private final Consumer<Graphics2D> extras;
	private final BiConsumer<RocketComponent, MouseEvent> onClick;

	private int type = Looks.FIGURE;
	private boolean sceneDirty = true, stateDirty = true, overlayDirty = true, scheduled;
	private int generation;
	private List<RocketComponent> components = new ArrayList<>();
	private String placed = "";
	private Collection<RocketComponent> selection = new ArrayList<>();
	private Coordinate cg, cp;
	private boolean carets = true;
	private Color background;
	private int[] overlay;
	private int overlayWidth, overlayHeight;

	/**
	 * @param extras  paints the figure elements over the view
	 * @param onClick receives a click on a part (null for none) and the click as a mouse event
	 */
	public View3d(JComponent panel, OpenRocketDocument document, Consumer<Graphics2D> extras,
			BiConsumer<RocketComponent, MouseEvent> onClick) {
		this.panel = panel;
		this.document = document;
		this.extras = extras;
		this.onClick = onClick;
		synchronized (View3d.class) {
			id = ++nextView;
		}
		views.put(id, this);
		panel.addHierarchyListener(e -> {
			if ((e.getChangeFlags() & (HierarchyEvent.SHOWING_CHANGED | HierarchyEvent.PARENT_CHANGED)) != 0) {
				schedule();
			}
		});
		panel.addHierarchyBoundsListener(new HierarchyBoundsAdapter() {
			@Override
			public void ancestorMoved(HierarchyEvent e) {
				schedule();
			}

			@Override
			public void ancestorResized(HierarchyEvent e) {
				schedule();
			}
		});
		panel.addComponentListener(new ComponentAdapter() {
			@Override
			public void componentResized(ComponentEvent e) {
				schedule();
			}

			@Override
			public void componentMoved(ComponentEvent e) {
				schedule();
			}
		});
	}

	public void setType(int type) {
		this.type = type;
		sceneChanged();
	}

	/** The rocket or its configuration changed. */
	public void sceneChanged() {
		sceneDirty = true;
		schedule();
	}

	public void setState(Collection<RocketComponent> selection, Coordinate cg, Coordinate cp, boolean carets, Color background) {
		this.selection = new ArrayList<>(selection);
		this.cg = cg;
		this.cp = cp;
		this.carets = carets;
		this.background = background;
		stateDirty = true;
		schedule();
	}

	/** The figure elements need painting again. */
	public void overlayChanged() {
		overlayDirty = true;
	}

	/** Decal images may have changed: they are sent again. */
	public void flushTextures() {
		synchronized (textures) {
			textures.clear();
		}
		sceneChanged();
	}

	/** Called when Swing paints the panel: places the canvas and sends the figure elements if changed. */
	public void painted(Color background) {
		if (background != null && !background.equals(this.background)) {
			this.background = background;
			stateDirty = true;
			schedule();
		}
		place();
		if (!panel.isShowing()) {
			return;
		}
		int w = panel.getWidth(), h = panel.getHeight();
		if (w <= 0 || h <= 0 || (!overlayDirty && w == overlayWidth && h == overlayHeight)) {
			return;
		}
		overlayDirty = false;
		BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = img.createGraphics();
		hints(g);
		try {
			extras.accept(g);
		} finally {
			g.dispose();
		}
		int[] px = ((DataBufferInt) img.getRaster().getDataBuffer()).getData();
		if (w == overlayWidth && h == overlayHeight && Arrays.equals(px, overlay)) {
			return;
		}
		overlay = px;
		overlayWidth = w;
		overlayHeight = h;
		jsOverlay(id, w, h, px);
	}

	private void schedule() {
		if (!scheduled) {
			scheduled = true;
			SwingUtilities.invokeLater(this::flush);
		}
	}

	private void flush() {
		scheduled = false;
		place();
		if (!panel.isShowing()) {
			return;
		}
		start();
		if (sceneDirty) {
			sceneDirty = false;
			sendScene();
			stateDirty = true;
		}
		if (stateDirty) {
			stateDirty = false;
			sendState();
		}
	}

	/** Puts the page's canvas over the panel, in the panel's window, or hides it. */
	private void place() {
		Window w = SwingUtilities.getWindowAncestor(panel);
		if (w == null || !panel.isShowing() || panel.getWidth() <= 0 || panel.getHeight() <= 0) {
			if (!placed.equals("hidden")) {
				placed = "hidden";
				jsPlace(id, 0, 0, 0, 0, 0, 0, 0, 0);
			}
			return;
		}
		Point at = SwingUtilities.convertPoint(panel, 0, 0, w);
		Rectangle wb = w.getBounds();
		String p = wb.x + "," + wb.y + "," + wb.width + "," + wb.height + "," + at.x + "," + at.y + "," + panel.getWidth() + ","
				+ panel.getHeight();
		if (!p.equals(placed)) {
			placed = p;
			jsPlace(id, wb.x, wb.y, wb.width, wb.height, at.x, at.y, panel.getWidth(), panel.getHeight());
		}
	}

	private void sendScene() {
		RocketMesh mesh = RocketMesh.of(document.getSelectedConfiguration(), LevelOfDetail.NORMAL_QUALITY);
		components = Looks.components(mesh);
		generation++;
		String look = Looks.json(mesh, type, components, View3d::figureColor, View3d::texture);
		BoundingBox b = mesh.bounds;
		String json = String.format(Locale.ROOT, "{\"generation\":%d,\"bounds\":[%s,%s],\"look\":%s}", generation, xyz(b.min), xyz(b.max),
				look);
		jsScene(id, json, mesh.faceSizes, mesh.faceCount, mesh.vertices, mesh.vertexCount * RocketMesh.STRIDE);
	}

	private void sendState() {
		StringBuilder sel = new StringBuilder();
		for (RocketComponent c : selection) {
			int i = components.indexOf(c);
			if (i >= 0) {
				sel.append(sel.length() > 0 ? "," : "").append(i);
			}
		}
		Color bg = background != null ? background : Color.WHITE;
		jsState(id, String.format(Locale.ROOT, "{\"generation\":%d,\"selection\":[%s],\"cg\":%s,\"cp\":%s,\"carets\":%b,\"background\":[%d,%d,%d]}",
				generation, sel, mark(cg), mark(cp), carets, bg.getRed(), bg.getGreen(), bg.getBlue()));
	}

	private static String xyz(Coordinate c) {
		return String.format(Locale.ROOT, "[%.6f,%.6f,%.6f]", c.x, c.y, c.z);
	}

	/** A CG or CP position for the page (OpenRocket coordinates), or null when not known. */
	private static String mark(Coordinate c) {
		return c == null || Double.isNaN(c.x) || Double.isNaN(c.y) || Double.isNaN(c.z) ? "null" : xyz(c);
	}

	/** OpenRocket's figure colour for a part without its own (Preferences, Graphics). */
	private static ORColor figureColor(RocketComponent c) {
		return figureColors.computeIfAbsent(c.getClass(),
				k -> ((SwingPreferences) Application.getPreferences()).getDefaultColor(c.getClass()));
	}

	/** The page's id for a decal image, sending the image the first time; -1 if it cannot be read. */
	private static int texture(DecalImage image) {
		synchronized (textures) {
			Integer known = textures.get(image);
			if (known != null) {
				return known;
			}
			int id = -1;
			try (InputStream in = image.getBytes()) {
				byte[] data = in.readAllBytes();
				id = ++nextTexture;
				jsTexture(id, data, data.length);
			} catch (Exception e) {
				id = -1;
			}
			textures.put(image, id);
			return id;
		}
	}

	private static void hints(Graphics2D g) {
		g.setRenderingHint(RenderingHints.KEY_STROKE_CONTROL, RenderingHints.VALUE_STROKE_NORMALIZE);
		g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
		g.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON);
	}

	/** Starts the event thread and sends the CG and CP marks, once. */
	private static synchronized void start() {
		if (started) {
			return;
		}
		started = true;
		jsCarets(CARET_SIZE, caret(new CGCaret(CARET_SIZE / 2.0, CARET_SIZE / 2.0)), caret(new CPCaret(CARET_SIZE / 2.0, CARET_SIZE / 2.0)));
		Thread t = new Thread(() -> {
			for (;;) {
				String event = jsNext();
				if (event != null && !event.isEmpty()) {
					SwingUtilities.invokeLater(() -> dispatch(event));
				}
			}
		}, "orcloud-3d-events");
		t.setDaemon(true);
		t.start();
	}

	private static int[] caret(FigureElement caret) {
		BufferedImage img = new BufferedImage(CARET_SIZE, CARET_SIZE, BufferedImage.TYPE_INT_ARGB);
		Graphics2D g = img.createGraphics();
		hints(g);
		caret.paint(g, 1.0);
		g.dispose();
		return ((DataBufferInt) img.getRaster().getDataBuffer()).getData();
	}

	private static void dispatch(String event) {
		String[] f = event.split(" ");
		if (!f[0].equals("click") || f.length < 8) {
			return;
		}
		View3d v = views.get(Integer.parseInt(f[1]));
		if (v == null || Integer.parseInt(f[2]) != v.generation) {
			return; // a click on a scene that has since changed
		}
		int part = Integer.parseInt(f[3]);
		RocketComponent picked = part >= 0 && part < v.components.size() ? v.components.get(part) : null;
		int button = Integer.parseInt(f[6]);
		int keys = Integer.parseInt(f[7]);
		int modifiers = ((keys & 1) != 0 ? InputEvent.SHIFT_DOWN_MASK : 0) | ((keys & 2) != 0 ? InputEvent.CTRL_DOWN_MASK : 0)
				| ((keys & 4) != 0 ? InputEvent.ALT_DOWN_MASK : 0) | ((keys & 8) != 0 ? InputEvent.META_DOWN_MASK : 0);
		MouseEvent e = new MouseEvent(v.panel, MouseEvent.MOUSE_CLICKED, System.currentTimeMillis(), modifiers, Integer.parseInt(f[4]),
				Integer.parseInt(f[5]), 1, button == MouseEvent.BUTTON3, button);
		v.onClick.accept(picked, e);
	}
}
