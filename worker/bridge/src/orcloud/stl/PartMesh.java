package orcloud.stl;

import java.awt.geom.Path2D;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Arrays;
import java.util.zip.DataFormatException;
import java.util.zip.Deflater;
import java.util.zip.Inflater;

import info.openrocket.core.util.Coordinate;
import info.openrocket.core.util.Transformation;

/**
 * The shape of an imported 3D model, kept with the design so the part is drawn as modelled instead
 * of as OpenRocket's cylinder. Only its looks come from here; mass and balance are the component's
 * own values, as before.
 *
 * Stored as a design attachment (see {@link PartMeshes}): the file's triangles, merged where they
 * share corners and, for large files, reduced to at most {@value #MAX_TRIANGLES} by merging corners
 * that lie close together, with coordinates quantised to 16 bits, compressed, behind a header saying
 * how the file sits in the rocket (its axis, nose end and units, as chosen when importing).
 *
 * Decoded, positions are in the part's own frame in metres: x from the nose-side end aft, y and z
 * across, centred on the part's axis, turned (not mirrored) from the file's orientation.
 */
public final class PartMesh {
	public static final int MAX_TRIANGLES = 30_000;
	private static final int VERSION = 2;
	private static final byte[] MAGIC = { 'O', 'R', 'C', 'M' };
	/** Header sizes: version 1 had the placement only; version 2 adds the model's measurements. */
	private static final int HEADER_1 = 16, HEADER_2 = 152;
	private static final StlPart.Fill[] FILLS = StlPart.Fill.values();

	/** An STL file reduced for display, in the file's own coordinates; prepared once per file. */
	public static final class Shape {
		private final byte[] payload;
		/** Triangles in the file and kept. */
		public final int fileTriangles, triangles;

		Shape(byte[] payload, int fileTriangles, int triangles) {
			this.payload = payload;
			this.fileTriangles = fileTriangles;
			this.triangles = triangles;
		}

		/**
		 * The attachment for this shape placed as `part` says (its axis, nose end and units), with the
		 * model's measurements and how it is made, so the part can be turned later.
		 */
		public byte[] place(StlPart part) {
			StlModel m = part.model;
			Bytes b = new Bytes(HEADER_2 + payload.length);
			for (byte x : MAGIC) {
				b.u8(x);
			}
			b.u8(VERSION).u8(part.axis).u8((part.frontAtMax ? 1 : 0) | (m.closed ? 2 : 0)).u8(part.fill.ordinal());
			b.f64(part.unit).f64(0).f64(part.wall).f64(part.infill).f64(m.volume).f64(m.area);
			for (double[] v : new double[][] { m.volumeCentroid, m.areaCentroid, m.min, m.max }) {
				for (double x : v) {
					b.f64(x);
				}
			}
			System.arraycopy(payload, 0, b.a, b.p, payload.length);
			return b.a;
		}
	}

	/** Positions (3 per vertex, metres, the part's frame) and triangles (3 vertex indices each). */
	public final float[] positions;
	public final int[] triangles;
	/** The part's length along x. */
	public final double length;
	/** How the file lies in the rocket: its axis along the rocket, and whether its high end faces the nose. */
	public final int axis;
	public final boolean frontAtMax;
	/** The model as a rocket part (measurements, units, how it is made), or null for shapes kept before version 2. */
	public final StlPart part;
	private float[] cornerNormals;
	private int[] edges;

	private PartMesh(float[] positions, int[] triangles, double length, int axis, boolean frontAtMax, StlPart part) {
		this.positions = positions;
		this.triangles = triangles;
		this.length = length;
		this.axis = axis;
		this.frontAtMax = frontAtMax;
		this.part = part;
	}

	/** The same shape lying another way in the rocket: along the file's `axis`, its high end to the nose if `frontAtMax`. */
	public static byte[] reorient(byte[] attachment, int axis, boolean frontAtMax) throws IOException {
		if (attachment.length < HEADER_1 || !Arrays.equals(Arrays.copyOf(attachment, 4), MAGIC) || axis < 0 || axis > 2) {
			throw new IOException("Not a 3D model");
		}
		byte[] out = attachment.clone();
		out[5] = (byte) axis;
		out[6] = (byte) ((out[6] & ~1) | (frontAtMax ? 1 : 0));
		return out;
	}

