package orcloud.fins;

/**
 * A fin's flutter speed: the airspeed above which it may start to flutter (twist and bend in a
 * growing oscillation, often until it breaks off). Martin's flutter boundary (NACA TN 4197, 1958),
 * as John K. Bennett corrected and refined it for rockets (Apogee's Peak of Flight 615, 2023, and
 * his Fin Flutter Boundary Calculator v1.3):
 *
 * <pre>  Vf = a sqrt( G / ( DN AR^3 / ((t/c)^3 (AR + 2)) * (lambda + 1) / 2 * p / p0 ) ),  DN = 24 epsilon gamma p0 / pi</pre>
 *
 * with a the speed of sound and p the air pressure where the rocket is, G the shear modulus of the
 * fin's material (in the same unit as p), AR the fin's aspect ratio (span squared over its area),
 * lambda its taper ratio (tip chord over root chord), t/c its thickness over its root chord, gamma
 * 1.4, and epsilon how far the fin's centre of area lies behind its root's quarter chord, as a share
 * of the root chord (Cx / c - 1/4). Martin took epsilon as 1/4 (a fin without sweep), so DN = 39.3
 * psi; Bennett takes it from the fin's shape, which gives swept fins a lower flutter speed. Here it
 * is never below 1/4, so that fins swept forward are not given a higher one.
 *
 * The form rocketry long used (Peak of Flight 291 and 411, RocketPy's fin_flutter_analysis) has an
 * extra factor of 2 under the root, counting Martin's 1/2 twice: its flutter speeds are sqrt(2)
 * too high, as Bennett showed. A fin of another outline (elliptical, freeform) counts as the
 * trapezoid with its root chord, span and area, and its own centre of area. It is a rough guide: it
 * leaves out tabs, fillets and how the fins are mounted, which all stiffen them, and materials vary.
 */
public final class FinFlutter {
	/** The standard atmosphere at sea level: pressure (Pa) and speed of sound (m/s). */
	public static final double SEA_LEVEL_PRESSURE = 101325, SEA_LEVEL_SOUND = 340.294;

	/** Martin's epsilon: a fin without sweep, its centre of area at mid chord. */
	public static final double MARTIN_EPSILON = 0.25;
	private static final double GAMMA = 1.4;

	public final double rootChord, tipChord, span, area, thickness;
	public final double aspectRatio, taper, thicknessRatio, epsilon;

	/**
	 * A fin with this root chord, span (height), area of one side and thickness (all in m), its
	 * centre of area `centroid` (m) behind the root's leading edge (NaN: at mid chord).
	 */
	public FinFlutter(double rootChord, double span, double area, double thickness, double centroid) {
		this.rootChord = rootChord;
		this.span = span;
		this.area = area;
		this.thickness = thickness;
		this.tipChord = span > 0 ? Math.max(0, 2 * area / span - rootChord) : 0;
		this.aspectRatio = area > 0 ? span * span / area : Double.NaN;
		this.taper = rootChord > 0 ? tipChord / rootChord : Double.NaN;
		this.thicknessRatio = rootChord > 0 ? thickness / rootChord : Double.NaN;
		double bennett = rootChord > 0 ? centroid / rootChord - 0.25 : Double.NaN;
		this.epsilon = bennett > MARTIN_EPSILON ? bennett : MARTIN_EPSILON;
	}

	/** The x of the centre of area of a closed outline (x, y pairs), as Bennett's Cx. */
	public static double centroid(double[] x, double[] y) {
		double a = 0, cx = 0;
		for (int i = 0; i < x.length; i++) {
			int j = (i + 1) % x.length;
			double cross = x[i] * y[j] - x[j] * y[i];
			a += cross;
			cx += (x[i] + x[j]) * cross;
		}
		return a != 0 ? cx / (3 * a) : Double.NaN;
	}

	/** Whether the fin has the size the estimate needs. */
	public boolean valid() {
		return rootChord > 0 && span > 0 && area > 0 && thickness > 0 && aspectRatio > 0;
	}

	/** The flutter speed (m/s) for shear modulus g (Pa), in air at pressure p (Pa) with speed of sound a (m/s). */
	public double speed(double g, double p, double a) {
		double ar = aspectRatio, tc = thicknessRatio;
		// DN / p0 = 24 epsilon gamma / pi (1.337 x 2 when epsilon is 1/4), times (lambda + 1) / 2
		double k = 24 * epsilon * GAMMA / Math.PI * (taper + 1) / 2;
		return a * Math.sqrt(g * tc * tc * tc * (ar + 2) / (k * ar * ar * ar * p));
	}

	/** The flutter speed (m/s) at sea level, in the standard atmosphere. */
	public double speedAtSeaLevel(double g) {
		return speed(g, SEA_LEVEL_PRESSURE, SEA_LEVEL_SOUND);
	}

	/** Where along a flight the fin's flutter speed is the smallest multiple of the airspeed. */
	public static final class Margin {
		/** The point (index into the flight's data). */
		public final int index;
		/** The flutter speed over the airspeed there: below 1, faster than the flutter speed. */
		public final double factor;
		public final double airspeed, flutterSpeed;

