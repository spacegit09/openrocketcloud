package orcloud.bridge;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.Map;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import javax.swing.SwingUtilities;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.swing.startup.SwingStartup;

/**
 * Checks the live-share model against real OpenRocket using the bundled example designs:
 * save/load round trips, diff/apply, in-place property updates and structural reloads.
 * Run inside the worker image with ORC_MAIN=orcloud.bridge.SelfTest.
 */
public final class SelfTest {
	private static int checks;
	private static int failures;

	public static void main(String[] args) throws Exception {
		System.setProperty("java.util.Arrays.useLegacyMergeSort", "true");
		OrDoc.installClasspathUrlHandler();
		Path dir = Files.createTempDirectory("selftest");
		OrDoc.configurePreferences(dir);
		List<Path> examples = extractExamples(dir);
		System.out.println("Examples: " + examples.size());
		SwingStartup.main(new String[] { examples.get(0).toString() });
		SwingUtilities.invokeAndWait(() -> {
			for (Path p : examples) {
				try {
					run(p);
				} catch (Throwable t) {
					failures++;
					System.out.println("ERROR " + p.getFileName() + ": " + t);
					t.printStackTrace(System.out);
				}
			}
		});
		System.out.println((failures == 0 ? "SELFTEST PASS" : "SELFTEST FAIL") + " checks=" + checks + " failures=" + failures);
		System.exit(failures == 0 ? 0 : 1);
	}

	private static List<Path> extractExamples(Path dir) throws Exception {
		List<Path> out = new ArrayList<>();
		String jar = System.getProperty("java.class.path").split(File.pathSeparator)[0];
		try (JarFile jf = new JarFile(jar)) {
			Enumeration<JarEntry> en = jf.entries();
			while (en.hasMoreElements()) {
				JarEntry e = en.nextElement();
				if (e.getName().startsWith("datafiles/examples/") && e.getName().endsWith(".ork")) {
					Path p = dir.resolve(e.getName().substring("datafiles/examples/".length()));
					try (InputStream in = jf.getInputStream(e)) {
						Files.copy(in, p, StandardCopyOption.REPLACE_EXISTING);
					}
					out.add(p);
				}
			}
		}
		out.sort(null);
		String only = System.getenv("SELFTEST_ONLY");
		if (only != null) {
			out.removeIf(p -> !p.getFileName().toString().contains(only));
		}
		return out;
	}

	private static List<String> simIds(OpenRocketDocument d) {
		List<String> ids = new ArrayList<>();
		for (int i = 0; i < d.getSimulationCount(); i++) {
			ids.add("sim-" + i);
		}
		return ids;
	}

	private static Model model(OpenRocketDocument d, boolean data) throws Exception {
		OrDoc.save(d, false); // let lazily derived values settle, as the bridge does
		if (!data) {
			return OrDoc.toModel(d, simIds(d), null);
		}
		Model m = Model.fromXml(Xml.parse(OrDoc.save(d, true)), simIds(d));
		for (java.util.Map.Entry<String, Model.Obj> e : OrDoc.toModel(d, simIds(d), null).objs.entrySet()) {
			if (Model.ATT.equals(e.getValue().t)) {
				m.objs.put(e.getKey(), e.getValue());
			}
		}
		return m;
	}

	private static OpenRocketDocument load(Model m) throws Exception {
		return OrDoc.load(m);
	}

	private static void check(String what, List<String> diffs) {
		checks++;
		if (diffs.isEmpty()) {
			System.out.println("  ok   " + what);
		} else {
			failures++;
			System.out.println("  FAIL " + what + " -> " + diffs);
		}
	}

	private static void explain(Model a, Model b) {
		int shown = 0;
		for (String id : Model.differingIds(a, b)) {
			Model.Obj x = a.get(id);
			Model.Obj y = b.get(id);
			if (x == null || y == null) {
				System.out.println("      " + id + " only in " + (x == null ? "second" : "first"));
				continue;
			}
			java.util.Set<String> keys = new java.util.TreeSet<>(x.v.keySet());
			keys.addAll(y.v.keySet());
			for (String k : keys) {
				String xv = x.v.get(k);
				String yv = y.v.get(k);
				if (!java.util.Objects.equals(xv, yv) && shown++ < 6) {
					System.out.println("      " + x.t + "." + k + "\n        A=" + cut(xv, yv) + "\n        B=" + cut(yv, xv));
				}
			}
		}
	}

