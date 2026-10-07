package orcloud.bridge;

import java.awt.Dialog;
import java.awt.Window;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Set;
import java.util.TreeSet;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.prefs.Preferences;

import javax.swing.tree.TreePath;
import javax.swing.tree.TreeSelectionModel;

import info.openrocket.core.arch.SystemInfo;
import info.openrocket.core.appearance.Appearance;
import info.openrocket.core.appearance.DecalImage;
import info.openrocket.core.document.OpenRocketDocument;
import info.openrocket.core.document.Simulation;
import info.openrocket.core.document.StorageOptions;
import info.openrocket.core.file.GeneralRocketLoader;
import info.openrocket.core.file.openrocket.OpenRocketSaver;
import info.openrocket.core.logging.ErrorSet;
import info.openrocket.core.logging.WarningSet;
import info.openrocket.core.motor.MotorConfiguration;
import info.openrocket.core.rocketcomponent.FreeformFinSet;
import info.openrocket.core.rocketcomponent.InsideColorComponent;
import info.openrocket.core.rocketcomponent.MotorMount;
import info.openrocket.core.rocketcomponent.Rocket;
import info.openrocket.core.rocketcomponent.RocketComponent;
import info.openrocket.core.util.Coordinate;
import info.openrocket.core.simulation.FlightData;
import info.openrocket.core.simulation.customexpression.CustomExpression;
import info.openrocket.core.startup.jij.ClasspathUrlStreamHandler;
import info.openrocket.core.startup.jij.ConfigurableStreamHandlerFactory;
import info.openrocket.core.util.BuildProperties;
import info.openrocket.swing.gui.main.BasicFrame;
import info.openrocket.swing.gui.main.componenttree.ComponentTreeModel;

/**
 * Everything that touches OpenRocket internals lives here. The application itself runs
 * unmodified; the bridge only uses its public API plus a few read-only reflective lookups
 * (and the loader's own property setters, so remote edits are applied exactly the way a
 * file load would apply them).
 */
final class OrDoc {
	private OrDoc() {
	}

	// ------------------------------------------------------------------ startup

	static void installClasspathUrlHandler() {
		// Same as info.openrocket.swing.startup.OpenRocket.main does before starting up.
		ConfigurableStreamHandlerFactory factory = new ConfigurableStreamHandlerFactory();
		factory.addHandler("classpath", new ClasspathUrlStreamHandler());
		URL.setURLStreamHandlerFactory(factory);
	}

	/** Folder for the design's custom motor files (written fresh each session, see Bridge). */
	static Path motorDir() {
		return Path.of(System.getProperty("java.io.tmpdir"), "orcloud-motors");
	}

	/**
	 * Startup prompts that make no sense in a hosted session (update check, welcome notes), and
	 * the session's custom motor folder added to OpenRocket's user thrust-curve folders.
	 */
	static void configurePreferences(Path workDir) {
		Preferences node = Preferences.userRoot().node("OpenRocket");
		node.putBoolean("CheckUpdates", false);
		node.putBoolean("IgnoreWelcome_" + BuildProperties.getVersion(), true);
		node.put("defaultDirectory", workDir.toString());
		// Same format as ApplicationPreferences.setUserThrustCurveFiles ("|"-separated paths;
		// unset means just the default ~/.openrocket/ThrustCurves folder).
		String current = node.get("UserThrustCurves", null);
		List<String> dirs = new ArrayList<>();
		if (current == null) {
			File def = new File(SystemInfo.getUserApplicationDirectory(), "ThrustCurves");
			def.mkdirs();
			dirs.add(def.getAbsolutePath());
		} else {
			for (String d : current.split("\\|")) {
				if (!d.isBlank()) {
					dirs.add(d.trim());
				}
			}
		}
		if (!dirs.contains(motorDir().toString())) {
			dirs.add(motorDir().toString());
			node.put("UserThrustCurves", String.join("|", dirs));
		}
		try {
			node.flush();
		} catch (Exception e) {
			Log.warn("Could not flush preferences: " + e);
		}
	}