		Margin(int index, double factor, double airspeed, double flutterSpeed) {
			this.index = index;
			this.factor = factor;
			this.airspeed = airspeed;
			this.flutterSpeed = flutterSpeed;
		}
	}

	/**
	 * The lowest margin along a flight, from its airspeed (m/s), air pressure (Pa) and speed of
	 * sound (m/s) at each point; null if it never flies faster than 1 m/s.
	 */
	public Margin lowest(double g, double[] airspeed, double[] pressure, double[] sound) {
		Margin best = null;
		for (int i = 0; i < airspeed.length; i++) {
			double v = airspeed[i], p = pressure[i], a = sound[i];
			if (!(v > 1) || !(p > 0) || !(a > 0)) {
				continue;
			}
			double vf = speed(g, p, a);
			double factor = vf / v;
			if (best == null || factor < best.factor) {
				best = new Margin(i, factor, v, vf);
			}
		}
		return best;
	}

	/**
	 * The standard atmosphere (US 1976, to 32 km) at an altitude above sea level (m): pressure (Pa)
	 * and speed of sound (m/s).
	 */
	public static double[] standardAir(double altitude) {
		double h = Math.max(-1000, Math.min(32000, altitude));
		double t, p;
		if (h <= 11000) {
			t = 288.15 - 0.0065 * h;
			p = 101325 * Math.pow(t / 288.15, 5.25588);
		} else if (h <= 20000) {
			t = 216.65;
			p = 22632.06 * Math.exp(-0.000157688 * (h - 11000));
		} else {
			t = 216.65 + 0.001 * (h - 20000);
			p = 5474.889 * Math.pow(t / 216.65, -34.1632);
		}
		return new double[] { p, Math.sqrt(1.4 * 287.053 * t) };
	}

	/**
	 * A typical shear modulus (Pa) for the fin material of this name in OpenRocket's materials list,
	 * or NaN for one it has none for (a custom material, say). Values vary with the grade (and for
	 * wood with the grain, for 3D prints with the printing), so these are starting points.
	 */
	public static double typicalShearModulus(String material) {
		if (material == null) {
			return Double.NaN;
		}
		switch (material) {
		case "Acrylic": return 1.1e9;
		case "Aluminum": return 26e9;
		case "Balsa": return 0.12e9;
		case "Basswood": return 0.45e9;
		case "Birch": return 0.6e9;
		case "Brass": return 37e9;
		case "Cardboard": return 0.5e9;
		case "Carbon fiber": return 5e9; // a woven sheet; less than a quasi-isotropic laminate
		case "Delrin": return 1.0e9;
		case "Fiberglass": return 2.93e9; // G10, as rocketry flutter estimates usually take it
		case "Kraft phenolic": return 2.5e9;
		case "Maple": return 0.7e9;
		case "Nylon": return 0.7e9;
		case "Pine": return 0.5e9;
		case "Plywood (birch)": return 0.62e9;
		case "Polycarbonate (Lexan)": return 0.85e9;
		case "Polystyrene": return 1.2e9;
		case "PVC": return 1.0e9;
		case "Spruce": return 0.6e9;
		case "Steel": return 79e9;
		case "Titanium": return 44e9;
		case "PLA - 100% infill": return 1.0e9;
		case "PETG - 100% infill": return 0.65e9;
		case "ABS - 100% infill": return 0.7e9;
		default: return byKeyword(material.toLowerCase(java.util.Locale.ROOT));
		}
	}

	/** Names from parts libraries and other files ("G10 fiberglass", "Aircraft plywood (birch)"...). */
	private static double byKeyword(String m) {
		String[][] words = { { "g10", "2.93e9" }, { "g-10", "2.93e9" }, { "fr4", "2.93e9" }, { "fiberglass", "2.93e9" },
				{ "fibreglass", "2.93e9" }, { "carbon", "5e9" }, { "plywood", "0.62e9" }, { "phenolic", "2.5e9" },
				{ "basswood", "0.45e9" }, { "balsa", "0.12e9" }, { "birch", "0.6e9" }, { "spruce", "0.6e9" }, { "pine", "0.5e9" },
				{ "maple", "0.7e9" }, { "alumin", "26e9" }, { "titanium", "44e9" }, { "steel", "79e9" }, { "brass", "37e9" },
				{ "polycarbonate", "0.85e9" }, { "lexan", "0.85e9" }, { "acrylic", "1.1e9" }, { "delrin", "1.0e9" },
				{ "acetal", "1.0e9" }, { "petg", "0.65e9" }, { "pla", "1.0e9" }, { "abs", "0.7e9" }, { "nylon", "0.7e9" },
				{ "polystyrene", "1.2e9" }, { "styrene", "1.2e9" }, { "pvc", "1.0e9" }, { "cardboard", "0.5e9" } };
		for (String[] w : words) {
			if (java.util.Arrays.asList(m.split("[^a-z0-9-]+")).contains(w[0]) || (w[0].length() > 4 && m.contains(w[0]))) {
				return Double.parseDouble(w[1]);
			}
		}
		return Double.NaN;
	}
}
