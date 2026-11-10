package orcloud.fins;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.function.DoubleUnaryOperator;

/**
 * The root fillets of a fin as solids, for 3D export: on each side of the fin, a concave circular
 * fillet of the radius set in the fin's dialog, tangent to the fin's side and to the body, along
 * the root (as OpenRocket assumes when it works out the fillets' mass). Built in the fin's own
 * frame, as OpenRocket draws fins (x along the root from its leading edge, y outward from the body,
 * z through the thickness, centred), so a fin's fillets go wherever the fin goes.
 *
 * Each cross section (across the root, at a station along it) runs along the fin's side from where
 * the fillet meets it, around the fillet's arc to where it meets the body, then just inside the
 * body's surface (by `embed`) and the fin's middle back to the start. So it overlaps the fin and
 * the body a little and leaves no gap between them, and when printed the three join into one. The
 * stations follow the body's radius (on a transition) and the fin's thickness (with a cross section
 * profile). At the fin's leading and trailing edges the fillet runs out: its radius shrinks to
 * nothing along a quarter ellipse, over twice the radius (a third of the root at most); where the
 * body ends under the fin instead, it is cut off flush with the body's end.
 */
public final class FinFillet {
	/** Vertices (x, y, z), normals (x, y, z) and triangles: for each, 3 vertex and 3 normal indices. */
	public final List<double[]> vertices = new ArrayList<>();
	public final List<double[]> normals = new ArrayList<>();
	public final List<int[]> triangles = new ArrayList<>(); // { v0, v1, v2, n0, n1, n2 }

	/** The smallest share of the radius a running-out fillet keeps at its very end (no zero-size section). */
	static final double END = 0.01;

	private FinFillet() {
	}

	/**
	 * Both fillets of a fin, along the root from `from` to `to`.
	 *
	 * @param stations  more stations between (m), where the body or the fin's thickness changes
	 * @param center    the height (y) of the body's axis below the root at x, in the fin's frame
	 * @param body      the body's radius at x (m)
	 * @param half      half the fin's thickness at x (m)
	 * @param radius    the fillets' radius (m)
	 * @param embed     how far the fillets reach into the body below its surface (m), at most its wall
	 * @param segments  segments along each arc
	 * @param runOutFrom whether `from` is the fin's edge (the fillet runs out) rather than the body's end
	 * @param runOutTo  the same for `to`
	 * @return the fillets, or null if there are none (no radius, or the fin as thick as the body)
	 */
	public static FinFillet build(double from, double to, double[] stations, DoubleUnaryOperator center,
			DoubleUnaryOperator body, DoubleUnaryOperator half, double radius, double embed, int segments,
			boolean runOutFrom, boolean runOutTo) {
		if (!(radius > 0) || !(to - from > 1e-9)) {
			return null;
		}
		int m = Math.max(2, segments);
		double runOut = Math.min((to - from) / 3, 2 * radius);
		TreeSet<Double> at = new TreeSet<>();
		at.add(from);
		at.add(to);
		for (double x : stations) {
			if (x > from && x < to) {
				at.add(x);
			}
		}
		// Closer together toward the ends, where a running-out fillet changes fastest.
		int n = Math.max(4, m);
		for (int j = 1; j <= n; j++) {
			double d = runOut * (1 - Math.cos(Math.PI / 2 * j / n));
			if (runOutFrom) {
				at.add(from + d);
			}
			if (runOutTo) {
				at.add(to - d);
			}
		}
		List<Double> xs = new ArrayList<>();
		for (double x : at) {
			if (xs.isEmpty() || x - xs.get(xs.size() - 1) > (to - from) * 1e-9) {
				xs.add(x);
			}
		}
		int count = xs.size();
		double[] x = new double[count], c = new double[count];
		double[][][] sections = new double[count][][];
		for (int i = 0; i < count; i++) {
			x[i] = xs.get(i);
			double R = body.applyAsDouble(x[i]);
			double h = Math.max(half.applyAsDouble(x[i]), 1e-6);
			if (!(R > h + 1e-6)) {
				return null;
			}
			double share = 1;
			if (runOutFrom) {
				share = Math.min(share, ellipse((x[i] - from) / runOut));
			}
			if (runOutTo) {
				share = Math.min(share, ellipse((to - x[i]) / runOut));
			}
			c[i] = center.applyAsDouble(x[i]);
			sections[i] = section(R, h, radius * share, Math.max(0, Math.min(embed, R - h)), m);
		}
		FinFillet f = new FinFillet();
		for (int side : new int[] { 1, -1 }) {
			f.addSide(x, c, sections, side, m);
		}
		return f;
	}