	// ------------------------------------------------------------------ preparing

	/** Reads and reduces an STL file. */
	public static Shape prepare(byte[] stl) throws IOException {
		float[][] soup = { new float[9 * 4096] };
		int[] count = { 0 };
		StlModel.triangles(stl, v -> {
			if ((count[0] + 1) * 9 > soup[0].length) {
				soup[0] = Arrays.copyOf(soup[0], soup[0].length * 2);
			}
			for (int i = 0; i < 9; i++) {
				soup[0][count[0] * 9 + i] = (float) v[i];
			}
			count[0]++;
		});
		int n = count[0];
		if (n == 0) {
			throw new IOException("The file contains no triangles.");
		}
		float[] s = soup[0];
		double[] min = { Double.MAX_VALUE, Double.MAX_VALUE, Double.MAX_VALUE };
		double[] max = { -Double.MAX_VALUE, -Double.MAX_VALUE, -Double.MAX_VALUE };
		for (int i = 0; i < n * 9; i++) {
			min[i % 3] = Math.min(min[i % 3], s[i]);
			max[i % 3] = Math.max(max[i % 3], s[i]);
		}
		// Corners shared by triangles are merged (a near-exact grid); large files are then reduced
		// by merging the corners in each cell of a coarser grid, sized from the last result.
		Merged m = merge(s, n, min, max, n <= 4 * MAX_TRIANGLES ? 1 << 20 : 1024);
		int cells = 1024;
		while (m.triangleCount > MAX_TRIANGLES && cells > 2) {
			cells = (int) Math.max(2, Math.min(cells * 0.9, cells * Math.sqrt((double) MAX_TRIANGLES / m.triangleCount) * 0.95));
			m = merge(s, n, min, max, cells);
		}
		return new Shape(encode(m, min, max), n, m.triangleCount);
	}

	private static final class Merged {
		float[] vertices;
		int vertexCount;
		int[] triangles;
		int triangleCount;
	}

	/** Merges the corners in each cell of a grid with `cells` cells along the longest side. */
	private static Merged merge(float[] s, int n, double[] min, double[] max, int cells) {
		double longest = Math.max(max[0] - min[0], Math.max(max[1] - min[1], max[2] - min[2]));
		double cell = longest > 0 ? longest / cells : 1;
		long[] dims = new long[3];
		for (int k = 0; k < 3; k++) {
			dims[k] = Math.max(1, (long) Math.floor((max[k] - min[k]) / cell) + 1);
		}
		LongIntMap ids = new LongIntMap(Math.min(n / 2 + 16, 1 << 20));
		double[] sum = new double[3 * 1024];
		int[] members = new int[1024];
		int vc = 0;
		int[] corner = new int[n * 3];
		for (int i = 0; i < n * 3; i++) {
			long key = 0;
			for (int k = 0; k < 3; k++) {
				long c = Math.min(dims[k] - 1, (long) Math.floor((s[i * 3 + k] - min[k]) / cell));
				key = key * dims[k] + c;
			}
			int id = ids.get(key);
			if (id < 0) {
				id = vc++;
				ids.put(key, id);
				if (id == members.length) {
					members = Arrays.copyOf(members, id * 2);
					sum = Arrays.copyOf(sum, id * 6);
				}
			}
			members[id]++;
			for (int k = 0; k < 3; k++) {
				sum[id * 3 + k] += s[i * 3 + k];
			}
			corner[i] = id;
		}
		Merged m = new Merged();
		m.vertexCount = vc;
		m.vertices = new float[vc * 3];
		for (int v = 0; v < vc; v++) {
			for (int k = 0; k < 3; k++) {
				m.vertices[v * 3 + k] = (float) (sum[v * 3 + k] / members[v]);
			}
		}
		m.triangles = new int[n * 3];
		int tc = 0;
		for (int t = 0; t < n; t++) {
			int a = corner[t * 3], b = corner[t * 3 + 1], c = corner[t * 3 + 2];
			if (a != b && b != c && a != c) {
				m.triangles[tc * 3] = a;
				m.triangles[tc * 3 + 1] = b;
				m.triangles[tc * 3 + 2] = c;
				tc++;
			}
		}
		m.triangleCount = tc;
		return m;
	}

