package orcloud.bridge;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;

/**
 * The shared, mergeable form of an OpenRocket document.
 *
 * Every rocket component (keyed by its OpenRocket UUID), every simulation and every other
 * top-level element becomes an object with a parent, a fractional sort position and an
 * ordered set of properties. A property is one child element of the component, stored as
 * canonical XML. Concurrent edits merge per property (last writer wins), structure merges
 * per object. server/src/model.js implements the same rules; keep them in sync.
 */
final class Model {
	static final String DOC = "doc";
	static final String SIMS = "sims";
	static final String ATTRS = "@";
	static final String RAW = "#raw";
	/** Binary attachment (decal image); id is "att:" + entry name, data in v["data"] (base64). */
	static final String ATT = "#att";

	static final class Obj {
		String t;
		String p;
		double o;
		List<String> k = new ArrayList<>();
		Map<String, String> v = new HashMap<>();

		Obj() {
		}

		Obj(String t, String p, double o) {
			this.t = t;
			this.p = p;
			this.o = o;
		}

		Obj copy() {
			Obj c = new Obj(t, p, o);
			c.k = new ArrayList<>(k);
			c.v = new HashMap<>(v);
			return c;
		}

		boolean sameProps(Obj b) {
			return b != null && t.equals(b.t) && k.equals(b.k) && v.equals(b.v);
		}
	}

	final Map<String, Obj> objs = new HashMap<>();

	Model copy() {
		Model m = new Model();
		for (Map.Entry<String, Obj> e : objs.entrySet()) {
			m.objs.put(e.getKey(), e.getValue().copy());
		}
		return m;
	}

	Obj get(String id) {
		return objs.get(id);
	}

	/** Children of every object, each list sorted by (position, id). */
	Map<String, List<String>> childIndex() {
		Map<String, List<String>> idx = new HashMap<>();
		for (Map.Entry<String, Obj> e : objs.entrySet()) {
			String p = e.getValue().p;
			if (p != null) {
				idx.computeIfAbsent(p, x -> new ArrayList<>()).add(e.getKey());
			}
		}
		Comparator<String> cmp = (a, b) -> {
			int c = Double.compare(objs.get(a).o, objs.get(b).o);
			return c != 0 ? c : a.compareTo(b);
		};
		for (List<String> l : idx.values()) {
			l.sort(cmp);
		}
		return idx;
	}

	/** Attachment entry name -> bytes, sorted by name. */
	Map<String, byte[]> attachments() {
		Map<String, byte[]> out = new java.util.TreeMap<>();
		for (Map.Entry<String, Obj> e : objs.entrySet()) {
			if (ATT.equals(e.getValue().t) && e.getKey().startsWith("att:")) {
				out.put(e.getKey().substring(4), java.util.Base64.getDecoder().decode(e.getValue().v.getOrDefault("data", "")));
			}
		}
		return out;
	}

	String rocketId() {
		for (Map.Entry<String, Obj> e : objs.entrySet()) {
			if (DOC.equals(e.getValue().p) && "rocket".equals(e.getValue().t)) {
				return e.getKey();
			}
		}
		return null;
	}

	/** Ids of the rocket and all its components. */
	Set<String> rocketSubtree() {
		Set<String> out = new HashSet<>();
		String root = rocketId();
		if (root == null) {
			return out;
		}
		Map<String, List<String>> idx = childIndex();
		List<String> stack = new ArrayList<>();
		stack.add(root);
		while (!stack.isEmpty()) {
			String x = stack.remove(stack.size() - 1);
			if (out.add(x)) {
				stack.addAll(idx.getOrDefault(x, Collections.emptyList()));
			}
		}
		return out;
	}

