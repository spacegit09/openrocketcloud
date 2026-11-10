package orcloud.fins;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Checks fin root fillets (FinFillet): closed solids with their triangles facing out, the volume
 * their cross sections give, the cross section OpenRocket assumes for the fillets' mass, the arc
 * tangent to the fin's side and to the body, running out to next to nothing at the fin's edges;
 * also on a tapering body with an airfoil fin.
 *   java -cp OpenRocket.jar:classes orcloud.fins.FilletCheck
 */
public final class FilletCheck {
	private static int failures;

	public static void main(String[] args) {
		double R = 0.0125, t = 0.003, r = 0.004, L = 0.08;

		// A body tube under the whole root, cut off flush at both ends (as where the body ends).
		FinFillet f = FinFillet.build(0, L, new double[0], x -> -R, x -> R, x -> t / 2, r, 0.0003, 16, false, false);
		check(f != null, "built on a body tube");
		closed(f, "body tube");
		double section = FinFillet.area(FinFillet.section(R, t / 2, r, 0.0003, 16)) / 2;
		check(Math.abs(f.volume() - 2 * section * L) < 1e-12 + 1e-6 * f.volume(), "volume " + f.volume() + " is both sections along the root, " + 2 * section * L);

		// Running out at the fin's edges: next to nothing at the ends, the full fillet from twice its
		// radius in, and a little less volume.
		FinFillet out = FinFillet.build(0, L, new double[0], x -> -R, x -> R, x -> t / 2, r, 0.0003, 16, true, true);
		closed(out, "running out");
		double full = 0, atEnds = 0;
		for (double[] v : out.vertices) {
			double above = Math.hypot(v[1] + R, v[2]) - R; // how far out from the body's surface
			if (v[0] < 1e-12 || v[0] > L - 1e-12) {
				atEnds = Math.max(atEnds, above);
			} else if (v[0] >= 2 * r - 1e-12 && v[0] <= L - 2 * r + 1e-12) {
				full = Math.max(full, above);
			}
		}
		double fullHeight = Math.hypot(Math.sqrt((R + r) * (R + r) - (t / 2 + r) * (t / 2 + r)), t / 2) - R;
		check(Math.abs(full - fullHeight) < 1e-9, "the full fillet from twice its radius in: " + full + ", want " + fullHeight);
		check(atEnds < 0.05 * r, "next to nothing at the fin's edges: " + atEnds + " out from the body");
		check(out.volume() < f.volume() && out.volume() > 0.8 * f.volume(), "running out takes a little volume: " + out.volume() + " of " + f.volume());

		// The cross section OpenRocket assumes (a fin of no thickness, the fillet on the body's surface).
		double fine = FinFillet.area(FinFillet.section(R, 1e-9, r, 0, 256)) / 2;
		double hyp = r + R;
		double openRocket = Math.tan(Math.acos(r / hyp)) * r * r / 2 - Math.acos(r / hyp) * r * r / 2 - Math.asin(r / hyp) * R * R / 2;
		check(Math.abs(fine - openRocket) < 0.002 * openRocket, "cross section " + fine + " is OpenRocket's " + openRocket);

		// The arc: from the fin's side (z = h) to the body (radius R), radius r about its centre.
		double h = t / 2;
		double[][] s = FinFillet.section(R, h, r, 0, 16);
		double zc = h + r, yc = Math.sqrt((R + r) * (R + r) - zc * zc);
		check(Math.abs(s[0][0] - yc) < 1e-12 && Math.abs(s[0][1] - h) < 1e-12, "starts on the fin's side");
		check(Math.abs(Math.hypot(s[16][0], s[16][1]) - R) < 1e-12, "ends on the body");
		for (int k = 0; k <= 16; k++) {
			check(Math.abs(Math.hypot(s[k][0] - yc, s[k][1] - zc) - r) < 1e-12, "arc point " + k + " at the fillet's radius");
			check(s[k][1] >= h - 1e-12 && Math.hypot(s[k][0], s[k][1]) >= R - 1e-12, "arc point " + k + " outside the fin and the body");
		}

		// Both sides alike: the -z fillet mirrors the +z one.
		double plusZ = 0, minusZ = 0;
		for (double[] v : f.vertices) {
			plusZ = Math.max(plusZ, v[2]);
			minusZ = Math.min(minusZ, v[2]);
		}
		check(Math.abs(plusZ + minusZ) < 1e-12 && plusZ > h, "one fillet on each side");

		// A tapering body (a boat tail) and an airfoil fin, thinner toward its edges.
		int n = 12;
		double[] xs = new double[n + 1];
		for (int i = 0; i <= n; i++) {
			xs[i] = L * i / n; // the root slopes down with the body: its axis 2 x 4 mm lower at the end
		}
		FinProfile naca = new FinProfile(FinProfile.Type.NACA);
		FinFillet tapered = FinFillet.build(0, L, xs, x -> -(R - 0.004 * x / L) - 0.004 * x / L, x -> R - 0.004 * x / L,
				x -> naca.half(x / L, L, t), r, 0.0003, 8, true, true);
		check(tapered != null, "built on a boat tail with an airfoil fin");
		closed(tapered, "boat tail");
		check(tapered.volume() > 0 && tapered.volume() < f.volume(), "boat tail volume " + tapered.volume());

		check(FinFillet.build(0, L, new double[0], x -> -R, x -> R, x -> t / 2, 0, 0, 8, true, true) == null, "no radius, no fillet");
		check(FinFillet.build(0, L, new double[0], x -> -R, x -> 0.001, x -> t / 2, r, 0, 8, true, true) == null,
				"no fillet on a body thinner than the fin");

		System.out.println(failures == 0 ? "FILLETCHECK PASS" : "FILLETCHECK FAILED: " + failures);
		System.exit(failures == 0 ? 0 : 1);
	}

	/** Every edge in two triangles, once each way, and every triangle facing out (positive volume). */
	private static void closed(FinFillet fillet, String name) {
		Map<Long, Integer> edges = new HashMap<>();
		List<int[]> tris = fillet.triangles;
		for (int[] tr : tris) {
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
		check(open == 0, name + ": " + open + " edges not shared by two triangles, one each way");
		check(fillet.volume() > 0, name + ": volume " + fillet.volume() + " (triangles facing out)");
		for (int[] tr : tris) {
			double[] nm = fillet.normals.get(tr[3]);
			double[] a = fillet.vertices.get(tr[0]), b = fillet.vertices.get(tr[1]), c = fillet.vertices.get(tr[2]);
			double ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
			double gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
			if (gx * nm[0] + gy * nm[1] + gz * nm[2] < -1e-18) {
				check(false, name + ": a normal points against its triangle");
				return;
			}
		}
	}

	private static void check(boolean ok, String what) {
		if (!ok) {
			failures++;
			System.out.println("  FAIL " + what);
		}
	}
}
