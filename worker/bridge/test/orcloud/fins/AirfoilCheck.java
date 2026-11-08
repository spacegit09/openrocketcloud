package orcloud.fins;

import java.util.HashMap;
import java.util.Map;

import info.openrocket.core.util.Coordinate;

/**
 * Checks fins built with cross sections (AirfoilFin): every profile on trapezoidal, elliptical and
 * swept (pointed) outlines is a closed solid (each edge shared by two triangles, one each way), as
 * thick as the fin, with the volume its profile's area gives; a notched outline stays flat.
 *   java -cp OpenRocket.jar:classes orcloud.fins.AirfoilCheck
 */
public final class AirfoilCheck {
	private static int failures;

	public static void main(String[] args) {
		double t = 0.004; // 4 mm thick
		Coordinate[] trapezoid = { new Coordinate(0, 0), new Coordinate(0.05, 0.08), new Coordinate(0.10, 0.08), new Coordinate(0.15, 0), new Coordinate(0.075, 0) };
		Coordinate[] swept = { new Coordinate(0, 0), new Coordinate(0.12, 0.07), new Coordinate(0.12, 0.0699999), new Coordinate(0.14, 0) };
		Coordinate[] elliptical = new Coordinate[41];
		for (int i = 0; i <= 40; i++) {
			double a = Math.PI * i / 40;
			elliptical[i] = new Coordinate(0.06 - 0.06 * Math.cos(a), 0.05 * Math.sin(a));
		}
		Coordinate[] notched = { new Coordinate(0, 0), new Coordinate(0.02, 0.06), new Coordinate(0.05, 0.02), new Coordinate(0.08, 0.06), new Coordinate(0.10, 0) };
		// The share of a flat plate's volume each profile keeps (constant thickness).
		Map<FinProfile.Type, double[]> share = new HashMap<>();
		share.put(FinProfile.Type.DOUBLE_WEDGE, new double[] { 0.5, 0.001 });
		share.put(FinProfile.Type.HEXAGONAL, new double[] { 0.75, 0.001 });
		share.put(FinProfile.Type.NACA, new double[] { 0.685, 0.01 });
		share.put(FinProfile.Type.BICONVEX, new double[] { 2.0 / 3, 0.01 });
		for (FinProfile.Type type : FinProfile.Type.values()) {
			if (type == FinProfile.Type.FLAT) {
				continue;
			}
			for (boolean scaled : new boolean[] { false, true }) {
				FinProfile p = new FinProfile(type, 0.125, scaled);
				for (Object[] shape : new Object[][] { { "trapezoid", trapezoid, 0.15 * 0.08 - 0.5 * 0.05 * 0.08 - 0.5 * 0.05 * 0.08 },
						{ "elliptical", elliptical, Math.PI * 0.06 * 0.05 / 2 }, { "swept", swept, 0.5 * 0.14 * 0.07 } }) {
					String name = type + (scaled ? " scaled" : "") + " " + shape[0];
					AirfoilFin fin = AirfoilFin.build((Coordinate[]) shape[1], t, p, 16);
					if (fin == null) {
						fail(name + ": not built");
						continue;
					}
					closed(fin, name);
					double thickest = 0;
					for (double[] v : fin.vertices) {
						thickest = Math.max(thickest, 2 * Math.abs(v[2]));
					}
					check(thickest <= t * 1.0001 && thickest > t * 0.95, name + ": thickest " + thickest);
					double flat = (double) shape[2] * t;
					double v = fin.volume();
					check(v > 0 && v <= flat * 1.001, name + ": volume " + v + " of flat " + flat);
					double[] s = share.get(type);
					if (s != null && !scaled && shape[0].equals("trapezoid")) {
						double want = type == FinProfile.Type.HEXAGONAL ? 1 - 0.125 : s[0];
						check(Math.abs(v / flat - want) < s[1] + 0.005, name + ": keeps " + v / flat + " of a flat fin, want " + want);
					}
				}
			}
		}
		check(AirfoilFin.build(notched, t, new FinProfile(FinProfile.Type.NACA), 16) == null, "a notched outline stays flat");
		System.out.println(failures == 0 ? "AIRFOILCHECK PASS" : "AIRFOILCHECK FAILED: " + failures);
		System.exit(failures == 0 ? 0 : 1);
	}

	/** Every edge in two triangles, once each way. */
	private static void closed(AirfoilFin fin, String name) {
		Map<Long, Integer> edges = new HashMap<>();
		for (int[] tr : fin.triangles) {
			for (int k = 0; k < 3; k++) {
				long a = tr[k], b = tr[(k + 1) % 3];
				edges.merge(a * 1_000_000 + b, 1, Integer::sum);
			}
		}
		int open = 0;
		for (Map.Entry<Long, Integer> e : edges.entrySet()) {
			long a = e.getKey() / 1_000_000, b = e.getKey() % 1_000_000;
			if (e.getValue() != 1 || edges.getOrDefault(b * 1_000_000 + a, 0) != 1) {
				open++;
			}
		}
		check(open == 0, name + ": " + open + " edges not shared once each way (" + fin.triangles.size() + " triangles)");
	}

	private static void check(boolean ok, String what) {
		if (!ok) {
			fail(what);
		}
	}

	private static void fail(String what) {
		failures++;
		System.out.println("  FAIL " + what);
	}
}