	// ------------------------------------------------------------------ save / load

	static String save(OpenRocketDocument doc, boolean withSimulationData) throws Exception {
		StorageOptions opts = new StorageOptions();
		opts.setFileType(StorageOptions.FileType.OPENROCKET);
		opts.setSaveSimulationData(withSimulationData);
		ByteArrayOutputStream out = new ByteArrayOutputStream(64 * 1024);
		new OpenRocketSaver().save(out, doc, opts, new WarningSet(), new ErrorSet());
		return out.toString(StandardCharsets.UTF_8);
	}

	static OpenRocketDocument load(String xml) throws Exception {
		GeneralRocketLoader loader = new GeneralRocketLoader(new File("liveshare.ork"));
		return loader.load(new ByteArrayInputStream(xml.getBytes(StandardCharsets.UTF_8)), "liveshare");
	}

	private static Path attachmentDir;

	/**
	 * Loads a shared model. Decal images are served from a content-addressed zip on disk,
	 * because OpenRocket reads decals lazily from the container file it was loaded from.
	 */
	static OpenRocketDocument load(Model m) throws Exception {
		Map<String, byte[]> atts = m.attachments();
		if (atts.isEmpty()) {
			return load(m.toXml());
		}
		Path zip = attachmentZip(atts);
		ByteArrayOutputStream mem = new ByteArrayOutputStream();
		try (ZipOutputStream z = new ZipOutputStream(mem)) {
			z.putNextEntry(new ZipEntry("rocket.ork"));
			z.write(m.toXml().getBytes(StandardCharsets.UTF_8));
			z.closeEntry();
		}
		return new GeneralRocketLoader(zip.toFile()).load(new ByteArrayInputStream(mem.toByteArray()), "liveshare");
	}

	private static synchronized Path attachmentZip(Map<String, byte[]> atts) throws Exception {
		MessageDigest md = MessageDigest.getInstance("SHA-256");
		for (Map.Entry<String, byte[]> e : atts.entrySet()) {
			md.update(e.getKey().getBytes(StandardCharsets.UTF_8));
			md.update((byte) 0);
			md.update(e.getValue());
		}
		String key = HexFormat.of().formatHex(md.digest()).substring(0, 32);
		if (attachmentDir == null) {
			attachmentDir = Files.createTempDirectory("liveshare-att");
		}
		Path zip = attachmentDir.resolve(key + ".zip");
		if (!Files.exists(zip)) {
			Path tmp = attachmentDir.resolve(key + ".tmp");
			try (ZipOutputStream z = new ZipOutputStream(Files.newOutputStream(tmp))) {
				for (Map.Entry<String, byte[]> e : atts.entrySet()) {
					z.putNextEntry(new ZipEntry(e.getKey()));
					z.write(e.getValue());
					z.closeEntry();
				}
			}
			Files.move(tmp, zip, StandardCopyOption.ATOMIC_MOVE);
		}
		return zip;
	}

	/** Writes the shared model as an .ork file (zip container when it has decals). */
	static void writeOrk(Model m, Path file) throws Exception {
		Map<String, byte[]> atts = m.attachments();
		if (atts.isEmpty()) {
			Files.writeString(file, m.toXml(), StandardCharsets.UTF_8);
			return;
		}
		try (ZipOutputStream z = new ZipOutputStream(Files.newOutputStream(file))) {
			z.putNextEntry(new ZipEntry("rocket.ork"));
			z.write(m.toXml().getBytes(StandardCharsets.UTF_8));
			z.closeEntry();
			for (Map.Entry<String, byte[]> e : atts.entrySet()) {
				z.putNextEntry(new ZipEntry(e.getKey()));
				z.write(e.getValue());
				z.closeEntry();
			}
		}
	}

