/*
 * Replacement of OpenRocket 24.12's RocketFigure3d (GPL-3.0, (c) the OpenRocket team; the original
 * by Bill Kuker) for the browser build, placed ahead of OpenRocket.jar on the class path. The
 * original draws with OpenGL through JOGL's native libraries, which a browser cannot load, so the
 * 3D view was blank. This one keeps the class's public interface, which RocketPanel, BasicFrame and
 * DesignPanel use, and hands the drawing to the page's WebGL renderer through orcloud.web.View3d:
 * the meshes come from OpenRocket's OBJ exporters, coloured as OpenRocket's three 3D renderers do.
 * Rotating (drag), moving the light (right-drag), clicking parts to select or edit them (shift to
 * reach past selected ones), the CG and CP marks and the rocket information overlay work as before;
 * the mouse wheel also zooms.
 */
package info.openrocket.swing.gui.figure3d;

import java.awt.BorderLayout;
import java.awt.Color;
import java.awt.Graphics;
import java.awt.Graphics2D;
import java.awt.Rectangle;
import java.awt.event.MouseEvent;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.Set;

import javax.swing.JPanel;
import javax.swing.JPopupMenu;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.preferences.ApplicationPreferences;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.startup.Application;
import info.openrocket.core.util.Coordinate;
import info.openrocket.swing.gui.figureelements.FigureElement;
import info.openrocket.swing.gui.theme.UITheme;
import info.openrocket.swing.gui.util.GUIUtil;
import orcloud.web.View3d;

public class RocketFigure3d extends JPanel {

	public static final int TYPE_FIGURE = 2;
	public static final int TYPE_UNFINISHED = 3;
	public static final int TYPE_FINISHED = 4;

	private static final long serialVersionUID = 1L;

	static {
		// As in the original: menus and combo box lists open as their own windows, so they show
		// above the 3D view (here a WebGL canvas over the window) instead of under it.
		JPopupMenu.setDefaultLightWeightPopupEnabled(false);
	}

	private static Color backgroundColor;

	static {
		updateColors();
		UITheme.Theme.addUIThemeChangeListener(RocketFigure3d::updateColors);
	}

	private final transient View3d view;

	private final ArrayList<FigureElement> relativeExtra = new ArrayList<>();
	private final ArrayList<FigureElement> absoluteExtra = new ArrayList<>();
	private final Set<RocketComponent> selection = new LinkedHashSet<>();
	private Coordinate cp = new Coordinate(0, 0, 0);
	private Coordinate cg = new Coordinate(0, 0, 0);
	private boolean drawCarets = true;
	private int type = TYPE_FIGURE;
	private ComponentSelectionListener csl;

	public RocketFigure3d(final OpenRocketDocument document) {
		this.setLayout(new BorderLayout());
		view = is3dEnabled() ? new View3d(this, document, this::paintExtras, this::clicked) : null;
		if (view != null) {
			view.setType(type);
		}
	}

	public static void updateColors() {
		backgroundColor = GUIUtil.getUITheme().getBackgroundColor();
	}

	public void flushTextureCaches() {
		if (view != null) {
			view.flushTextures();
		}
	}

	/**
	 * Return true if 3d view is enabled. This may be toggled by the user in the preferences.
	 */
	public static boolean is3dEnabled() {
		return Application.getPreferences().getBoolean(ApplicationPreferences.OPENGL_ENABLED, true);
	}

	/**
	 * Call when the rocket has changed
	 */
	public void updateFigure() {
		if (view != null) {
			view.sceneChanged();
		}
	}

	@Override
	public void repaint() {
		if (view != null) {
			view.overlayChanged();
		}
		super.repaint();
	}

	@Override
	protected void paintComponent(Graphics g) {
		super.paintComponent(g);
		if (view != null) {
			view.painted(backgroundColor);
		}
	}

	private void paintExtras(Graphics2D g) {
		for (FigureElement e : relativeExtra) {
			e.paint(g, 1);
		}
		Rectangle rect = this.getVisibleRect();
		for (FigureElement e : absoluteExtra) {
			e.paint(g, 1.0, rect);
		}
	}

	private void clicked(RocketComponent picked, MouseEvent e) {
		if (csl != null) {
			csl.componentClicked(picked == null ? new RocketComponent[] {} : new RocketComponent[] { picked }, e);
		}
	}

	public void setSelection(final RocketComponent[] selection) {
		this.selection.clear();
		if (selection != null) {
			this.selection.addAll(Arrays.asList(selection));
		}
		stateChanged();
	}

	public void setCG(final Coordinate cg) {
		this.cg = cg;
		stateChanged();
		repaint(); // the rocket information shown with the marks changed too
	}

	public void setCP(final Coordinate cp) {
		this.cp = cp;
		stateChanged();
		repaint();
	}

	private void stateChanged() {
		if (view != null) {
			view.setState(selection, cg, cp, drawCarets, backgroundColor);
		}
	}

	public void addRelativeExtra(final FigureElement p) {
		relativeExtra.add(p);
		repaint();
	}

	public void removeRelativeExtra(final FigureElement p) {
		relativeExtra.remove(p);
		repaint();
	}

	public void clearRelativeExtra() {
		relativeExtra.clear();
		repaint();
	}

	public void addAbsoluteExtra(final FigureElement p) {
		absoluteExtra.add(p);
		repaint();
	}

	public void removeAbsoluteExtra(final FigureElement p) {
		absoluteExtra.remove(p);
		repaint();
	}

	public void clearAbsoluteExtra() {
		absoluteExtra.clear();
		repaint();
	}

	public static interface ComponentSelectionListener {
		public void componentClicked(RocketComponent[] components, MouseEvent e);
	}

	public void addComponentSelectionListener(ComponentSelectionListener newListener) {
		this.csl = newListener;
	}

	public void setType(final int t) {
		type = t;
		if (view != null) {
			view.setType(t);
		}
	}

	public boolean isDrawCarets() {
		return drawCarets;
	}

	public void setDrawCarets(boolean drawCarets) {
		this.drawCarets = drawCarets;
		stateChanged();
	}
}