	/** Same rocket components, with the same types, parents and sibling order. */
	static boolean sameRocketStructure(Model a, Model b) {
		Set<String> ra = a.rocketSubtree();
		if (!ra.equals(b.rocketSubtree())) {
			return false;
		}
		Map<String, List<String>> ai = a.childIndex();
		Map<String, List<String>> bi = b.childIndex();
		for (String id : ra) {
			Obj x = a.get(id);
			Obj y = b.get(id);
			if (!x.t.equals(y.t) || !Objects.equals(x.p, y.p) || !Objects.equals(ai.get(id), bi.get(id))) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Equal, or equal apart from floating-point noise in numbers (OpenRocket re-derives some
	 * values on load, which can move the last digit or two).
	 */
	static boolean equivalent(String x, String y) {
		if (Objects.equals(x, y)) {
			return true;
		}
		if (x == null || y == null) {
			return false;
		}
		java.util.regex.Matcher mx = NUMBER.matcher(x);
		java.util.regex.Matcher my = NUMBER.matcher(y);
		int px = 0;
		int py = 0;
		while (true) {
			boolean fx = mx.find();
			boolean fy = my.find();
			if (fx != fy) {
				return false;
			}
			if (!fx) {
				return x.substring(px).equals(y.substring(py));
			}
			if (!x.substring(px, mx.start()).equals(y.substring(py, my.start()))) {
				return false;
			}
			double dx = Double.parseDouble(mx.group());
			double dy = Double.parseDouble(my.group());
			if (Math.abs(dx - dy) > 1e-9 * Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)))) {
				return false;
			}
			px = mx.end();
			py = my.end();
		}
	}

	private static final java.util.regex.Pattern NUMBER = java.util.regex.Pattern.compile("-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?");

	/** True if id is the rocket or lies inside it. */
	boolean inRocket(String id) {
		String rocket = rocketId();
		int guard = 0;
		for (String x = id; x != null && guard++ < 10000; x = objs.containsKey(x) ? objs.get(x).p : null) {
			if (x.equals(rocket)) {
				return true;
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ XML <-> model

	static Model fromXml(Xml.El root, List<String> simIds) {
		Model m = new Model();
		Obj doc = new Obj(root.tag, null, 0);
		doc.v.put(ATTRS, Xml.attrsCanonical(root.attrs));
		m.objs.put(DOC, doc);
		Map<String, Integer> rawCount = new HashMap<>();
		boolean haveRocket = false;
		boolean haveSims = false;
		int idx = 0;
		for (Xml.El c : root.elements()) {
			idx++;
			if (c.tag.equals("rocket") && !haveRocket) {
				haveRocket = true;
				m.addObject(c, null, DOC, idx, true);
			} else if (c.tag.equals("simulations") && !haveSims) {
				haveSims = true;
				Obj sims = new Obj("simulations", DOC, idx);
				sims.v.put(ATTRS, Xml.attrsCanonical(c.attrs));
				m.objs.put(SIMS, sims);
				int j = 0;
				for (Xml.El s : c.elements()) {
					if (!s.tag.equals("simulation")) {
						continue;
					}
					String id = simIds != null && j < simIds.size() ? simIds.get(j) : null;
					j++;
					m.addObject(s, id, SIMS, j, false);
				}
			} else {
				int n = rawCount.merge(c.tag, 1, Integer::sum);
				Obj raw = new Obj(RAW, DOC, idx);
				raw.k.add("xml");
				raw.v.put("xml", Xml.canonical(c));
				m.objs.put("doc:" + c.tag + (n > 1 ? "#" + n : ""), raw);
			}
		}
		return m;
	}

	private static boolean reserved(String id) {
		return id.equals(DOC) || id.equals(SIMS) || id.startsWith("doc:");
	}

	private void addObject(Xml.El el, String givenId, String parent, double pos, boolean component) {
		String id = givenId;
		Xml.El idEl = component ? el.first("id") : null;
		if (component && idEl != null) {
			id = idEl.text().trim();
		}
		boolean regen = id == null || id.isEmpty() || objs.containsKey(id) || reserved(id);
		if (regen) {
			id = UUID.randomUUID().toString();
		}
		Obj obj = new Obj(el.tag, parent, pos);
		obj.v.put(ATTRS, Xml.attrsCanonical(el.attrs));
		objs.put(id, obj);
		Map<String, Integer> counts = new HashMap<>();
		for (Xml.El ch : el.elements()) {
			if (component && ch.tag.equals("subcomponents")) {
				int j = 0;
				for (Xml.El g : ch.elements()) {
					addObject(g, null, id, ++j, true);
				}
				continue;
			}
			String cfg = ch.attrs.get("configid");
			String base = cfg != null ? ch.tag + "[" + cfg + "]" : ch.tag;
			int n = counts.merge(base, 1, Integer::sum);
			String key = n == 1 ? base : base + "#" + n;
			obj.k.add(key);
			obj.v.put(key, regen && component && ch == idEl ? "<id>" + id + "</id>" : Xml.canonical(ch));
		}
		if (regen && component && idEl == null) {
			int at = obj.k.indexOf("name") + 1;
			obj.k.add(at, "id");
			obj.v.put("id", "<id>" + id + "</id>");
		}
	}

	String toXml() {
		Map<String, List<String>> idx = childIndex();
		StringBuilder sb = new StringBuilder("<?xml version='1.0' encoding='utf-8'?>\n");
		emit(sb, DOC, idx);
		sb.append('\n');
		return sb.toString();
	}

	private void emit(StringBuilder sb, String id, Map<String, List<String>> idx) {
		Obj o = objs.get(id);
		if (RAW.equals(o.t)) {
			sb.append(o.v.getOrDefault("xml", ""));
			return;
		}
		if (ATT.equals(o.t)) {
			return;
		}
		sb.append('<').append(o.t).append(o.v.getOrDefault(ATTRS, "")).append('>');
		for (String key : o.k) {
			String val = o.v.get(key);
			if (val != null && !key.startsWith("#")) { // "#..." keys are sync metadata, not XML
				sb.append(val);
			}
		}
		List<String> kids = idx.get(id);
		if (kids != null && !kids.isEmpty()) {
			boolean wrap = !(o.t.equals("openrocket") || o.t.equals("simulations"));
			if (wrap) {
				sb.append("<subcomponents>");
			}
			for (String kid : kids) {
				emit(sb, kid, idx);
			}
			if (wrap) {
				sb.append("</subcomponents>");
			}
		}
		sb.append("</").append(o.t).append('>');
	}

	// ------------------------------------------------------------------ operations

	@SuppressWarnings("unchecked")
	boolean apply(Map<String, Object> op) {
		Object kindObj = op.get("op");
		Object idObj = op.get("id");
		if (!(kindObj instanceof String) || !(idObj instanceof String)) {
			return false;
		}
		String id = (String) idObj;
		switch ((String) kindObj) {
		case "put": {
			String p = op.get("p") instanceof String ? (String) op.get("p") : null;
			if (!(op.get("t") instanceof String)) {
				return false;
			}
			if (p == null ? !id.equals(DOC) : (!objs.containsKey(p) || wouldCycle(id, p))) {
				return false;
			}
			Obj o = new Obj((String) op.get("t"), p, num(op.get("o")));
			if (op.get("v") instanceof Map) {
				for (Map.Entry<String, Object> e : ((Map<String, Object>) op.get("v")).entrySet()) {
					if (e.getValue() instanceof String) {
						o.v.put(e.getKey(), (String) e.getValue());
					}
				}
			}
			o.k = order(op.get("k"), o.v, new ArrayList<>());
			objs.put(id, o);
			return true;
		}
		case "set": {
			Obj o = objs.get(id);
			if (o == null || !(op.get("v") instanceof Map)) {
				return false;
			}
			for (Map.Entry<String, Object> e : ((Map<String, Object>) op.get("v")).entrySet()) {
				String key = e.getKey();
				if (e.getValue() instanceof String) {
					o.v.put(key, (String) e.getValue());
					if (!key.equals(ATTRS) && !o.k.contains(key)) {
						o.k.add(key);
					}
				} else {
					o.v.remove(key);
					o.k.remove(key);
				}
			}
			if (op.get("k") instanceof List) {
				o.k = order(op.get("k"), o.v, o.k);
			}
			return true;
		}
		case "move": {
			Obj o = objs.get(id);
			String p = op.get("p") instanceof String ? (String) op.get("p") : null;
			if (o == null || id.equals(DOC) || p == null || !objs.containsKey(p) || wouldCycle(id, p)) {
				return false;
			}
			o.p = p;
			o.o = num(op.get("o"));
			return true;
		}
		case "del": {
			if (!objs.containsKey(id) || id.equals(DOC)) {
				return false;
			}
			Map<String, List<String>> idx = childIndex();
			List<String> stack = new ArrayList<>();
			stack.add(id);
			while (!stack.isEmpty()) {
				String x = stack.remove(stack.size() - 1);
				objs.remove(x);
				List<String> kids = idx.get(x);
				if (kids != null) {
					stack.addAll(kids);
				}
			}
			return true;
		}
		default:
			return false;
		}
	}

	/** Applies ops in order and returns the accepted ones. */
	List<Map<String, Object>> applyAll(List<Map<String, Object>> ops) {
		List<Map<String, Object>> ok = new ArrayList<>();
		for (Map<String, Object> op : ops) {
			if (apply(op)) {
				ok.add(op);
			}
		}
		return ok;
	}

	private boolean wouldCycle(String id, String parent) {
		int guard = 0;
		for (String x = parent; x != null && guard++ < 100000; x = objs.containsKey(x) ? objs.get(x).p : null) {
			if (x.equals(id)) {
				return true;
			}
		}
		return false;
	}

	private static double num(Object o) {
		return o instanceof Number ? ((Number) o).doubleValue() : 0;
	}

	@SuppressWarnings("unchecked")
	private static List<String> order(Object requested, Map<String, String> v, List<String> current) {
		List<String> out = new ArrayList<>();
		Set<String> seen = new HashSet<>();
		if (requested instanceof List) {
			for (Object x : (List<Object>) requested) {
				if (x instanceof String && !x.equals(ATTRS) && v.containsKey(x) && seen.add((String) x)) {
					out.add((String) x);
				}
			}
		}
		for (String x : current) {
			if (v.containsKey(x) && seen.add(x)) {
				out.add(x);
			}
		}
		for (String x : new TreeSet<>(v.keySet())) {
			if (!x.equals(ATTRS) && seen.add(x)) {
				out.add(x);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ diff

	/**
	 * Operations turning {@code a} into {@code b}. Positions of {@code b}'s objects are
	 * rewritten to fractional positions consistent with {@code a}, so afterwards
	 * {@code a.apply(ops)} has the same content as {@code b} and {@code b} can serve as the
	 * new base for the next diff.
	 */
	static List<Map<String, Object>> diff(Model a, Model b) {
		return diff(a, b, null);
	}

	/**
	 * Like {@link #diff(Model, Model)}, but property changes of existing rocket components are
	 * only reported for components in {@code scope} (null = all). Structure, simulations and
	 * document-level elements are always compared.
	 */
	static List<Map<String, Object>> diff(Model a, Model b, Set<String> scope) {
		Set<String> rocket = scope == null ? Collections.emptySet() : b.rocketSubtree();
		List<Map<String, Object>> struct = new ArrayList<>();
		List<Map<String, Object>> sets = new ArrayList<>();
		List<Map<String, Object>> dels = new ArrayList<>();
		Set<String> created = new HashSet<>();
		Map<String, List<String>> bIdx = b.childIndex();
		if (!a.objs.containsKey(DOC) || !a.get(DOC).t.equals(b.get(DOC).t)) {
			struct.add(putOp(DOC, b.get(DOC)));
			created.add(DOC);
		}
		walk(a, b, DOC, bIdx, struct, created);

		for (String id : new TreeSet<>(b.objs.keySet())) {
			if (created.contains(id)) {
				continue;
			}
			Obj ao = a.get(id);
			Obj bo = b.get(id);
			if (ao == null || (scope != null && rocket.contains(id) && !scope.contains(id))) {
				continue;
			}
			Map<String, Object> v = new LinkedHashMap<>();
			Set<String> keys = new TreeSet<>(ao.v.keySet());
			keys.addAll(bo.v.keySet());
			List<String> simulated = new ArrayList<>(ao.k);
			for (String key : keys) {
				String av = ao.v.get(key);
				String bv = bo.v.get(key);
				if (!Objects.equals(av, bv)) {
					v.put(key, bv);
					if (bv == null) {
						simulated.remove(key);
					} else if (av == null && !key.equals(ATTRS)) {
						simulated.add(key);
					}
				}
			}
			boolean reorder = !simulated.equals(bo.k);
			if (!v.isEmpty() || reorder) {
				Map<String, Object> op = new LinkedHashMap<>();
				op.put("op", "set");
				op.put("id", id);
				op.put("v", v);
				if (reorder) {
					op.put("k", new ArrayList<>(bo.k));
				}
				sets.add(op);
			}
		}

		for (String id : new TreeSet<>(a.objs.keySet())) {
			if (b.objs.containsKey(id)) {
				continue;
			}
			String p = a.get(id).p;
			if (p == null || b.objs.containsKey(p)) {
				Map<String, Object> op = new LinkedHashMap<>();
				op.put("op", "del");
				op.put("id", id);
				dels.add(op);
			}
		}
		List<Map<String, Object>> out = new ArrayList<>(struct);
		out.addAll(sets);
		out.addAll(dels);
		return out;
	}

	private static void walk(Model a, Model b, String parent, Map<String, List<String>> bIdx,
			List<Map<String, Object>> struct, Set<String> created) {
		List<String> kids = bIdx.getOrDefault(parent, Collections.emptyList());
		int n = kids.size();
		if (n == 0) {
			return;
		}
		// Objects already under this parent in `a` keep their position if they form the
		// longest run that is still in order; everything else gets a new position.
		boolean[] anchor = new boolean[n];
		int[] cand = new int[n];
		int cn = 0;
		for (int i = 0; i < n; i++) {
			Obj ao = a.get(kids.get(i));
			if (ao != null && parent.equals(ao.p) && ao.t.equals(b.get(kids.get(i)).t)) {
				cand[cn++] = i;
			}
		}
		if (cn > 0) {
			int[] len = new int[cn];
			int[] prev = new int[cn];
			int best = 0;
			for (int x = 0; x < cn; x++) {
				len[x] = 1;
				prev[x] = -1;
				for (int y = 0; y < x; y++) {
					if (before(a, kids.get(cand[y]), kids.get(cand[x])) && len[y] + 1 > len[x]) {
						len[x] = len[y] + 1;
						prev[x] = y;
					}
				}
				if (len[x] > len[best]) {
					best = x;
				}
			}
			for (int x = best; x >= 0; x = prev[x]) {
				anchor[cand[x]] = true;
			}
		}
		double[] pos = new double[n];
		boolean renormalize = false;
		int i = 0;
		while (i < n) {
			if (anchor[i]) {
				pos[i] = a.get(kids.get(i)).o;
				i++;
				continue;
			}
			int j = i;
			while (j < n && !anchor[j]) {
				j++;
			}
			int cnt = j - i;
			Double left = i > 0 ? pos[i - 1] : null;
			Double right = j < n ? a.get(kids.get(j)).o : null;
			for (int r = 0; r < cnt; r++) {
				double val;
				if (left == null && right == null) {
					val = r + 1;
				} else if (left == null) {
					val = right - (cnt - r);
				} else if (right == null) {
					val = left + (r + 1);
				} else {
					double gap = (right - left) / (cnt + 1);
					double scale = Math.max(1, Math.max(Math.abs(left), Math.abs(right)));
					if (!(gap > 1e-9 * scale)) {
						renormalize = true;
					}
					val = left + gap * (r + 1);
				}
				pos[i + r] = val;
			}
			i = j;
		}
		if (renormalize) {
			for (int x = 0; x < n; x++) {
				pos[x] = x + 1;
			}
		}
		for (int x = 0; x < n; x++) {
			String id = kids.get(x);
			Obj bo = b.get(id);
			bo.o = pos[x];
			Obj ao = a.get(id);
			if (ao == null || !ao.t.equals(bo.t)) {
				if (ao != null) {
					Map<String, Object> del = new LinkedHashMap<>();
					del.put("op", "del");
					del.put("id", id);
					struct.add(del);
				}
				struct.add(putOp(id, bo));
				created.add(id);
			} else if (!parent.equals(ao.p) || ao.o != pos[x]) {
				Map<String, Object> op = new LinkedHashMap<>();
				op.put("op", "move");
				op.put("id", id);
				op.put("p", parent);
				op.put("o", pos[x]);
				struct.add(op);
			}
		}
		for (String id : kids) {
			walk(a, b, id, bIdx, struct, created);
		}
	}

	private static boolean before(Model a, String x, String y) {
		int c = Double.compare(a.get(x).o, a.get(y).o);
		return c != 0 ? c < 0 : x.compareTo(y) < 0;
	}

	private static Map<String, Object> putOp(String id, Obj o) {
		Map<String, Object> op = new LinkedHashMap<>();
		op.put("op", "put");
		op.put("id", id);
		op.put("t", o.t);
		op.put("p", o.p);
		op.put("o", o.o);
		op.put("k", new ArrayList<>(o.k));
		op.put("v", new LinkedHashMap<>(o.v));
		return op;
	}

	// ------------------------------------------------------------------ comparison

	static boolean sameContent(Model a, Model b) {
		return differences(a, b, 1).isEmpty();
	}

	/** Human-readable list of differences (for logs and verification), at most {@code limit}. */
	static List<String> differences(Model a, Model b, int limit) {
		List<String> out = new ArrayList<>();
		Set<String> ids = new TreeSet<>(a.objs.keySet());
		ids.addAll(b.objs.keySet());
		for (String id : ids) {
			if (out.size() >= limit) {
				return out;
			}
			Obj x = a.get(id);
			Obj y = b.get(id);
			if (x == null || y == null) {
				out.add((x == null ? "+" : "-") + id);
				continue;
			}
			if (!x.t.equals(y.t) || !Objects.equals(x.p, y.p)) {
				out.add("~" + id + " (type/parent)");
				continue;
			}
			Set<String> keys = new TreeSet<>(x.v.keySet());
			keys.addAll(y.v.keySet());
			for (String key : keys) {
				if (!Objects.equals(x.v.get(key), y.v.get(key))) {
					out.add("~" + id + "." + key);
				}
			}
			if (!x.k.equals(y.k)) {
				out.add("~" + id + " (property order)");
			}
		}
		if (out.size() < limit && !a.childIndex().equals(b.childIndex())) {
			out.add("~ (child order)");
		}
		return out;
	}

	/** Ids of objects whose content differs, plus parents whose children are ordered differently. */
	static Set<String> differingIds(Model a, Model b) {
		Set<String> out = new TreeSet<>();
		Set<String> ids = new TreeSet<>(a.objs.keySet());
		ids.addAll(b.objs.keySet());
		for (String id : ids) {
			Obj x = a.get(id);
			Obj y = b.get(id);
			if (x == null || y == null || !x.sameProps(y) || !Objects.equals(x.p, y.p)) {
				out.add(id);
			}
		}
		Map<String, List<String>> ai = a.childIndex();
		Map<String, List<String>> bi = b.childIndex();
		Set<String> parents = new HashSet<>(ai.keySet());
		parents.addAll(bi.keySet());
		for (String p : parents) {
			if (!Objects.equals(ai.get(p), bi.get(p))) {
				out.add(p);
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ simulation result basis

	/** Fingerprint of the shared rocket design (structure and every property). */
	String rocketFingerprint() {
		Map<String, List<String>> idx = childIndex();
		StringBuilder sb = new StringBuilder();
		for (String id : new TreeSet<>(rocketSubtree())) {
			Obj o = objs.get(id);
			sb.append(id).append('\u0001').append(o.t).append('\u0001').append(o.p).append('\u0001');
			for (String k : o.k) {
				sb.append(k).append('=').append(o.v.get(k)).append('\u0002');
			}
			sb.append(o.v.getOrDefault(ATTRS, "")).append('\u0001').append(idx.getOrDefault(id, Collections.emptyList())).append('\n');
		}
		return sha1(sb.toString());
	}

	/**
	 * What a simulation's results were computed from: the rocket plus the simulation's own
	 * settings. Results are only current if their recorded basis matches.
	 */
	static String basis(String rocketFingerprint, Obj sim) {
		StringBuilder sb = new StringBuilder(rocketFingerprint);
		for (String k : new TreeSet<>(sim.v.keySet())) {
			if (!k.equals("flightdata") && !k.equals(ATTRS) && !k.startsWith("#")) {
				sb.append('\u0001').append(k).append('=').append(sim.v.get(k));
			}
		}
		return sha1(sb.toString());
	}

	private static String sha1(String s) {
		try {
			return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-1")
					.digest(s.getBytes(java.nio.charset.StandardCharsets.UTF_8))).substring(0, 20);
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	// ------------------------------------------------------------------ JSON

	Map<String, Object> toJson() {
		Map<String, Object> m = new LinkedHashMap<>();
		for (Map.Entry<String, Obj> e : objs.entrySet()) {
			Obj o = e.getValue();
			Map<String, Object> j = new LinkedHashMap<>();
			j.put("t", o.t);
			j.put("p", o.p);
			j.put("o", o.o);
			j.put("k", o.k);
			j.put("v", o.v);
			m.put(e.getKey(), j);
		}
		Map<String, Object> root = new LinkedHashMap<>();
		root.put("objs", m);
		return root;
	}

	@SuppressWarnings("unchecked")
	static Model fromJson(Map<String, Object> json) {
		Model m = new Model();
		Map<String, Object> objs = (Map<String, Object>) json.get("objs");
		for (Map.Entry<String, Object> e : objs.entrySet()) {
			Map<String, Object> j = (Map<String, Object>) e.getValue();
			Obj o = new Obj((String) j.get("t"), (String) j.get("p"), num(j.get("o")));
			for (Object k : (List<Object>) j.get("k")) {
				o.k.add((String) k);
			}
			for (Map.Entry<String, Object> v : ((Map<String, Object>) j.get("v")).entrySet()) {
				o.v.put(v.getKey(), (String) v.getValue());
			}
			m.objs.put(e.getKey(), o);
		}
		return m;
	}
}