	/**
	 * Document -> shared model (without simulation flight data). Decals used by the rocket
	 * are added as attachments; {@code decalCache} avoids re-reading unchanged images.
	 */
	static Model toModel(OpenRocketDocument doc, List<String> simIds, Map<DecalImage, String> decalCache) throws Exception {
		Model m = Model.fromXml(Xml.parse(save(doc, false)), simIds);
		Set<DecalImage> used = new TreeSet<>();
		for (RocketComponent c : doc.getRocket()) {
			addDecal(used, c.getAppearance());
			if (c instanceof InsideColorComponent) {
				addDecal(used, ((InsideColorComponent) c).getInsideColorComponentHandler().getInsideAppearance());
			}
		}
		if (decalCache != null) {
			decalCache.keySet().retainAll(used);
		}
		int pos = 1000;
		for (DecalImage img : used) {
			String data = decalCache == null ? null : decalCache.get(img);
			if (data == null) {
				try (InputStream in = img.getBytes()) {
					data = Base64.getEncoder().encodeToString(in.readAllBytes());
				} catch (Exception e) {
					Log.warn("Decal " + img.getName() + " unavailable: " + e);
					continue;
				}
				if (decalCache != null) {
					decalCache.put(img, data);
				}
			}
			Model.Obj a = new Model.Obj(Model.ATT, Model.DOC, pos++);
			a.v.put(Model.ATTRS, "");
			a.k.add("data");
			a.v.put("data", data);
			m.objs.put("att:" + img.getName(), a);
		}
		return m;
	}

	private static void addDecal(Set<DecalImage> used, Appearance ap) {
		if (ap != null && ap.getTexture() != null && ap.getTexture().getImage() != null) {
			used.add(ap.getTexture().getImage());
		}
	}

	/**
	 * {@link info.openrocket.core.rocketcomponent.Rocket#loadFrom} copies components, and a
	 * few values do not survive OpenRocket's copy (it affects its own undo too). Restore them
	 * from the freshly loaded rocket so the result equals a file load.
	 */
	static void fixupAfterLoadFrom(Rocket live, Rocket loaded) {
		for (RocketComponent c : live) {
			RocketComponent src = loaded.findComponent(c.getID());
			if (src == null || src.getClass() != c.getClass()) {
				continue;
			}
			if (c instanceof MotorMount) {
				MotorConfiguration dst = ((MotorMount) c).getDefaultMotorConfig();
				MotorConfiguration from = ((MotorMount) src).getDefaultMotorConfig();
				if (dst.getIgnitionEvent() != from.getIgnitionEvent()) {
					dst.setIgnitionEvent(from.getIgnitionEvent());
				}
				if (dst.getIgnitionDelay() != from.getIgnitionDelay()) {
					dst.setIgnitionDelay(from.getIgnitionDelay());
				}
			}
			if (c instanceof FreeformFinSet) {
				Coordinate[] want = ((FreeformFinSet) src).getFinPoints();
				if (!Arrays.equals(want, ((FreeformFinSet) c).getFinPoints())) {
					((FreeformFinSet) c).setPoints(want);
				}
			}
		}
	}

	// ------------------------------------------------------------------ in-place property updates

	private static Map<String, Object> setters;
	private static Method setterSet;

	@SuppressWarnings("unchecked")
	private static synchronized void initSetters() throws Exception {
		if (setters != null) {
			return;
		}
		Class<?> config = Class.forName("info.openrocket.core.file.openrocket.importt.DocumentConfig");
		Field f = config.getDeclaredField("setters");
		f.setAccessible(true);
		Class<?> setter = Class.forName("info.openrocket.core.file.openrocket.importt.Setter");
		Method m = setter.getMethod("set", RocketComponent.class, String.class, HashMap.class, WarningSet.class);
		m.setAccessible(true);
		setterSet = m;
		setters = (Map<String, Object>) f.get(null);
	}

