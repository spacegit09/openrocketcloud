package orcloud.view3d;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;
import java.util.function.ToIntFunction;

import info.openrocket.core.appearance.Appearance;
import info.openrocket.core.appearance.Decal;
import info.openrocket.core.appearance.DecalImage;
import info.openrocket.core.appearance.defaults.DefaultAppearance;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.ExternalComponent;
import info.openrocket.core.rocketcomponent.InsideColorComponent;
import info.openrocket.core.rocketcomponent.InsideColorComponentHandler;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.rocketcomponent.Transition;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.ORColor;

/**
 * How each part of a {@link RocketMesh} is drawn in the three kinds of 3D view, following
 * OpenRocket's renderers (FigureRenderer, UnfinishedRenderer and RealisticRenderer in
 * info.openrocket.swing.gui.figure3d): their light levels, colours, shine, transparency and
 * decal placement, written as JSON for the page's WebGL renderer.
 */
public final class Looks {
	/** The view types, as RocketFigure3d numbers them. */
	public static final int FIGURE = 2, UNFINISHED = 3, FINISHED = 4;

	private Looks() {
	}

	/**
	 * The scene description: light levels, the materials, and each part's material, component
	 * (index into `components`, or -1 for motors, which cannot be picked) and surface.
	 *
	 * @param figureColor the figure colour of a component without its own (OpenRocket's preference)
	 * @param textureId   the page's id for a decal image
	 */
	public static String json(RocketMesh mesh, int type, List<RocketComponent> components,
			Function<RocketComponent, ORColor> figureColor, ToIntFunction<DecalImage> textureId) {
		List<String> materials = new ArrayList<>();
		StringBuilder parts = new StringBuilder();
		for (RocketMesh.Part p : mesh.parts) {
			String m = p.motor != null ? motor(type, p, textureId)
					: p.model ? model(type, p, figureColor, textureId) : component(type, p, figureColor, textureId);
			int mi = materials.indexOf(m);
			if (mi < 0) {
				mi = materials.size();
				materials.add(m);
			}
			if (parts.length() > 0) {
				parts.append(',');
			}
			int ci = p.motor != null ? -1 : components.indexOf(p.component);
			parts.append(String.format(Locale.ROOT, "[%d,%d,%d,%d,%d,%d,%d]", ci, p.surface, mi, p.firstFace, p.faceCount,
					p.firstVertex, p.vertexCount));
		}
		// Light levels of OpenRocket's renderers: ambient, diffuse, specular.
		String light = type == FIGURE ? "[0.3,0.7,1]" : "[0.4,0.65,0.65]";
		return "{\"type\":" + type + ",\"light\":" + light + ",\"materials\":[" + String.join(",", materials) + "],\"parts\":["
				+ parts + "]}";
	}

	/** The components of the mesh in its order, for picking. */
	public static List<RocketComponent> components(RocketMesh mesh) {
		List<RocketComponent> out = new ArrayList<>();
		for (RocketMesh.Part p : mesh.parts) {
			if (p.motor == null && !out.contains(p.component)) {
				out.add(p.component);
			}
		}
		return Collections.unmodifiableList(out);
	}