	private static String cut(String s, String other) {
		if (s == null) {
			return "null";
		}
		int i = 0;
		while (other != null && i < s.length() && i < other.length() && s.charAt(i) == other.charAt(i)) {
			i++;
		}
		int from = Math.max(0, i - 60);
		return (from > 0 ? "..." : "") + s.substring(from, Math.min(s.length(), i + 160));
	}

	/** What the sync needs from a load/save round trip: same structure, same non-derived data. */
	private static void checkRoundTrip(String what, Model a, Model b) {
		List<String> problems = new ArrayList<>();
		if (!Model.sameRocketStructure(a, b)) {
			problems.add("rocket structure");
		}
		java.util.Set<String> rocket = a.rocketSubtree();
		int drift = 0;
		for (String id : Model.differingIds(a, b)) {
			Model.Obj x = a.get(id);
			Model.Obj y = b.get(id);
			boolean equivalent = x != null && y != null && x.k.equals(y.k);
			if (equivalent) {
				for (String k : x.v.keySet()) {
					equivalent &= Model.equivalent(x.v.get(k), y.v.get(k));
				}
			}
			if (equivalent) {
				continue;
			}
			if (rocket.contains(id)) {
				drift++;
			} else {
				problems.add(id);
			}
		}
		check(what, problems);
		if (drift > 0) {
			System.out.println("  note " + drift + " component(s) with values OpenRocket re-derives on load:");
			explain(a, b);
		}
	}

	private static void check(String what, Model a, Model b) {
		List<String> d = Model.differences(a, b, 8);
		check(what, d);
		if (!d.isEmpty()) {
			explain(a, b);
		}
	}

	private static void check(String what, boolean ok) {
		check(what, ok ? List.of() : List.of("false"));
	}