	private static byte[] encode(Merged m, double[] min, double[] max) {
		boolean wide = m.vertexCount > 0xFFFF;
		Bytes b = new Bytes(32 + 6 * m.vertexCount + m.triangleCount * 3 * (wide ? 4 : 2));
		for (int k = 0; k < 3; k++) {
			b.f32((float) min[k]);
		}
		for (int k = 0; k < 3; k++) {
			b.f32((float) max[k]);
		}
		b.i32(m.vertexCount).i32(m.triangleCount);
		for (int v = 0; v < m.vertexCount; v++) {
			for (int k = 0; k < 3; k++) {
				double span = max[k] - min[k];
				double f = span > 0 ? (m.vertices[v * 3 + k] - min[k]) / span : 0;
				b.u16((int) Math.round(Math.max(0, Math.min(1, f)) * 0xFFFF));
			}
		}
		for (int i = 0; i < m.triangleCount * 3; i++) {
			if (wide) {
				b.i32(m.triangles[i]);
			} else {
				b.u16(m.triangles[i]);
			}
		}
		Deflater d = new Deflater(Deflater.BEST_COMPRESSION);
		d.setInput(b.a);
		d.finish();
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buf = new byte[1 << 16];
		while (!d.finished()) {
			out.write(buf, 0, d.deflate(buf));
		}
		d.end();
		return out.toByteArray();
	}

	// ------------------------------------------------------------------ reading

	public static PartMesh decode(byte[] data) throws IOException {
		int version = data.length >= HEADER_1 && Arrays.equals(Arrays.copyOf(data, 4), MAGIC) ? data[4] : -1;
		int header = version == 1 ? HEADER_1 : version == 2 ? HEADER_2 : -1;
		if (header < 0 || data.length < header) {
			throw new IOException("Not a 3D model of a known version");
		}
		int axis = data[5];
		boolean front = (data[6] & 1) != 0;
		Bytes h = new Bytes(data);
		h.p = 8;
		double unit = h.f64();
		if (axis < 0 || axis > 2 || !(unit > 0)) {
			throw new IOException("Damaged 3D model");
		}
		StlPart part = null;
		if (version >= 2 && (data[7] & 0xFF) < FILLS.length) {
			h.f64(); // reserved
			double wall = h.f64(), infill = h.f64(), volume = h.f64(), area = h.f64();
			double[][] v = new double[4][3];
			for (double[] x : v) {
				for (int k = 0; k < 3; k++) {
					x[k] = h.f64();
				}
			}
			part = new StlPart(new StlModel(0, volume, area, v[0], v[1], v[2], v[3], (data[6] & 2) != 0));
			part.unit = unit;
			part.axis = axis;
			part.frontAtMax = front;
			part.fill = FILLS[data[7] & 0xFF];
			part.wall = wall;
			part.infill = infill;
		}
		Inflater inf = new Inflater();
		inf.setInput(data, header, data.length - header);
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		byte[] buf = new byte[1 << 16];
		try {
			while (!inf.finished()) {
				int k = inf.inflate(buf);
				if (k == 0 && (inf.needsInput() || inf.needsDictionary())) {
					throw new IOException("Damaged 3D model");
				}
				out.write(buf, 0, k);
			}
		} catch (DataFormatException e) {
			throw new IOException("Damaged 3D model", e);
		} finally {
			inf.end();
		}
		Bytes b = new Bytes(out.toByteArray());
		if (b.a.length < 32) {
			throw new IOException("Damaged 3D model");
		}
		double[] min = new double[3], max = new double[3];
		for (int k = 0; k < 3; k++) {
			min[k] = b.f32();
		}
		for (int k = 0; k < 3; k++) {
			max[k] = b.f32();
		}
		int vc = b.i32(), tc = b.i32();
		boolean wide = vc > 0xFFFF;
		if (vc < 0 || tc < 0 || b.a.length - b.p != 6L * vc + 3L * tc * (wide ? 4 : 2)) {
			throw new IOException("Damaged 3D model");
		}
		// File axes (a along the rocket, b and c across) to the part's frame, turned, not mirrored:
		// OpenRocket's axes are left-handed, so z = -c keeps the file's right-handed shape.
		int a = axis, bAxis = (axis + 1) % 3, cAxis = (axis + 2) % 3;
		double cb = (min[bAxis] + max[bAxis]) / 2, cc = (min[cAxis] + max[cAxis]) / 2;
		float[] pos = new float[vc * 3];
		double[] p = new double[3];
		for (int v = 0; v < vc; v++) {
			for (int k = 0; k < 3; k++) {
				p[k] = min[k] + b.u16() / 65535.0 * (max[k] - min[k]);
			}
			pos[v * 3] = (float) ((front ? max[a] - p[a] : p[a] - min[a]) * unit);
			pos[v * 3 + 1] = (float) ((front ? -1 : 1) * (p[bAxis] - cb) * unit);
			pos[v * 3 + 2] = (float) (-(p[cAxis] - cc) * unit);
		}
		int[] tri = new int[tc * 3];
		for (int i = 0; i < tc * 3; i++) {
			tri[i] = wide ? b.i32() : b.u16();
			if (tri[i] >= vc) {
				throw new IOException("Damaged 3D model");
			}
		}
		return new PartMesh(pos, tri, (max[a] - min[a]) * unit, axis, front, part);
	}

