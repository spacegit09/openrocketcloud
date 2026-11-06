package orcloud.stl;

import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;

import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.RocketComponent;

/**
 * The shapes of imported 3D models, by the id of the mass component they belong to. They travel
 * with the design as attachments named {@code models/<component id>.orcm}, next to its decal images:
 * the live-share bridge adds them to the shared design and registers the ones it receives, so they
 * are saved, shared with collaborators and included in downloaded .ork files (desktop OpenRocket
 * ignores them and shows the usual cylinder). A component without one is drawn as before.
 *
 * Shapes set here by this user's own edits ({@link #put}, {@link #remove}, {@link #copied}) also
 * follow OpenRocket's undo and redo ({@link PartMeshUndo}); shapes received from collaborators
 * ({@link #adopt}, {@link #drop}) are left to the bridge.
 */
public final class PartMeshes {
	public static final String FOLDER = "models/";
	private static final String SUFFIX = ".orcm";
	private static final Object FAILED = new Object();
	private static final Map<String, String> data = new ConcurrentHashMap<>(); // component id -> base64
	private static final Map<String, Object> decoded = new ConcurrentHashMap<>();
	private static final Set<String> local = ConcurrentHashMap.newKeySet(); // ids changed by this user's edits
	private static final List<Runnable> beforeLocalChange = new CopyOnWriteArrayList<>();

	private PartMeshes() {
	}

	public static String attachmentName(String componentId) {
		return FOLDER + componentId + SUFFIX;
	}

	/** The component id of a model attachment, or null for other attachments. */
	public static String componentId(String attachmentName) {
		if (attachmentName.startsWith(FOLDER) && attachmentName.endsWith(SUFFIX)
				&& attachmentName.length() > FOLDER.length() + SUFFIX.length()) {
			return attachmentName.substring(FOLDER.length(), attachmentName.length() - SUFFIX.length());
		}
		return null;
	}

	/** Runs before each change made by this user's edits (see {@link PartMeshUndo}). */
	public static void beforeLocalChange(Runnable r) {
		beforeLocalChange.add(r);
	}

	private static void localChange(String componentId) {
		for (Runnable r : beforeLocalChange) {
			r.run();
		}
		local.add(componentId);
	}

	/** Gives the component a model's shape (an attachment made by {@link PartMesh.Shape#place}), as this user's edit. */
	public static void put(String componentId, byte[] attachment) {
		localChange(componentId);
		set(componentId, Base64.getEncoder().encodeToString(attachment));
	}

	/** The component is drawn as OpenRocket draws it again, as this user's edit. */
	public static void remove(String componentId) {
		localChange(componentId);
		unset(componentId);
	}

	/**
	 * Copies keep the shape: `copy` was made from `original` by OpenRocket's copy(), with the same
	 * subcomponents, so shapes of mass components anywhere inside are passed on too.
	 */
	public static void copied(RocketComponent original, RocketComponent copy) {
		Iterator<RocketComponent> from = original.iterator(true), to = copy.iterator(true);
		while (from.hasNext() && to.hasNext()) {
			RocketComponent o = from.next(), c = to.next();
			String d = data.get(String.valueOf(o.getID()));
			if (d != null && o.getClass() == c.getClass()) {
				String id = String.valueOf(c.getID());
				localChange(id);
				set(id, d);
			}
		}
	}

	/** Registers a shape as stored in the shared design (base64): one received from the room. */
	public static void adopt(String componentId, String base64) {
		set(componentId, base64);
	}

	/** Forgets a shape that a collaborator removed. */
	public static void drop(String componentId) {
		unset(componentId);
	}

	private static void set(String componentId, String base64) {
		if (!base64.equals(data.put(componentId, base64))) {
			decoded.remove(componentId);
		}
	}

	private static void unset(String componentId) {
		data.remove(componentId);
		decoded.remove(componentId);
	}

	/** The component's model attachment (base64), or null. */
	public static String base64(String componentId) {
		return data.get(componentId);
	}

	/** The shapes as they are now, for {@link PartMeshUndo}. */
	static Map<String, String> snapshot() {
		return new HashMap<>(data);
	}

	/**
	 * Sets the shapes this user changed back to how they were in `snapshot` (an undo or redo).
	 *
	 * @return the ids whose shape changed
	 */
	static Set<String> restore(Map<String, String> snapshot) {
		Set<String> changed = new HashSet<>();
		for (String id : local) {
			String want = snapshot.get(id);
			if (!Objects.equals(want, data.get(id))) {
				if (want == null) {
					unset(id);
				} else {
					set(id, want);
				}
				changed.add(id);
			}
		}
		return changed;
	}

	/** The shape to draw for the component, or null to draw it as OpenRocket does. */
	public static PartMesh get(RocketComponent c) {
		if (!(c instanceof MassComponent)) {
			return null;
		}
		String id = String.valueOf(c.getID());
		String b = data.get(id);
		if (b == null) {
			return null;
		}
		Object d = decoded.computeIfAbsent(id, k -> {
			try {
				return PartMesh.decode(Base64.getDecoder().decode(b));
			} catch (Exception e) {
				return FAILED;
			}
		});
		return d instanceof PartMesh ? (PartMesh) d : null;
	}
}