	/** A quarter ellipse: 0 (well, END) at u = 0, rising steeply, level at 1 from u = 1 on. */
	static double ellipse(double u) {
		if (u >= 1) {
			return 1;
		}
		u = Math.max(0, u);
		return Math.max(END, Math.sqrt(1 - (1 - u) * (1 - u)));
	}

	/**
	 * One cross section (side +z), counter-clockwise in (Y, z) with Y from the body's axis. Points:
	 * the fin's side where the fillet meets it, the arc (m segments) to the body, the same point
	 * `embed` deeper, around at that depth (m segments) to the fin's middle, and out along the middle
	 * to below the first point. The first m + 1 points are on the fillet's arc.
	 */
	static double[][] section(double R, double h, double r, double embed, int m) {
		double zc = h + r;
		double yc = Math.sqrt((R + r) * (R + r) - zc * zc);
		double from = -Math.PI / 2; // the arc's start, on the fin's side, seen from its centre
		double to = Math.atan2(-zc, -yc); // its end, on the body
		double inner = R - embed;
		double bodyAngle = Math.atan2(zc, yc);
		List<double[]> pts = new ArrayList<>(); // { Y, z }
		for (int k = 0; k <= m; k++) {
			double a = from + (to - from) * k / m;
			pts.add(new double[] { yc + r * Math.cos(a), zc + r * Math.sin(a) });
		}
		if (embed > 0) {
			for (int k = 0; k <= m; k++) {
				double a = bodyAngle * (m - k) / m;
				pts.add(new double[] { inner * Math.cos(a), inner * Math.sin(a) });
			}
		} else {
			for (int k = 1; k <= m; k++) {
				double a = bodyAngle * (m - k) / m;
				pts.add(new double[] { R * Math.cos(a), R * Math.sin(a) });
			}
		}
		pts.add(new double[] { yc, 0 });
		double[][] out = pts.toArray(new double[0][]);
		if (area(out) < 0) {
			throw new IllegalStateException("fillet section is clockwise");
		}
		return out;
	}

	/** Twice the signed area of a polygon in (Y, z). */
	static double area(double[][] p) {
		double a = 0;
		for (int i = 0; i < p.length; i++) {
			double[] u = p[i], v = p[(i + 1) % p.length];
			a += u[0] * v[1] - v[0] * u[1];
		}
		return a;
	}

	/** The fillet on one side (+z or -z) of the fin: its surfaces along the root and its two caps. */
	private void addSide(double[] xs, double[] center, double[][][] sections, int side, int m) {
		int n = sections[0].length;
		// Each section's points, counter-clockwise seen from +x: the -z side is mirrored, so reversed.
		int[][] at = new int[xs.length][n];
		for (int i = 0; i < xs.length; i++) {
			for (int k = 0; k < n; k++) {
				double[] p = sections[i][src(k, n, side)];
				at[i][k] = vertex(xs[i], center[i] + p[0], side * p[1]);
			}
		}
		// The fillet's own (arc) surface is shaded smooth: each of its points gets the average of the
		// faces around it, which also follows the run-out at the ends. The rest is shaded flat.
		double[][][] smooth = new double[xs.length][n][3];
		for (int i = 0; i + 1 < xs.length; i++) {
			for (int k = 0; k < n; k++) {
				int k1 = (k + 1) % n;
				if (onArc(k, k1, n, side, m)) {
					double[] g = cross(at[i][k], at[i][k1], at[i + 1][k1]);
					double[] g2 = cross(at[i][k], at[i + 1][k1], at[i + 1][k]);
					for (int[] v : new int[][] { { i, k }, { i, k1 }, { i + 1, k1 }, { i + 1, k } }) {
						for (int d = 0; d < 3; d++) {
							smooth[v[0]][v[1]][d] += g[d] + g2[d];
						}
					}
				}
			}
		}
		int[][] smoothAt = new int[xs.length][n];
		for (int i = 0; i < xs.length; i++) {
			for (int k = 0; k < n; k++) {
				double[] s = smooth[i][k];
				smoothAt[i][k] = s[0] != 0 || s[1] != 0 || s[2] != 0 ? normal(s[0], s[1], s[2]) : -1;
			}
		}
		for (int i = 0; i + 1 < xs.length; i++) {
			for (int k = 0; k < n; k++) {
				int k1 = (k + 1) % n;
				int a = at[i][k], b = at[i][k1], c = at[i + 1][k1], d = at[i + 1][k];
				int na, nb, nc, nd;
				if (onArc(k, k1, n, side, m) && smoothAt[i][k] >= 0 && smoothAt[i][k1] >= 0 && smoothAt[i + 1][k1] >= 0
						&& smoothAt[i + 1][k] >= 0) {
					na = smoothAt[i][k];
					nb = smoothAt[i][k1];
					nc = smoothAt[i + 1][k1];
					nd = smoothAt[i + 1][k];
				} else {
					double[] g = cross(a, b, c), g2 = cross(a, c, d);
					na = nb = nc = nd = normal(g[0] + g2[0], g[1] + g2[1], g[2] + g2[2]);
				}
				triangles.add(new int[] { a, b, c, na, nb, nc });
				triangles.add(new int[] { a, c, d, na, nc, nd });
			}
		}
		// The caps: the last station faces +x, the first -x (so its triangles are turned around).
		int last = xs.length - 1;
		int capOut = normal(1, 0, 0), capIn = normal(-1, 0, 0);
		for (int[] t : earClip(sections[last], side)) {
			triangles.add(new int[] { at[last][t[0]], at[last][t[1]], at[last][t[2]], capOut, capOut, capOut });
		}
		for (int[] t : earClip(sections[0], side)) {
			triangles.add(new int[] { at[0][t[0]], at[0][t[2]], at[0][t[1]], capIn, capIn, capIn });
		}
	}