	// ------------------------------------------------------------------ drawing

	/**
	 * Normals at each triangle corner (9 floats per triangle): smooth across edges that bend less
	 * than 35°, sharp across creases, so printed curves look round and edges stay crisp.
	 */
	public synchronized float[] cornerNormals() {
		if (cornerNormals != null) {
			return cornerNormals;
		}
		int tc = triangles.length / 3, vc = positions.length / 3;
		double[] fn = new double[tc * 3];
		for (int t = 0; t < tc; t++) {
			double[] n = faceNormal(t);
			System.arraycopy(n, 0, fn, t * 3, 3);
		}
		int[] start = new int[vc + 1];
		for (int i : triangles) {
			start[i + 1]++;
		}
		for (int v = 0; v < vc; v++) {
			start[v + 1] += start[v];
		}
		int[] fill = Arrays.copyOf(start, vc);
		int[] faces = new int[triangles.length];
		for (int i = 0; i < triangles.length; i++) {
			faces[fill[triangles[i]]++] = i / 3;
		}
		double cos = Math.cos(Math.toRadians(35));
		float[] out = new float[tc * 9];
		for (int t = 0; t < tc; t++) {
			double fl = Math.sqrt(fn[t * 3] * fn[t * 3] + fn[t * 3 + 1] * fn[t * 3 + 1] + fn[t * 3 + 2] * fn[t * 3 + 2]);
			for (int k = 0; k < 3; k++) {
				int v = triangles[t * 3 + k];
				double x = 0, y = 0, z = 0;
				for (int j = start[v]; j < start[v + 1]; j++) {
					int g = faces[j];
					double gl = Math.sqrt(fn[g * 3] * fn[g * 3] + fn[g * 3 + 1] * fn[g * 3 + 1] + fn[g * 3 + 2] * fn[g * 3 + 2]);
					if (fl > 0 && gl > 0
							&& (fn[t * 3] * fn[g * 3] + fn[t * 3 + 1] * fn[g * 3 + 1] + fn[t * 3 + 2] * fn[g * 3 + 2]) / (fl * gl) >= cos) {
						x += fn[g * 3];
						y += fn[g * 3 + 1];
						z += fn[g * 3 + 2];
					}
				}
				double l = Math.sqrt(x * x + y * y + z * z);
				if (l == 0) {
					x = fn[t * 3];
					y = fn[t * 3 + 1];
					z = fn[t * 3 + 2];
					l = fl > 0 ? fl : 1;
				}
				out[t * 9 + k * 3] = (float) (x / l);
				out[t * 9 + k * 3 + 1] = (float) (y / l);
				out[t * 9 + k * 3 + 2] = (float) (z / l);
			}
		}
		return cornerNormals = out;
	}

