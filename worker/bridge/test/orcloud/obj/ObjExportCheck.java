package orcloud.obj;

import java.io.File;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Enumeration;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.wavefrontobj.ObjUtils;
import info.openrocket.core.file.wavefrontobj.export.OBJExportOptions;
import info.openrocket.core.file.wavefrontobj.export.OBJExporterFactory;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.rocketcomponent.FinSet;
import info.openrocket.core.rocketcomponent.FlightConfiguration;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import orcloud.flight.Core;

/**
 * Exports every bundled example as a 3D file with the export dialog's "3D printing" settings
 * (Delaunay triangulation): the whole rocket at each level of detail, and each component with its
 * children at high detail; then again with root fillets of 3 mm on every fin set. With OpenRocket
 * 24.12's TriangulationHelper the pod examples fail ("Cannot project a degenerate polygon onto a 2D
 * plane"). The browser build's copies of TriangulationHelper and FinSetExporter (with FinProfiles)
 * go ahead of OpenRocket.jar here; the fillets must add faces to the fin sets' exports.
 *   java -cp browser-copies:OpenRocket.jar:classes orcloud.obj.ObjExportCheck
 */
public final class ObjExportCheck {
	private ObjExportCheck() {
	}

	public static void main(String[] args) throws Exception {
		Core.start();
		String jar = null;
		for (String p : System.getProperty("java.class.path").split(File.pathSeparator)) {
			if (p.endsWith("OpenRocket.jar")) {
				jar = p;
			}
		}
		int exports = 0;
		int finSets = 0;
		Set<String> failures = new TreeSet<>();
		File out = File.createTempFile("export", ".obj");
		try (JarFile jf = new JarFile(jar)) {
			for (Enumeration<JarEntry> en = jf.entries(); en.hasMoreElements();) {
				String name = en.nextElement().getName();
				if (!name.startsWith("datafiles/examples/") || !name.endsWith(".ork")) {
					continue;
				}
				String example = name.substring("datafiles/examples/".length(), name.length() - 4);
				Path file = Files.createTempFile("example", ".ork");
				try (InputStream in = jf.getInputStream(jf.getEntry(name))) {
					Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
				}
				for (boolean fillets : new boolean[] { false, true }) {
					OpenRocketDocument doc = new GeneralRocketLoader(file.toFile()).load();
					Rocket rocket = doc.getRocket();
					FlightConfiguration config = rocket.getSelectedConfiguration();
					if (fillets) {
						int before = faces(rocket, config, out);
						boolean any = false;
						for (RocketComponent c : rocket) {
							if (c instanceof FinSet) {
								((FinSet) c).setFilletRadius(0.003);
								any = true;
							}
						}
						if (any) {
							finSets++;
							if (faces(rocket, config, out) <= before) {
								failures.add(example + ": the fillets added no faces");
							}
						}
					}
					for (RocketComponent c : rocket) {
						for (ObjUtils.LevelOfDetail lod : ObjUtils.LevelOfDetail.values()) {
							if (!(c instanceof Rocket) && lod != ObjUtils.LevelOfDetail.HIGH_QUALITY) {
								continue;
							}
							OBJExportOptions o = new OBJExportOptions(rocket);
							o.setExportChildren(true);
							o.setExportMotors(false);
							o.setExportAppearance(false);
							o.setRemoveOffset(true);
							o.setScaling(1000);
							o.setTriangulate(true);
							o.setTriangulationMethod(ObjUtils.TriangulationMethod.DELAUNAY);
							o.setLOD(lod);
							exports++;
							try {
								new OBJExporterFactory(List.of(c), config, out, o, new WarningSet()).doExport();
							} catch (Exception e) {
								failures.add(example + (fillets ? " with fillets" : "") + " / " + c.getName() + " (" + lod + "): " + e);
							}
						}
					}
				}
				Files.delete(file);
			}
		}
		out.delete();
		for (String f : failures) {
			System.out.println("  FAIL " + f);
		}
		System.out.println(failures.isEmpty() ? "OBJCHECK PASS exports=" + exports + " (examples with fillets: " + finSets + ")"
				: "OBJCHECK FAILED: " + failures.size() + " of " + exports + " exports");
		System.exit(failures.isEmpty() ? 0 : 1);
	}

	/** The faces of the whole rocket's export (normal detail, not triangulated). */
	private static int faces(Rocket rocket, FlightConfiguration config, File out) throws Exception {
		OBJExportOptions o = new OBJExportOptions(rocket);
		o.setExportChildren(true);
		o.setExportMotors(false);
		new OBJExporterFactory(List.of(rocket), config, out, o, new WarningSet()).doExport();
		try (java.util.stream.Stream<String> lines = Files.lines(out.toPath())) {
			return (int) lines.filter(l -> l.startsWith("f ")).count();
		}
	}
}