	/** The section's point at position k in the side's order. */
	private static int src(int k, int n, int side) {
		return side > 0 ? k : n - 1 - k;
	}

	/** Whether the edge k -> k1 (in the side's order) runs along the fillet's arc (its first m + 1 points). */
	private static boolean onArc(int k, int k1, int n, int side, int m) {
		int a = src(k, n, side), b = src(k1, n, side);
		return a <= m && b <= m && Math.abs(a - b) == 1;
	}

	/** Triangles (indices into the side's order) of a section, counter-clockwise seen from +x. */
	private static List<int[]> earClip(double[][] section, int side) {
		int n = section.length;
		double[][] p = new double[n][];
		for (int k = 0; k < n; k++) {
			double[] q = section[src(k, n, side)];
			p[k] = new double[] { q[0], side * q[1] };
		}
		List<Integer> left = new ArrayList<>();
		for (int k = 0; k < n; k++) {
			left.add(k);
		}
		List<int[]> out = new ArrayList<>();
		int guard = 0;
		while (left.size() > 3 && guard++ < n * n) {
			boolean clipped = false;
			for (int j = 0; j < left.size(); j++) {
				int ia = left.get((j + left.size() - 1) % left.size()), ib = left.get(j), ic = left.get((j + 1) % left.size());
				double[] a = p[ia], b = p[ib], c = p[ic];
				double cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
				if (cross <= 0) {
					continue; // a reflex (or flat) corner is no ear
				}
				boolean empty = true;
				for (int q : left) {
					if (q != ia && q != ib && q != ic && inside(p[q], a, b, c)) {
						empty = false;
						break;
					}
				}
				if (empty) {
					out.add(new int[] { ia, ib, ic });
					left.remove(j);
					clipped = true;
					break;
				}
			}
			if (!clipped) {
				break;
			}
		}
		if (left.size() == 3) {
			out.add(new int[] { left.get(0), left.get(1), left.get(2) });
		} else if (left.size() > 3) {
			// Should not happen for these sections; a fan keeps the cap closed regardless.
			for (int j = 1; j + 1 < left.size(); j++) {
				out.add(new int[] { left.get(0), left.get(j), left.get(j + 1) });
			}
		}
		return out;
	}

	private static boolean inside(double[] p, double[] a, double[] b, double[] c) {
		double d1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
		double d2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
		double d3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
		return d1 >= 0 && d2 >= 0 && d3 >= 0;
	}

	private int vertex(double x, double y, double z) {
		vertices.add(new double[] { x, y, z });
		return vertices.size() - 1;
	}

	private int normal(double x, double y, double z) {
		double l = Math.sqrt(x * x + y * y + z * z);
		normals.add(l > 0 ? new double[] { x / l, y / l, z / l } : new double[] { 1, 0, 0 });
		return normals.size() - 1;
	}

	/** The cross product (b - a) x (c - a) of three vertices: twice the triangle's area, along its normal. */
	private double[] cross(int a, int b, int c) {
		double[] p = vertices.get(a), q = vertices.get(b), r = vertices.get(c);
		double ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
		double vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
		return new double[] { uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx };
	}

	/** The volume enclosed (m³), from the triangles (divergence theorem). */
	public double volume() {
		double v = 0;
		for (int[] t : triangles) {
			double[] a = vertices.get(t[0]), b = vertices.get(t[1]), c = vertices.get(t[2]);
			v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
		}
		return v / 6;
	}
}