	/** Area-weighted normal of triangle t (twice its area long). */
	private double[] faceNormal(int t) {
		int a = triangles[t * 3] * 3, b = triangles[t * 3 + 1] * 3, c = triangles[t * 3 + 2] * 3;
		double ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
		double wx = positions[c] - positions[a], wy = positions[c + 1] - positions[a + 1], wz = positions[c + 2] - positions[a + 2];
		return new double[] { uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx };
	}

	/** Edges with the triangles on each side: 4 ints each (corner, corner, triangle, triangle or -1). */
	private synchronized int[] edges() {
		if (edges != null) {
			return edges;
		}
		int tc = triangles.length / 3;
		long vc = positions.length / 3;
		LongIntMap index = new LongIntMap(tc * 3);
		int[] e = new int[tc * 3 * 4];
		int ec = 0;
		for (int t = 0; t < tc; t++) {
			for (int k = 0; k < 3; k++) {
				int a = triangles[t * 3 + k], b = triangles[t * 3 + (k + 1) % 3];
				long key = Math.min(a, b) * vc + Math.max(a, b);
				int i = index.get(key);
				if (i < 0) {
					index.put(key, ec);
					e[ec * 4] = a;
					e[ec * 4 + 1] = b;
					e[ec * 4 + 2] = t;
					e[ec * 4 + 3] = -1;
					ec++;
				} else if (e[i * 4 + 3] < 0) {
					e[i * 4 + 3] = t;
				}
			}
		}
		return edges = Arrays.copyOf(e, ec * 4);
	}

	/**
	 * The part as OpenRocket's 2D figure draws it: its outline and visible creases as seen along the
	 * view (side or top view: along z, back view: along x), and the area it covers, for clicking.
	 *
	 * @param t      the figure's transformation of the component
	 * @param offset where the part's axis starts, in the component's frame
	 * @param scale  the part's size relative to the model
	 * @param turn   the part's turn about the rocket's axis (radians; the component's radial direction)
	 */
	public java.awt.Shape[] figure(Transformation t, Coordinate offset, double scale, double turn, boolean back) {
		int vc = positions.length / 3, tc = triangles.length / 3;
		double[] sx = new double[vc], sy = new double[vc];
		double cos = Math.cos(turn), sin = Math.sin(turn);
		for (int v = 0; v < vc; v++) {
			double y = positions[v * 3 + 1] * scale, z = positions[v * 3 + 2] * scale;
			Coordinate c = t.transform(new Coordinate(offset.x + positions[v * 3] * scale, offset.y + y * cos - z * sin,
					offset.z + y * sin + z * cos));
			sx[v] = back ? c.z : c.x;
			sy[v] = c.y;
		}
		boolean[] facing = new boolean[tc];
		for (int f = 0; f < tc; f++) {
			int a = triangles[f * 3], b = triangles[f * 3 + 1], c = triangles[f * 3 + 2];
			facing[f] = (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sy[b] - sy[a]) * (sx[c] - sx[a]) > 0;
		}
		// Silhouette edges: between a triangle facing the viewer and one facing away, or at an open border.
		Path2D.Double lines = new Path2D.Double();
		int[] e = edges();
		for (int i = 0; i < e.length; i += 4) {
			if (e[i + 3] < 0 || facing[e[i + 2]] != facing[e[i + 3]]) {
				lines.moveTo(sx[e[i]], sy[e[i]]);
				lines.lineTo(sx[e[i + 1]], sy[e[i + 1]]);
			}
		}
		return new java.awt.Shape[] { lines, hull(sx, sy) };
	}