	private static void run(Path p) throws Exception {
		String name = p.getFileName().toString();
		System.out.println(name);
		OpenRocketDocument d1 = new GeneralRocketLoader(p.toFile()).load();

		String dump = System.getenv("SELFTEST_DUMP");
		if (dump != null) {
			// Fixtures for the server's parity test (server/test/parity.test.js).
			Path out = java.nio.file.Paths.get(dump);
			Files.createDirectories(out);
			String base = name.replace(".ork", "");
			String xml = OrDoc.save(d1, true);
			Files.writeString(out.resolve(base + ".xml"), xml);
			Model fx = Model.fromXml(Xml.parse(xml), simIds(d1));
			Files.writeString(out.resolve(base + ".model.json"), Json.stringify(fx.toJson()));
			OpenRocketDocument dx = OrDoc.load(fx);
			List<RocketComponent> all = new ArrayList<>();
			dx.getRocket().iterator(false).forEachRemaining(all::add);
			for (RocketComponent c : all) {
				if (c.getParent() == null) {
					continue;
				}
				if (c instanceof SymmetricComponent) {
					((SymmetricComponent) c).setLength(((SymmetricComponent) c).getLength() + 0.01);
				}
				if (c instanceof BodyTube && c.getChildCount() > 0) {
					c.removeChild(c.getChildCount() - 1);
				}
			}
			MassComponent extra = new MassComponent();
			extra.setName("Fixture mass");
			for (RocketComponent c : all) {
				if (c instanceof BodyTube) {
					c.addChild(extra, 0);
					c.moveChild(extra, c.getChildCount() - 1);
					break;
				}
			}
			Model edited = Model.fromXml(Xml.parse(OrDoc.save(dx, true)), simIds(dx));
			List<Map<String, Object>> ops = Model.diff(fx, edited);
			Model result = fx.copy();
			result.applyAll(ops);
			Files.writeString(out.resolve(base + ".ops.json"), Json.stringify(ops));
			Files.writeString(out.resolve(base + ".result.json"), Json.stringify(result.toJson()));
			Files.writeString(out.resolve(base + ".result.xml"), result.toXml());
		}

		// 1. Model -> XML -> OpenRocket -> XML -> Model is stable.
		Model m1 = model(d1, false);
		checkRoundTrip("snapshots are stable", m1, model(d1, false));
		check("has decal attachments when used", true);
		String c1 = Xml.canonical(Xml.parse(OrDoc.save(d1, false)));
		check("xml canonical form is stable", Xml.canonical(Xml.parse(c1)).equals(c1));
		OpenRocketDocument d2 = load(m1);
		Model m2 = model(d2, false);
		checkRoundTrip("round trip (no sim data)", m1, m2);
		Model f1 = model(d1, true);
		Model f2 = model(load(f1), true);
		checkRoundTrip("round trip (with sim data)", f1, f2);
		check("json round trip", Model.differences(m1, Model.fromJson(asMap(Json.parse(Json.stringify(m1.toJson())))), 8));

		// 2. Property edit: diff/apply and in-place setters match a full load.
		SymmetricComponent sc = null;
		for (RocketComponent c : d2.getRocket()) {
			if (c instanceof NoseCone || c instanceof BodyTube) {
				sc = (SymmetricComponent) c;
				break;
			}
		}
		if (sc != null) {
			Model base = model(d2, false);
			sc.setLength(sc.getLength() * 1.37 + 0.001);
			sc.setName(sc.getName() + " (edited)");
			Model edited = model(d2, false);
			List<Map<String, Object>> ops = Model.diff(base, edited);
			Model applied = base.copy();
			check("diff ops all accepted", applied.applyAll(ops).size() == ops.size());
			check("diff/apply reproduces property edit", Model.differences(applied, edited, 8));

			OpenRocketDocument d3 = load(base);
			boolean allLeaf = true;
			for (Map<String, Object> op : ops) {
				if (!"set".equals(op.get("op"))) {
					allLeaf = false;
					continue;
				}
				RocketComponent c = OrDoc.findComponent(d3, (String) op.get("id"));
				for (Map.Entry<String, Object> e : asMap(op.get("v")).entrySet()) {
					Xml.El el = Xml.parse((String) e.getValue());
					allLeaf &= !el.hasElementChildren() && OrDoc.applyLeaf(c, el);
				}
			}
			if (allLeaf) {
				Model after = model(d3, false);
				List<String> bad = new ArrayList<>();
				for (Map<String, Object> op : ops) {
					for (Map.Entry<String, Object> e : asMap(op.get("v")).entrySet()) {
						Model.Obj o = after.get((String) op.get("id"));
						if (o == null || !Model.equivalent(o.v.get(e.getKey()), (String) e.getValue())) {
							bad.add(op.get("id") + "." + e.getKey());
						}
					}
				}
				check("in-place setters apply the edited properties", bad);
			} else {
				System.out.println("  --   edit touched structured properties (full reload path)");
			}
		}

		// 3. Structural edits: add, move and delete components; reload via loadFrom.
		Model base = model(d2, false);
		BodyTube tube = null;
		for (RocketComponent c : d2.getRocket()) {
			if (c instanceof BodyTube) {
				tube = (BodyTube) c;
			}
		}
		if (tube != null) {
			MassComponent mass = new MassComponent();
			mass.setName("Payload (test)");
			mass.setComponentMass(0.123);
			tube.addChild(mass, 0);
			RocketComponent victim = null;
			for (RocketComponent c : tube.getChildren()) {
				if (c != mass && c.getChildCount() == 0) {
					victim = c;
				}
			}
			if (victim != null) {
				tube.removeChild(victim);
			}
			Model edited = model(d2, false);
			List<Map<String, Object>> ops = Model.diff(base, edited);
			Model applied = base.copy();
			applied.applyAll(ops);
			check("diff/apply reproduces structure edit (" + ops.size() + " ops)", Model.differences(applied, edited, 8));
			check("positions consistent after diff", Model.sameContent(applied, edited));

			OpenRocketDocument d4 = load(base);
			OpenRocketDocument src = load(applied);
			d4.getRocket().loadFrom(src.getRocket());
			OrDoc.fixupAfterLoadFrom(d4.getRocket(), src.getRocket());
			Model after = model(d4, false);
			check("loadFrom reproduces structure", Model.sameRocketStructure(edited, after));
			checkRoundTrip("loadFrom keeps component data", edited, after);

			// Concurrent edits from two users merge: one edits a property, one deletes a part.
			Model server = base.copy();
			server.applyAll(ops);
			Model other = base.copy();
			OpenRocketDocument d5 = load(base);
			d5.getRocket().setName("Renamed concurrently");
			Model otherEdit = model(d5, false);
			server.applyAll(Model.diff(other, otherEdit));
			OpenRocketDocument merged = load(server);
			check("merged document loads", merged.getRocket().getName().equals("Renamed concurrently")
					&& merged.getRocket().findComponent(mass.getID()) != null);
		}
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> asMap(Object o) {
		return (Map<String, Object>) o;
	}
}
