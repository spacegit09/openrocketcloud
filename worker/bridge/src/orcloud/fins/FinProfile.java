package orcloud.fins;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The shape of a fin's cross section (its profile) for 3D export: its thickness along the chord.
 * OpenRocket exports every fin as a flat plate whatever its cross section ("square", "rounded" or
 * "airfoil", which it uses only for drag). {@link AirfoilFin} builds the fin with one of these.
 *
 * A profile is the same at every height of the fin: scaled to the chord there, with the fin's
 * thickness, or with a thickness that shrinks with the chord ({@link #scaled}, the same
 * thickness-to-chord ratio as at the root).
 */
public final class FinProfile {
	public enum Type {
		FLAT("Flat (square edges)", false),
		ROUNDED("Rounded edges", false),
		NACA("NACA 4-digit symmetric (00xx)", false),
		BICONVEX("Biconvex (circular arcs)", false),
		DOUBLE_WEDGE("Double wedge (diamond)", false),
		HEXAGONAL("Beveled edges (hexagonal)", true),
		ROUNDED_TAPERED("Rounded leading edge, tapered trailing edge", true);

		public final String label;
		/** Whether the profile has an edge length to set (the bevels or the taper). */
		public final boolean hasEdge;

		Type(String label, boolean hasEdge) {
			this.label = label;
			this.hasEdge = hasEdge;
		}

		@Override
		public String toString() {
			return label;
		}
	}

	public static final double DEFAULT_EDGE = 0.25;

	public final Type type;
	/** The bevels' or taper's length, as a fraction of the chord (HEXAGONAL, ROUNDED_TAPERED). */
	public final double edge;
	/** The thickness shrinks with the chord toward the tip, instead of staying the fin's thickness. */
	public final boolean scaled;

	public FinProfile(Type type, double edge, boolean scaled) {
		this.type = type;
		this.edge = Math.max(0.02, Math.min(0.48, edge));
		this.scaled = scaled;
	}

	public FinProfile(Type type) {
		this(type, DEFAULT_EDGE, false);
	}

	/** Half the thickness at `s` (0 at the leading edge, 1 at the trailing edge), for this chord and thickness (m). */
	public double half(double s, double chord, double thickness) {
		s = Math.max(0, Math.min(1, s));
		double h = thickness / 2;
		double x = s * chord;
		switch (type) {
		case FLAT:
			return h;
		case ROUNDED: {
			double r = Math.min(h, chord / 2);
			return Math.min(round(x, r, h), round(chord - x, r, h));
		}
		case NACA:
			// NACA 4-digit thickness distribution, closed trailing edge; its maximum (at 30 % chord) is h.
			return 5 * thickness * (0.2969 * Math.sqrt(s) - 0.1260 * s - 0.3516 * s * s + 0.2843 * s * s * s - 0.1036 * s * s * s * s);
		case BICONVEX: {
			if (h <= 0 || chord <= 0) {
				return 0;
			}
			double r = (chord * chord / 4 + h * h) / (2 * h); // the arcs' radius
			double d = x - chord / 2;
			return Math.max(0, Math.sqrt(Math.max(0, r * r - d * d)) - (r - h));
		}
		case DOUBLE_WEDGE:
			return h * (1 - Math.abs(2 * s - 1));
		case HEXAGONAL:
			return h * Math.min(1, Math.min(s / edge, (1 - s) / edge));
		case ROUNDED_TAPERED: {
			double r = Math.min(h, chord / 2);
			return Math.min(round(x, r, h), h * Math.min(1, (1 - s) / edge));
		}
		default:
			throw new IllegalStateException(type.name());
		}
	}

	/** A quarter circle of radius r from the edge (d from it), level at h beyond. */
	private static double round(double d, double r, double h) {
		if (d >= r) {
			return h;
		}
		return Math.sqrt(Math.max(0, r * r - (r - d) * (r - d))) * (r > 0 ? h / r : 0);
	}

	/**
	 * Where along the chord the mesh has points: chord fractions from 0 to 1, as many for every
	 * chord (so heights of the fin join up), with `kinks` marking corners not to be smoothed over.
	 */
	public Stations stations(int n, double chord, double thickness) {
		n = Math.max(4, n);
		List<Double> s = new ArrayList<>();
		List<Boolean> kink = new ArrayList<>();
		switch (type) {
		case FLAT:
			add(s, kink, 0, false);
			add(s, kink, 1, false);
			break;
		case NACA:
			// Close together at the round leading edge, wider toward the sharp trailing edge.
			for (int i = 0; i <= n; i++) {
				add(s, kink, 1 - Math.cos(Math.PI / 2 * i / n), false);
			}
			break;
		case BICONVEX:
			for (int i = 0; i <= n; i++) {
				add(s, kink, (1 - Math.cos(Math.PI * i / n)) / 2, false);
			}
			break;
		case DOUBLE_WEDGE:
			add(s, kink, 0, false);
			add(s, kink, 0.5, true);
			add(s, kink, 1, false);
			break;
		case HEXAGONAL:
			add(s, kink, 0, false);
			add(s, kink, edge, true);
			add(s, kink, 1 - edge, true);
			add(s, kink, 1, false);
			break;
		case ROUNDED:
		case ROUNDED_TAPERED: {
			double r = chord > 0 ? Math.min(thickness / 2, chord / 2) / chord : 0;
			int k = Math.max(4, n / 2); // points around the round edge
			for (int i = 0; i <= k; i++) {
				add(s, kink, r * (1 - Math.cos(Math.PI / 2 * i / k)), false);
			}
			if (type == Type.ROUNDED) {
				for (int i = k; i >= 0; i--) {
					add(s, kink, 1 - r * (1 - Math.cos(Math.PI / 2 * i / k)), false);
				}
			} else {
				add(s, kink, Math.max(r, 1 - edge), true);
				add(s, kink, 1, false);
			}
			break;
		}
		default:
			throw new IllegalStateException(type.name());
		}
		double[] at = new double[s.size()];
		boolean[] corner = new boolean[s.size()];
		for (int i = 0; i < at.length; i++) {
			at[i] = Math.max(0, Math.min(1, s.get(i)));
			corner[i] = kink.get(i);
		}
		return new Stations(at, corner);
	}

	private static void add(List<Double> s, List<Boolean> kink, double v, boolean corner) {
		s.add(v);
		kink.add(corner);
	}

	/** Chord fractions of the mesh's points, and which are corners. */
	public static final class Stations {
		public final double[] s;
		public final boolean[] kink;

		Stations(double[] s, boolean[] kink) {
			this.s = s;
			this.kink = kink;
		}
	}

	/** As stored: "TYPE" or "TYPE:edge", then ":scaled" if the thickness shrinks toward the tip. */
	@Override
	public String toString() {
		return type.name() + (type.hasEdge ? String.format(Locale.ROOT, ":%.3f", edge) : "") + (scaled ? ":scaled" : "");
	}

	public static FinProfile parse(String text, FinProfile fallback) {
		if (text == null || text.isEmpty()) {
			return fallback;
		}
		try {
			String[] p = text.split(":");
			Type type = Type.valueOf(p[0]);
			double edge = DEFAULT_EDGE;
			boolean scaled = false;
			for (int i = 1; i < p.length; i++) {
				if (p[i].equals("scaled")) {
					scaled = true;
				} else {
					edge = Double.parseDouble(p[i]);
				}
			}
			return new FinProfile(type, edge, scaled);
		} catch (RuntimeException e) {
			return fallback;
		}
	}
}