	/** Convex hull of the points (monotone chain). */
	private static Path2D.Double hull(double[] x, double[] y) {
		int n = x.length;
		Integer[] order = new Integer[n];
		for (int i = 0; i < n; i++) {
			order[i] = i;
		}
		Arrays.sort(order, (i, j) -> x[i] != x[j] ? Double.compare(x[i], x[j]) : Double.compare(y[i], y[j]));
		int[] h = new int[2 * n + 1];
		int k = 0;
		for (int i = 0; i < n; i++) {
			while (k >= 2 && cross(x, y, h[k - 2], h[k - 1], order[i]) <= 0) {
				k--;
			}
			h[k++] = order[i];
		}
		for (int i = n - 2, lower = k + 1; i >= 0; i--) {
			while (k >= lower && cross(x, y, h[k - 2], h[k - 1], order[i]) <= 0) {
				k--;
			}
			h[k++] = order[i];
		}
		Path2D.Double out = new Path2D.Double();
		for (int i = 0; i < Math.max(1, k - 1); i++) {
			if (i == 0) {
				out.moveTo(x[h[0]], y[h[0]]);
			} else {
				out.lineTo(x[h[i]], y[h[i]]);
			}
		}
		out.closePath();
		return out;
	}

	private static double cross(double[] x, double[] y, int o, int a, int b) {
		return (x[a] - x[o]) * (y[b] - y[o]) - (y[a] - y[o]) * (x[b] - x[o]);
	}

	/**
	 * Little-endian bytes, packed by hand: in the browser (CheerpJ), ByteBuffer.putShort into a
	 * heap buffer left zeros in its array.
	 */
	private static final class Bytes {
		final byte[] a;
		int p;

		Bytes(int size) {
			a = new byte[size];
		}

		Bytes(byte[] data) {
			a = data;
		}

		Bytes u8(int v) {
			a[p++] = (byte) v;
			return this;
		}

		Bytes u16(int v) {
			a[p++] = (byte) v;
			a[p++] = (byte) (v >>> 8);
			return this;
		}

		Bytes i32(int v) {
			u16(v);
			return u16(v >>> 16);
		}

		Bytes f32(float v) {
			return i32(Float.floatToRawIntBits(v));
		}

		Bytes f64(double v) {
			long l = Double.doubleToRawLongBits(v);
			i32((int) l);
			return i32((int) (l >>> 32));
		}

		int u16() {
			int v = (a[p] & 0xFF) | (a[p + 1] & 0xFF) << 8;
			p += 2;
			return v;
		}

		int i32() {
			return u16() | u16() << 16;
		}

		float f32() {
			return Float.intBitsToFloat(i32());
		}

		double f64() {
			long lo = i32() & 0xFFFFFFFFL;
			return Double.longBitsToDouble(lo | (long) i32() << 32);
		}
	}

	/** A long -> int hash map (open addressing), without boxing. */
	private static final class LongIntMap {
		private long[] keys;
		private int[] values;
		private int size;

		LongIntMap(int expected) {
			int cap = Integer.highestOneBit(Math.max(16, expected * 2 - 1)) << 1;
			keys = new long[cap];
			values = new int[cap];
			Arrays.fill(keys, Long.MIN_VALUE);
		}

		int get(long key) {
			int mask = keys.length - 1;
			for (int i = mix(key) & mask;; i = (i + 1) & mask) {
				if (keys[i] == key) {
					return values[i];
				}
				if (keys[i] == Long.MIN_VALUE) {
					return -1;
				}
			}
		}

		void put(long key, int value) {
			if (size * 2 >= keys.length) {
				long[] ok = keys;
				int[] ov = values;
				keys = new long[ok.length * 2];
				values = new int[ok.length * 2];
				Arrays.fill(keys, Long.MIN_VALUE);
				size = 0;
				for (int i = 0; i < ok.length; i++) {
					if (ok[i] != Long.MIN_VALUE) {
						put(ok[i], ov[i]);
					}
				}
			}
			int mask = keys.length - 1;
			int i = mix(key) & mask;
			while (keys[i] != Long.MIN_VALUE && keys[i] != key) {
				i = (i + 1) & mask;
			}
			if (keys[i] == Long.MIN_VALUE) {
				size++;
			}
			keys[i] = key;
			values[i] = value;
		}

		private static int mix(long k) {
			k ^= k >>> 33;
			k *= 0xff51afd7ed558ccdL;
			k ^= k >>> 33;
			return (int) k;
		}
	}
}
