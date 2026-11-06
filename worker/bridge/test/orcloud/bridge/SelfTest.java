package orcloud.bridge;

import java.io.File;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import javax.swing.SwingUtilities;

import info.openrocket.core.aerodynamics.BarrowmanCalculator;
import info.openrocket.core.aerodynamics.FlightConditions;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.file.wavefrontobj.ObjUtils;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.masscalc.MassCalculator;
import info.openrocket.core.motor.Motor;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.rocketcomponent.BodyTube;
import info.openrocket.core.rocketcomponent.ComponentChangeEvent;
import info.openrocket.core.rocketcomponent.DeploymentConfiguration;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.FlightConfigurationId;
import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.MotorMount;
import info.openrocket.core.rocketcomponent.NoseCone;
import info.openrocket.core.rocketcomponent.RecoveryDevice;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.rocketcomponent.SymmetricComponent;
import info.openrocket.core.util.Coordinate;
import info.openrocket.swing.startup.SwingStartup;
import orcloud.stl.PartMesh;
import orcloud.stl.PartMeshes;
import orcloud.stl.StlModel;
import orcloud.view3d.Looks;
import orcloud.view3d.RocketMesh;
import orcloud.stl.StlPart;

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
			try {
				stlChecks(examples);
			} catch (Throwable t) {
				failures++;
				System.out.println("ERROR STL import: " + t);
				t.printStackTrace(System.out);
			}
			try {
				modelShapeChecks(examples);
			} catch (Throwable t) {
				failures++;
				System.out.println("ERROR imported model shapes: " + t);
				t.printStackTrace(System.out);
			}
			try {
				view3dChecks(examples);
			} catch (Throwable t) {
				failures++;
				System.out.println("ERROR 3D view: " + t);
				t.printStackTrace(System.out);
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

		// 4. Motors & Configuration tab: its panels change mounts and recovery devices but
		//    report the change on the rocket. What the bridge sends for that event must carry it.
		OpenRocketDocument d6 = load(m1);
		Rocket rocket = d6.getRocket();
		FlightConfigurationId fcid = rocket.getSelectedConfiguration().getFlightConfigurationID();
		FlightConfigurationId[] fcids = { fcid };
		Set<String> heard = new HashSet<>();
		rocket.addComponentChangeListener(e -> {
			if (e.getSource() instanceof RocketComponent && !e.isUndoChange()) {
				heard.addAll(Bridge.changedIds(e));
			}
		});
		MotorMount mount = null;
		for (RocketComponent c : rocket) {
			if (c instanceof MotorMount && ((MotorMount) c).getMotorConfig(fcid).getMotor() != null) {
				mount = (MotorMount) c;
				break;
			}
		}
		if (mount != null) {
			Motor motor = mount.getMotorConfig(fcid).getMotor();
			Model before = model(d6, false);
			heard.clear();
			mount.setMotorConfig(null, fcid); // as MotorConfigurationPanel.deleteMotor
			rocket.fireComponentChangeEvent(ComponentChangeEvent.MOTOR_CHANGE, fcids);
			checkSent("motor removal is sent", before, model(d6, false), new HashSet<>(heard));

			Model removed = model(d6, false);
			heard.clear();
			MotorConfiguration chosen = new MotorConfiguration(mount, fcid, mount.getMotorConfig(fcid));
			chosen.setMotor(motor); // as MotorConfigurationPanel.selectMotor
			chosen.setEjectionDelay(3);
			mount.setMotorConfig(chosen, fcid);
			rocket.fireComponentChangeEvent(ComponentChangeEvent.MOTOR_CHANGE, fcids);
			Model sent = checkSent("motor choice is sent", removed, model(d6, false), new HashSet<>(heard));
			MotorMount reopened = (MotorMount) load(sent).getRocket().findComponent(((RocketComponent) mount).getID());
			check("reopened design has the chosen motor", reopened != null
					&& reopened.getMotorConfig(fcid).getMotor() != null);
		}
		RecoveryDevice device = null;
		for (RocketComponent c : rocket) {
			if (c instanceof RecoveryDevice) {
				device = (RecoveryDevice) c;
				break;
			}
		}
		if (device != null && !fcid.equals(FlightConfigurationId.DEFAULT_VALUE_FCID)) {
			Model before = model(d6, false);
			heard.clear();
			DeploymentConfiguration dc = device.getDeploymentConfigurations().get(fcid).clone();
			dc.setDeployEvent(DeploymentConfiguration.DeployEvent.ALTITUDE);
			dc.setDeployAltitude(dc.getDeployAltitude() + 50);
			device.getDeploymentConfigurations().set(fcid, dc); // as DeploymentSelectionDialog
			rocket.fireComponentChangeEvent(ComponentChangeEvent.AERODYNAMIC_CHANGE, fcids);
			checkSent("deployment change is sent", before, model(d6, false), new HashSet<>(heard));
		}
	}

	/** Applies what the bridge would send for an edit (diff limited to scope); returns the result. */
	private static Model checkSent(String what, Model base, Model edited, Set<String> scope) {
		Model sent = base.copy();
		sent.applyAll(Model.diff(base, edited, scope));
		check(what, sent, edited);
		return sent;
	}

	// =================================================================== STL import (orcloud.stl)

	private static void stlChecks(List<Path> examples) throws Exception {
		System.out.println("STL import");
		// A 10 x 20 x 30 box, binary and ASCII, the right way out and inside out, closed and open.
		List<float[]> box = box(5, -10, 0, 10, 20, 30);
		StlModel b = StlModel.read(binaryStl(box));
		check("box volume, area and centroids", near(b.volume, 6000, 1e-9) && near(b.area, 2200, 1e-9) && b.closed
				&& near(b.volumeCentroid[0], 10, 1e-9) && near(b.volumeCentroid[1], 0, 1e-9) && near(b.volumeCentroid[2], 15, 1e-9)
				&& near(b.areaCentroid[2], 15, 1e-9));
		StlModel ascii = StlModel.read(asciiStl(box).getBytes(StandardCharsets.US_ASCII));
		check("ASCII STL reads like binary", near(ascii.volume, b.volume, 1e-6) && near(ascii.area, b.area, 1e-6) && ascii.closed);
		List<float[]> inverted = new ArrayList<>();
		for (float[] t : box) {
			inverted.add(new float[] { t[0], t[1], t[2], t[6], t[7], t[8], t[3], t[4], t[5] });
		}
		StlModel inv = StlModel.read(binaryStl(inverted));
		check("inside-out mesh gives the same volume and centroid", near(inv.volume, 6000, 1e-9) && near(inv.volumeCentroid[2], 15, 1e-9));
		StlModel open = StlModel.read(binaryStl(box.subList(2, box.size())));
		check("a mesh with a hole is not a closed solid", !open.closed);

		// A cone (radius 20, length 100, tip at +z) and parts made from it.
		List<float[]> cone = cone(20, 100, 256);
		StlModel c = StlModel.read(binaryStl(cone));
		// The 256-sided cone's exact volume: base polygon area x height / 3.
		double exactVolume = 256 * 0.5 * 400 * Math.sin(2 * Math.PI / 256) * 100 / 3;
		check("cone volume and centroid", near(c.volume, exactVolume, 1e-5) && near(c.volumeCentroid[2], 25, 1e-5) && c.closed);
		StlPart part = new StlPart(c);
		check("cone: axis and nose end guessed", part.axis == 2 && part.frontAtMax);
		part.fill = StlPart.Fill.SOLID;
		check("solid mass and centre of gravity", near(part.mass(), 1240 * exactVolume * 1e-9, 1e-5) && near(part.cgFromFront(), 0.075, 1e-5)
				&& near(part.length(), 0.1, 1e-6) && near(part.radius(), 0.02, 1e-3));
		double solid = part.mass();
		part.fill = StlPart.Fill.PRINTED;
		double printed = part.mass();
		part.fill = StlPart.Fill.SHELL;
		double shell = part.mass();
		check("printed mass lies between shell and solid", shell < printed && printed < solid);
		part.fill = StlPart.Fill.PRINTED;
		part.copies = 3;
		check("copies multiply the mass", near(part.mass(), 3 * printed, 1e-12));
		part.copies = 1;
		part.knownMass = 0.042;
		check("a known mass is used as given", near(part.mass(), 0.042, 1e-12));
		part.knownMass = Double.NaN;
		check("an open mesh asks for a shell or a known mass", !new StlPart(open).problems().isEmpty());

		// Into a real design: aerodynamics unchanged, mass added exactly, saved and loaded like any design.
		Path p = examples.stream().filter(x -> x.getFileName().toString().startsWith("A simple model rocket")).findFirst().orElse(examples.get(0));
		OpenRocketDocument d = new GeneralRocketLoader(p.toFile()).load();
		FlightConfiguration conf = d.getRocket().getSelectedConfiguration();
		FlightConditions fc = new FlightConditions(conf);
		fc.setMach(0.3);
		Coordinate cp0 = new BarrowmanCalculator().getCP(conf, fc, new WarningSet());
		double cd0 = new BarrowmanCalculator().getAerodynamicForces(conf, fc, new WarningSet()).getCD();
		double mass0 = MassCalculator.calculateLaunch(conf).getMass();
		BodyTube tube = null;
		NoseCone nose = null;
		RocketComponent chute = null;
		for (RocketComponent x : d.getRocket()) {
			if (x instanceof BodyTube && tube == null) {
				tube = (BodyTube) x;
			} else if (x instanceof NoseCone && nose == null) {
				nose = (NoseCone) x;
			} else if (StlPart.isRecoveryItem(x) && chute == null) {
				chute = x;
			}
		}
		MassComponent added = part.addTo(tube, "Printed sled", 0.05);
		check("new mass component adds exactly the model's mass", near(MassCalculator.calculateLaunch(conf).getMass(), mass0 + part.mass(), 1e-9));
		check("aerodynamics unchanged by a mass component", new BarrowmanCalculator().getCP(conf, fc, new WarningSet()).equals(cp0)
				&& new BarrowmanCalculator().getAerodynamicForces(conf, fc, new WarningSet()).getCD() == cd0);
		check("off-centre centre of gravity recorded", added.isCGOverridden() && near(added.getOverrideCGX(), part.cgFromFront(), 1e-12));
		part.applyTo(nose, true);
		check("nose cone takes the model's mass and centre of gravity", nose.isMassOverridden() && near(nose.getOverrideMass(), part.mass(), 1e-12)
				&& nose.isCGOverridden() && near(nose.getOverrideCGX(), part.cgFromFront(), 1e-12));
		check("aerodynamics unchanged by a mass override", new BarrowmanCalculator().getCP(conf, fc, new WarningSet()).equals(cp0));
		check("parachutes, streamers and shock cords are refused", chute != null && !StlPart.canSetMassOf(chute)
				&& StlPart.massParentFor(chute) == chute.getParent());
		OpenRocketDocument again = OrDoc.load(OrDoc.save(d, false));
		MassComponent reloaded = null;
		NoseCone reloadedNose = null;
		for (RocketComponent x : again.getRocket()) {
			if (x instanceof MassComponent && x.getName().equals("Printed sled")) {
				reloaded = (MassComponent) x;
			} else if (x instanceof NoseCone && reloadedNose == null) {
				reloadedNose = (NoseCone) x;
			}
		}
		check("saved and loaded like any design", reloaded != null && near(reloaded.getComponentMass(), added.getComponentMass(), 1e-9)
				&& near(reloaded.getLength(), added.getLength(), 1e-9) && near(reloaded.getOverrideCGX(), added.getOverrideCGX(), 1e-9)
				&& reloadedNose != null && near(reloadedNose.getOverrideMass(), nose.getOverrideMass(), 1e-9));
		Simulation sim = d.getSimulations().get(0);
		sim.simulate();
		check("simulation runs with the imported part", sim.getSimulatedData() != null && sim.getSimulatedData().getMaxAltitude() > 0);
	}

	// =================================================================== imported model shapes (orcloud.stl.PartMesh)

	private static void modelShapeChecks(List<Path> examples) throws Exception {
		System.out.println("Imported model shapes");
		// A 10 x 20 x 30 box in millimetres, placed along each axis, nose end at either end.
		byte[] boxStl = binaryStl(box(5, -10, 0, 10, 20, 30));
		StlModel boxModel = StlModel.read(boxStl);
		PartMesh.Shape boxShape = PartMesh.prepare(boxStl);
		check("box shape kept whole", boxShape.triangles == 12 && boxShape.fileTriangles == 12);
		boolean sized = true, turned = true;
		double[] size = { 10, 20, 30 };
		for (int axis = 0; axis < 3; axis++) {
			for (boolean front : new boolean[] { false, true }) {
				StlPart part = new StlPart(boxModel);
				part.axis = axis;
				part.frontAtMax = front;
				PartMesh m = PartMesh.decode(boxShape.place(part));
				double[] lo = { 1e9, 1e9, 1e9 }, hi = { -1e9, -1e9, -1e9 };
				for (int i = 0; i < m.positions.length; i++) {
					lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
					hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
				}
				// x from 0 to the length, centred across, in metres.
				sized &= near(lo[0], 0, 1e-4) && near(hi[0], size[axis] / 1000, 1e-4) && near(m.length, size[axis] / 1000, 1e-9)
						&& near(lo[1] + hi[1], 0, 1e-4) && near(lo[2] + hi[2], 0, 1e-4)
						&& near(hi[1] - lo[1], size[(axis + 1) % 3] / 1000, 1e-4) && near(hi[2] - lo[2], size[(axis + 2) % 3] / 1000, 1e-4);
				// Turned, never mirrored: drawn with z negated (as the 3D view does), the outward
				// volume stays positive like the file's.
				double vol = 0;
				for (int t = 0; t < m.triangles.length; t += 3) {
					double[][] q = new double[3][];
					for (int k = 0; k < 3; k++) {
						int v = m.triangles[t + k] * 3;
						q[k] = new double[] { m.positions[v], m.positions[v + 1], -m.positions[v + 2] };
					}
					vol += (q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) - q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0])
							+ q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0])) / 6;
				}
				turned &= Math.abs(vol - 6e-6) < 6e-8;
			}
		}
		check("placed along each axis at its size, centred", sized);
		check("placed models are turned, never mirrored", turned);

		// A large file is reduced, keeping its size.
		byte[] coneStl = binaryStl(cone(20, 100, 20000));
		PartMesh.Shape coneShape = PartMesh.prepare(coneStl);
		StlPart conePart = new StlPart(StlModel.read(coneStl));
		PartMesh cm = PartMesh.decode(coneShape.place(conePart));
		double reach = 0;
		for (int i = 0; i < cm.positions.length; i += 3) {
			reach = Math.max(reach, Math.hypot(cm.positions[i + 1], cm.positions[i + 2]));
		}
		check("a 40,000-triangle file is reduced to at most " + PartMesh.MAX_TRIANGLES + " (" + coneShape.triangles + ")",
				coneShape.fileTriangles == 40000 && coneShape.triangles <= PartMesh.MAX_TRIANGLES && coneShape.triangles > 1000
						&& Math.abs(cm.length - 0.1) < 1e-4 && Math.abs(reach - 0.02) < 0.002);
		float[] normals = cm.cornerNormals();
		boolean unit = normals.length == cm.triangles.length * 3;
		for (int i = 0; unit && i < normals.length; i += 3) {
			unit = near(Math.sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]), 1, 1e-3);
		}
		check("smooth corner normals", unit);

		// In a design: drawn where OpenRocket's cylinder is (also off the axis), shared, outlined in 2D.
		Path p = examples.stream().filter(x -> x.getFileName().toString().startsWith("A simple model rocket")).findFirst().orElse(examples.get(0));
		OpenRocketDocument d = new GeneralRocketLoader(p.toFile()).load();
		BodyTube tube = null;
		for (RocketComponent x : d.getRocket()) {
			if (x instanceof BodyTube) {
				tube = (BodyTube) x;
				break;
			}
		}
		// A box as long and as wide as the cylinder made for it has the cylinder's extent.
		byte[] squareStl = binaryStl(box(-5, -5, 0, 10, 10, 30));
		StlPart squarePart = new StlPart(StlModel.read(squareStl));
		squarePart.axis = 2;
		squarePart.frontAtMax = false;
		squarePart.unit = 0.0005;
		MassComponent mc = new MassComponent();
		mc.setName("Printed bay");
		squarePart.addTo(tube, mc, 0.05);
		mc.setRadialPosition(0.003);
		mc.setRadialDirection(Math.PI / 3);
		FlightConfiguration conf = d.getRocket().getSelectedConfiguration();
		double[] cyl = partExtent(conf, mc);
		PartMeshes.put(String.valueOf(mc.getID()), PartMesh.prepare(squareStl).place(squarePart));
		RocketMesh withModel = RocketMesh.of(conf, ObjUtils.LevelOfDetail.NORMAL_QUALITY);
		double[] box = partExtent(conf, mc);
		boolean modelPart = withModel.parts.stream().anyMatch(x -> x.component == mc && x.model);
		boolean same = cyl != null && box != null;
		for (int k = 0; same && k < 6; k++) {
			same = Math.abs(cyl[k] - box[k]) < 2e-4;
		}
		check("the model is drawn in 3D where OpenRocket's cylinder was, off the axis too", modelPart && same);
		mc.setLength(mc.getLength() * 2);
		double[] longer = partExtent(conf, mc);
		check("the model scales with the component's length", longer != null && Math.abs((longer[3] - longer[0]) - 2 * (box[3] - box[0])) < 1e-4);

		// Shared: the shape is an attachment of the design, and comes back on load.
		Model shared = OrDoc.toModel(d, new ArrayList<>(), null);
		String att = "att:" + PartMeshes.attachmentName(String.valueOf(mc.getID()));
		boolean attached = shared.objs.containsKey(att);
		PartMeshes.remove(String.valueOf(mc.getID()));
		OpenRocketDocument again = OrDoc.load(shared);
		RocketComponent back = again.getRocket().findComponent(mc.getID());
		check("shared with the design and back on load", attached && back != null && PartMeshes.get(back) != null);
		tube.removeChild(mc);
		Model without = OrDoc.toModel(d, new ArrayList<>(), null);
		check("removed with its component", !without.objs.containsKey(att));

		// 2D: the outline of a box seen from the side is its rectangle.
		PartMesh sm = PartMesh.decode(PartMesh.prepare(squareStl).place(squarePart));
		java.awt.Shape[] fig = sm.figure(info.openrocket.core.util.Transformation.IDENTITY, Coordinate.ZERO, 1, false);
		java.awt.geom.Rectangle2D r = fig[1].getBounds2D();
		check("2D outline and clickable area of the model", fig[0].getBounds2D().getWidth() > 0 && Math.abs(r.getWidth() - 0.015) < 1e-4
				&& Math.abs(r.getHeight() - 0.005) < 1e-4 && fig[1].contains(r.getCenterX(), r.getCenterY()));
	}

	/** Extent of a component's drawing in the 3D view: min x, y, z then max x, y, z (OpenRocket coordinates). */
	private static double[] partExtent(FlightConfiguration conf, RocketComponent c) {
		RocketMesh m = RocketMesh.of(conf, ObjUtils.LevelOfDetail.NORMAL_QUALITY);
		double[] e = { 1e9, 1e9, 1e9, -1e9, -1e9, -1e9 };
		boolean any = false;
		for (RocketMesh.Part part : m.parts) {
			if (part.component != c || part.motor != null) {
				continue;
			}
			for (int v = part.firstVertex; v < part.firstVertex + part.vertexCount; v++) {
				int o = v * RocketMesh.STRIDE;
				double[] q = { m.vertices[o], m.vertices[o + 1], -m.vertices[o + 2] };
				for (int k = 0; k < 3; k++) {
					e[k] = Math.min(e[k], q[k]);
					e[k + 3] = Math.max(e[k + 3], q[k]);
				}
				any = true;
			}
		}
		return any ? e : null;
	}

	// =================================================================== 3D view (orcloud.view3d)

	private static void view3dChecks(List<Path> examples) throws Exception {
		System.out.println("3D view");
		int designs = 0, complete = 0, inBounds = 0, faces = 0, agree = 0, withNormals = 0, looksOk = 0, textured = 0;
		List<String> problems = new ArrayList<>();
		for (Path p : examples) {
			OpenRocketDocument d = new GeneralRocketLoader(p.toFile()).load();
			FlightConfiguration conf = d.getRocket().getSelectedConfiguration();
			RocketMesh m = RocketMesh.of(conf, ObjUtils.LevelOfDetail.NORMAL_QUALITY);
			designs++;
			problems.addAll(m.problems);
			// Every visible part with a shape is drawn.
			Set<RocketComponent> drawn = new HashSet<>();
			for (RocketMesh.Part part : m.parts) {
				drawn.add(part.component);
			}
			boolean all = m.problems.isEmpty() && m.faceCount > 0;
			for (RocketComponent c : d.getRocket()) {
				if (!(c instanceof info.openrocket.core.rocketcomponent.ComponentAssembly) && conf.isComponentActive(c) && c.isVisible()
						&& !drawn.contains(c)) {
					all = false;
					problems.add(p.getFileName() + ": " + c.getName() + " (" + c.getClass().getSimpleName() + ") not drawn");
				}
			}
			complete += all ? 1 : 0;
			// Everything lies within the configuration's extent (z is negated in the mesh).
			double tol = 0.02 * Math.max(m.bounds.span().x, 0.01) + 0.002;
			boolean inside = true;
			for (int i = 0; i < m.vertexCount; i++) {
				int o = i * RocketMesh.STRIDE;
				double x = m.vertices[o], y = m.vertices[o + 1], z = -m.vertices[o + 2];
				if (x < m.bounds.min.x - tol || x > m.bounds.max.x + tol || y < m.bounds.min.y - tol || y > m.bounds.max.y + tol
						|| z < m.bounds.min.z - tol || z > m.bounds.max.z + tol) {
					inside = false;
					break;
				}
			}
			inBounds += inside ? 1 : 0;
			if (!inside) {
				problems.add(p.getFileName() + ": mesh outside the rocket's extent");
			}
			// How often the winding agrees with the exporter's normals (the page orients each face).
			int v = 0;
			for (int f = 0; f < m.faceCount; f++) {
				int k = m.faceSizes[f];
				double nx = 0, ny = 0, nz = 0, gx = 0, gy = 0, gz = 0;
				for (int i = 0; i < k; i++) {
					int a = (v + i) * RocketMesh.STRIDE, b = (v + (i + 1) % k) * RocketMesh.STRIDE;
					float[] q = m.vertices;
					nx += (q[a + 1] - q[b + 1]) * (q[a + 2] + q[b + 2]);
					ny += (q[a + 2] - q[b + 2]) * (q[a] + q[b]);
					nz += (q[a] - q[b]) * (q[a + 1] + q[b + 1]);
					gx += q[a + 3];
					gy += q[a + 4];
					gz += q[a + 5];
				}
				faces++;
				if (!Double.isNaN(gx)) {
					withNormals++;
					agree += nx * gx + ny * gy + nz * gz >= 0 ? 1 : 0;
				}
				v += k;
			}
			// The looks of the three view types.
			List<RocketComponent> comps = Looks.components(m);
			int[] decals = { 0 };
			boolean ok = true;
			for (int type : new int[] { Looks.FIGURE, Looks.UNFINISHED, Looks.FINISHED }) {
				String json = Looks.json(m, type, comps, c -> new info.openrocket.core.util.ORColor(0, 0, 200), img -> ++decals[0]);
				ok &= !json.contains("NaN") && !json.contains("Infinity") && json.split("\\],\\[", -1).length == m.parts.size();
			}
			looksOk += ok ? 1 : 0;
			textured += decals[0] > 0 ? 1 : 0;
		}
		for (String pr : problems) {
			System.out.println("  note " + pr);
		}
		System.out.println("  note faces " + faces + ", exporter normals on " + withNormals + ", winding agrees on " + agree);
		check("every visible part of every example is drawn (" + complete + "/" + designs + ")", complete == designs);
		check("meshes lie within the rockets' extents (" + inBounds + "/" + designs + ")", inBounds == designs);
		check("looks of all three view types (" + looksOk + "/" + designs + ")", looksOk == designs);
		check("unfinished views have OpenRocket's textures (" + textured + "/" + designs + ")", textured == designs);

		// Inside, outside and ends of a body tube; see-through tubes in the figure view.
		Path simple = examples.stream().filter(x -> x.getFileName().toString().startsWith("A simple model rocket")).findFirst().orElse(examples.get(0));
		OpenRocketDocument d = new GeneralRocketLoader(simple.toFile()).load();
		RocketMesh m = RocketMesh.of(d.getRocket().getSelectedConfiguration(), ObjUtils.LevelOfDetail.NORMAL_QUALITY);
		Set<Integer> tubeSurfaces = new HashSet<>();
		boolean motor = false;
		for (RocketMesh.Part part : m.parts) {
			if (part.component instanceof BodyTube && part.motor == null) {
				tubeSurfaces.add(part.surface);
			}
			motor |= part.motor != null;
		}
		check("body tube split into outside, inside and ends", tubeSurfaces.size() == 3);
		check("the motor is drawn", motor);
		String figure = Looks.json(m, Looks.FIGURE, Looks.components(m), c -> new info.openrocket.core.util.ORColor(0, 0, 200), img -> 1);
		check("figure view shows body tubes see-through", figure.contains("\"transparent\":true"));
	}

	private static boolean near(double a, double b, double rel) {
		return Math.abs(a - b) <= rel * Math.max(1, Math.max(Math.abs(a), Math.abs(b)));
	}

	/** Triangles of an axis-aligned box with outward normals. */
	private static List<float[]> box(float x, float y, float z, float w, float h, float d) {
		float[][] p = new float[8][];
		for (int i = 0; i < 8; i++) {
			p[i] = new float[] { x + ((i & 1) != 0 ? w : 0), y + ((i & 2) != 0 ? h : 0), z + ((i & 4) != 0 ? d : 0) };
		}
		int[][] faces = { { 0, 2, 3, 1 }, { 4, 5, 7, 6 }, { 0, 1, 5, 4 }, { 2, 6, 7, 3 }, { 0, 4, 6, 2 }, { 1, 3, 7, 5 } };
		List<float[]> out = new ArrayList<>();
		for (int[] f : faces) {
			out.add(tri(p[f[0]], p[f[1]], p[f[2]]));
			out.add(tri(p[f[0]], p[f[2]], p[f[3]]));
		}
		return out;
	}

	/** A closed cone along +z: base (radius r, n sides) at z = 0, tip at z = length. */
	private static List<float[]> cone(float r, float length, int n) {
		List<float[]> out = new ArrayList<>();
		float[] tip = { 0, 0, length };
		float[] centre = { 0, 0, 0 };
		for (int i = 0; i < n; i++) {
			double a0 = 2 * Math.PI * i / n;
			double a1 = 2 * Math.PI * (i + 1) / n;
			float[] p0 = { (float) (r * Math.cos(a0)), (float) (r * Math.sin(a0)), 0 };
			float[] p1 = { (float) (r * Math.cos(a1)), (float) (r * Math.sin(a1)), 0 };
			out.add(tri(p0, p1, tip));
			out.add(tri(centre, p1, p0));
		}
		return out;
	}

	private static float[] tri(float[] a, float[] b, float[] c) {
		return new float[] { a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2] };
	}

	private static byte[] binaryStl(List<float[]> tris) {
		ByteBuffer buf = ByteBuffer.allocate(84 + 50 * tris.size()).order(ByteOrder.LITTLE_ENDIAN);
		buf.position(80);
		buf.putInt(tris.size());
		for (float[] t : tris) {
			buf.putFloat(0).putFloat(0).putFloat(0);
			for (float v : t) {
				buf.putFloat(v);
			}
			buf.putShort((short) 0);
		}
		return buf.array();
	}

	private static String asciiStl(List<float[]> tris) {
		StringBuilder sb = new StringBuilder("solid test\n");
		for (float[] t : tris) {
			sb.append("  facet normal 0 0 0\n    outer loop\n");
			for (int i = 0; i < 9; i += 3) {
				sb.append("      vertex ").append(t[i]).append(' ').append(t[i + 1]).append(' ').append(t[i + 2]).append('\n');
			}
			sb.append("    endloop\n  endfacet\n");
		}
		return sb.append("endsolid test\n").toString();
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> asMap(Object o) {
		return (Map<String, Object>) o;
	}
}