	private static String component(int type, RocketMesh.Part p, Function<RocketComponent, ORColor> figureColor,
			ToIntFunction<DecalImage> textureId) {
		RocketComponent c = p.component;
		if (type == FIGURE) {
			ORColor color = c.getColor();
			if (color == null) {
				color = figureColor.apply(c);
			}
			float[] rgb = figure(color);
			float shine = finishShine(c);
			if (p.surface == RocketMesh.INSIDE) {
				// FigureRenderer: the inside in a darker shade, always opaque.
				return material(rgb[0] * 0.7f, rgb[1] * 0.7f, rgb[2] * 0.7f, 1, 0, 0, 0, shine, null, false, textureId);
			}
			boolean see = figureTransparent(c);
			float m = shine / 128f;
			return material(rgb[0], rgb[1], rgb[2], see ? 0.2f : 1, Math.max(rgb[0], 0.9f) * m, Math.max(rgb[1], 0.9f) * m,
					Math.max(rgb[2], 0.9f) * m, shine, null, see, textureId);
		}
		Appearance outside = appearance(type, c);
		Appearance a = outside;
		boolean decal = true;
		if (p.surface != RocketMesh.OUTSIDE) {
			Appearance inside = outside;
			if (c instanceof InsideColorComponent) {
				InsideColorComponentHandler h = ((InsideColorComponent) c).getInsideColorComponentHandler();
				if (h.isSeparateInsideOutside()) {
					inside = type == UNFINISHED || h.getInsideAppearance() == null ? DefaultAppearance.getDefaultAppearance(c)
							: h.getInsideAppearance();
				}
				a = p.surface == RocketMesh.INSIDE || h.isEdgesSameAsInside() ? inside : outside;
			}
			// RealisticRenderer puts no decals on edges.
			decal = p.surface == RocketMesh.INSIDE;
		}
		return realistic(type, a, decal, transparent(type, outside), textureId);
	}

	/** Plastic, the look of a 3D-printed part. */
	private static final Appearance PRINTED = new Appearance(new ORColor(232, 232, 228), 0.3);

	/**
	 * An imported 3D model's shape: coloured like any component in the figure view, printed
	 * plastic when unfinished, painted as set in its appearance when finished (no decal: a model
	 * has no texture coordinates). Drawn two-sided, as STL files are not always wound consistently.
	 */
	private static String model(int type, RocketMesh.Part p, Function<RocketComponent, ORColor> figureColor,
			ToIntFunction<DecalImage> textureId) {
		String m;
		if (type == FIGURE) {
			m = component(type, p, figureColor, textureId);
		} else {
			Appearance a = type == FINISHED && p.component.getAppearance() != null ? p.component.getAppearance() : PRINTED;
			m = realistic(type, a, false, transparent(type, a), textureId);
		}
		return m.substring(0, m.length() - 1) + ",\"double\":true}";
	}

	private static String motor(int type, RocketMesh.Part p, ToIntFunction<DecalImage> textureId) {
		if (type == FIGURE) {
			return material(0.3f, 0.3f, 0.3f, 1, 0, 0, 0, 0, null, false, textureId);
		}
		return realistic(type, DefaultAppearance.getDefaultAppearance(p.motor), true, false, textureId);
	}

	private static Appearance appearance(int type, RocketComponent c) {
		Appearance a = type == UNFINISHED ? null : c.getAppearance();
		return a != null ? a : DefaultAppearance.getDefaultAppearance(c);
	}

	/** RealisticRenderer: see-through parts are those painted with transparency. */
	private static boolean transparent(int type, Appearance a) {
		return type == FINISHED && a.getPaint().getAlpha() < 255;
	}

	private static String realistic(int type, Appearance a, boolean decal, boolean transparent, ToIntFunction<DecalImage> textureId) {
		ORColor paint = a.getPaint();
		float alpha = type == UNFINISHED ? 1 : paint.getAlpha() / 255f;
		float s = (float) a.getShine();
		return material(paint.getRed() / 255f, paint.getGreen() / 255f, paint.getBlue() / 255f, alpha, s, s, s, 100 * s,
				decal ? a.getTexture() : null, transparent, textureId);
	}

	/** FigureRenderer.isDrawnTransparent: open tubes are drawn see-through to show what is inside. */
	static boolean figureTransparent(RocketComponent c) {
		if (c instanceof BodyTube) {
			return true;
		}
		if (c instanceof NoseCone) {
			return false;
		}
		if (c instanceof SymmetricComponent && ((SymmetricComponent) c).isFilled()) {
			return false;
		}
		if (c instanceof Transition) {
			Transition t = (Transition) c;
			return !t.isAftShoulderCapped() && !t.isForeShoulderCapped();
		}
		return false;
	}