	/**
	 * Applies one leaf element (e.g. {@code <length>0.3</length>}) to a live component using
	 * the same setter the .ork loader uses. Returns false if there is no such setter.
	 */
	static boolean applyLeaf(RocketComponent c, Xml.El el) throws Exception {
		initSetters();
		for (Class<?> k = c.getClass(); k != null; k = k.getSuperclass()) {
			String key = k.getSimpleName() + ":" + el.tag;
			if (setters.containsKey(key)) {
				Object s = setters.get(key);
				if (s == null) {
					return false;
				}
				c.setIgnorePresetClearing(true);
				try {
					setterSet.invoke(s, c, el.text(), new HashMap<>(el.attrs), new WarningSet());
				} finally {
					c.setIgnorePresetClearing(false);
				}
				return true;
			}
		}
		return false;
	}

	/**
	 * Applies leaf properties {id, key, xml} in each component's property order (as the file
	 * loader would). Returns false if any of them cannot be applied in place.
	 */
	static boolean applyLeaves(OpenRocketDocument doc, Model target, List<String[]> leaves) {
		List<String[]> sorted = new ArrayList<>(leaves);
		sorted.sort((a, b) -> {
			int c = a[0].compareTo(b[0]);
			if (c != 0) {
				return c;
			}
			List<String> k = target.get(a[0]).k;
			return Integer.compare(k.indexOf(a[1]), k.indexOf(b[1]));
		});
		try {
			for (String[] leaf : sorted) {
				RocketComponent c = findComponent(doc, leaf[0]);
				if (c == null || !applyLeaf(c, Xml.parse(leaf[2]))) {
					return false;
				}
			}
			return true;
		} catch (Exception e) {
			Log.warn("In-place update failed: " + e);
			return false;
		}
	}

	static RocketComponent findComponent(OpenRocketDocument doc, String id) {
		try {
			return doc.getRocket().findComponent(UUID.fromString(id));
		} catch (IllegalArgumentException e) {
			return null;
		}
	}

	// ------------------------------------------------------------------ simulations

	/** Builds a live simulation from one loaded from XML, the way the .ork loader does. */
	static Simulation adoptSimulation(OpenRocketDocument live, Simulation loaded, String statusAttr) {
		FlightData data = loaded.getSimulatedData();
		Simulation.Status status;
		if (data == null) {
			status = Simulation.Status.NOT_SIMULATED;
		} else if ("outdated".equals(statusAttr)) {
			status = Simulation.Status.OUTDATED;
		} else {
			status = Simulation.Status.LOADED;
		}
		Simulation s = new Simulation(live, live.getRocket(), status, loaded.getName(),
				loaded.getOptions().clone(), new ArrayList<>(loaded.getSimulationExtensions()), data);
		if (loaded.getFlightConfigurationId() != null && !loaded.getFlightConfigurationId().hasError()) {
			s.setFlightConfigurationId(loaded.getFlightConfigurationId());
		}
		return s;
	}

	/** Status as stored in the shared model; "loaded" and "uptodate" mean the same thing there. */
	static String statusAttr(Simulation s) {
		Simulation.Status st = s.getStatus();
		if (st == Simulation.Status.LOADED || st == Simulation.Status.EXTERNAL) {
			st = Simulation.Status.UPTODATE;
		}
		return OpenRocketSaver.enumToXMLName(st);
	}

	// ------------------------------------------------------------------ document-level elements

	static void copyCustomExpressions(OpenRocketDocument from, OpenRocketDocument to) {
		for (CustomExpression e : new ArrayList<>(to.getCustomExpressions())) {
			to.removeCustomExpression(e);
		}
		for (CustomExpression e : from.getCustomExpressions()) {
			to.addCustomExpression(new CustomExpression(to, e.getName(), e.getSymbol(), e.getUnit(), e.getExpressionString()));
		}
	}

	static void copyPhotoSettings(OpenRocketDocument from, OpenRocketDocument to) {
		Map<String, String> src = from.getPhotoSettings();
		Map<String, String> dst = to.getPhotoSettings();
		if (dst != null && src != null) {
			dst.clear();
			dst.putAll(src);
		} else {
			to.setPhotoSettings(src == null ? null : new HashMap<>(src));
		}
	}