	/** FigureRenderer.convertColor: brightened, and never darker than 20%. */
	private static float[] figure(ORColor c) {
		if (c == null) {
			return new float[] { 1, 1, 0 };
		}
		return new float[] { Math.max(0.2f, c.getRed() / 255f) * 2, Math.max(0.2f, c.getGreen() / 255f) * 2,
				Math.max(0.2f, c.getBlue() / 255f) * 2 };
	}

	/** FigureRenderer.getShine. */
	private static float finishShine(RocketComponent c) {
		if (c instanceof ExternalComponent) {
			switch (((ExternalComponent) c).getFinish()) {
			case ROUGH:
				return 10;
			case UNFINISHED:
				return 30;
			case NORMAL:
				return 40;
			case SMOOTH:
				return 80;
			case POLISHED:
				return 128;
			default:
				return 100;
			}
		}
		return 20;
	}

	private static String material(float r, float g, float b, float a, float sr, float sg, float sb, float shininess, Decal decal,
			boolean transparent, ToIntFunction<DecalImage> textureId) {
		StringBuilder out = new StringBuilder(String.format(Locale.ROOT, "{\"color\":[%.4f,%.4f,%.4f,%.4f],\"spec\":[%.4f,%.4f,%.4f],\"shininess\":%.2f",
				r, g, b, a, sr, sg, sb, Math.max(0, Math.min(128, shininess))));
		if (transparent) {
			out.append(",\"transparent\":true");
		}
		if (decal != null && decal.getImage() != null) {
			int id = textureId.applyAsInt(decal.getImage());
			if (id >= 0) {
				double[] m = decalMatrix(decal);
				out.append(String.format(Locale.ROOT, ",\"texture\":%d,\"edge\":\"%s\",\"uv\":[%.6f,%.6f,%.6f,%.6f,%.6f,%.6f]", id,
						decal.getEdgeMode().name().toLowerCase(Locale.ROOT), m[0], m[1], m[2], m[3], m[4], m[5]));
			}
		}
		return out.append('}').toString();
	}

	/**
	 * RealisticRenderer's texture matrix for a decal, as the top two rows [a b c; d e f] of a 2D
	 * affine matrix: translate(-centre) rotate translate(centre) scale translate(offset), between
	 * horizontal flips. RocketFigure3d flips u after the decal's placement for OpenRocket's
	 * left-handed coordinates; the OBJ exporters' u is already flipped (u = 1 - OpenRocket's u),
	 * so it is flipped back before the placement too.
	 */
	static double[] decalMatrix(Decal d) {
		Coordinate c = d.getCenter(), s = d.getScale(), o = d.getOffset();
		double cos = Math.cos(d.getRotation()), sin = Math.sin(d.getRotation());
		double[] m = { 1, 0, 0, 0, 1, 0 };
		m = mul(m, new double[] { -1, 0, 1, 0, 1, 0 }); // flip: u -> 1 - u
		m = mul(m, new double[] { 1, 0, -c.x, 0, 1, -c.y });
		m = mul(m, new double[] { cos, -sin, 0, sin, cos, 0 });
		m = mul(m, new double[] { 1, 0, c.x, 0, 1, c.y });
		m = mul(m, new double[] { s.x, 0, 0, 0, s.y, 0 });
		m = mul(m, new double[] { 1, 0, o.x, 0, 1, o.y });
		m = mul(m, new double[] { -1, 0, 1, 0, 1, 0 });
		return m;
	}

	private static double[] mul(double[] a, double[] b) {
		return new double[] { a[0] * b[0] + a[1] * b[3], a[0] * b[1] + a[1] * b[4], a[0] * b[2] + a[1] * b[5] + a[2],
				a[3] * b[0] + a[4] * b[3], a[3] * b[1] + a[4] * b[4], a[3] * b[2] + a[4] * b[5] + a[5] };
	}
}