	@SuppressWarnings("unchecked")
	static void copyDocumentPreferences(OpenRocketDocument from, OpenRocketDocument to) throws Exception {
		Field f = from.getDocumentPreferences().getClass().getDeclaredField("preferencesMap");
		f.setAccessible(true);
		Map<String, Object> dst = (Map<String, Object>) f.get(to.getDocumentPreferences());
		dst.clear();
		dst.putAll((Map<String, Object>) f.get(from.getDocumentPreferences()));
		to.reloadDocumentMaterials();
	}

	// ------------------------------------------------------------------ frame / undo introspection

	static OpenRocketDocument documentOf(BasicFrame frame) throws Exception {
		Field f = BasicFrame.class.getDeclaredField("document");
		f.setAccessible(true);
		return (OpenRocketDocument) f.get(frame);
	}

	static BasicFrame findFrame(File file) {
		for (BasicFrame f : new ArrayList<>(BasicFrame.getAllFrames())) {
			try {
				File df = documentOf(f).getFile();
				if (df != null && df.getAbsoluteFile().equals(file.getAbsoluteFile())) {
					return f;
				}
			} catch (Exception e) {
				Log.warn("Frame lookup failed: " + e);
			}
		}
		return null;
	}

	static RocketComponent selectedComponent(BasicFrame frame) {
		try {
			Field f = BasicFrame.class.getDeclaredField("componentSelectionModel");
			f.setAccessible(true);
			TreePath path = ((TreeSelectionModel) f.get(frame)).getSelectionPath();
			Object last = path == null ? null : path.getLastPathComponent();
			return last instanceof RocketComponent ? (RocketComponent) last : null;
		} catch (Exception e) {
			return null;
		}
	}

	static List<String> selectedIds(BasicFrame frame) {
		List<String> ids = new ArrayList<>();
		try {
			Field f = BasicFrame.class.getDeclaredField("componentSelectionModel");
			f.setAccessible(true);
			TreePath[] paths = ((TreeSelectionModel) f.get(frame)).getSelectionPaths();
			if (paths != null) {
				for (TreePath p : paths) {
					if (p.getLastPathComponent() instanceof RocketComponent) {
						ids.add(((RocketComponent) p.getLastPathComponent()).getID().toString());
					}
				}
			}
		} catch (Exception e) {
			// selection is cosmetic
		}
		return ids;
	}

	static void select(BasicFrame frame, OpenRocketDocument doc, List<String> ids) {
		try {
			Field f = BasicFrame.class.getDeclaredField("componentSelectionModel");
			f.setAccessible(true);
			TreeSelectionModel model = (TreeSelectionModel) f.get(frame);
			List<TreePath> paths = new ArrayList<>();
			for (String id : ids) {
				RocketComponent c = findComponent(doc, id);
				if (c != null) {
					paths.add(ComponentTreeModel.makeTreePath(c));
				}
			}
			if (!paths.isEmpty()) {
				model.setSelectionPaths(paths.toArray(new TreePath[0]));
			}
		} catch (Exception e) {
			// selection is cosmetic
		}
	}

	@SuppressWarnings("unchecked")
	static List<Object> undoHistory(OpenRocketDocument doc) {
		try {
			Field f = OpenRocketDocument.class.getDeclaredField("undoHistory");
			f.setAccessible(true);
			return new ArrayList<>((List<Object>) f.get(doc));
		} catch (Exception e) {
			return new ArrayList<>();
		}
	}

	static Object currentUndoState(OpenRocketDocument doc) {
		try {
			Field f = OpenRocketDocument.class.getDeclaredField("undoPosition");
			f.setAccessible(true);
			int pos = f.getInt(doc);
			List<Object> h = undoHistory(doc);
			return pos >= 0 && pos < h.size() ? h.get(pos) : null;
		} catch (Exception e) {
			return null;
		}
	}

	static boolean modalDialogOpen() {
		for (Window w : Window.getWindows()) {
			if (w.isShowing() && w instanceof Dialog && ((Dialog) w).isModal()) {
				return true;
			}
		}
		return false;
	}
}
