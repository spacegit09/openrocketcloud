package orcloud.stl;

import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import info.openrocket.core.rocketcomponent.MassComponent;
import info.openrocket.core.rocketcomponent.RocketComponent;

/**
 * The shapes of imported 3D models, by the id of the mass component they belong to. They travel
 * with the design as attachments named {@code models/<component id>.orcm}, next to its decal images:
 * the live-share bridge adds them to the shared design and registers the ones it receives, so they
 * are saved, shared with collaborators and included in downloaded .ork files (desktop OpenRocket
 * ignores them and shows the usual cylinder). A component without one is drawn as before.
 */
public final class PartMeshes {
	public static final String FOLDER = "models/";
	private static final String SUFFIX = ".orcm";
	private static final Object FAILED = new Object();
	private static final Map<String, String> data = new ConcurrentHashMap<>(); // component id -> base64
	private static final Map<String, Object> decoded = new ConcurrentHashMap<>();

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

	/** Gives the component a model's shape (an attachment made by {@link PartMesh.Shape#place}). */
	public static void put(String componentId, byte[] attachment) {
		putBase64(componentId, Base64.getEncoder().encodeToString(attachment));
	}

	/** Registers a model attachment as stored in the shared design (base64). */
	public static void putBase64(String componentId, String base64) {
		if (!base64.equals(data.put(componentId, base64))) {
			decoded.remove(componentId);
		}
	}

	/** The component is drawn as OpenRocket draws it again. */
	public static void remove(String componentId) {
		data.remove(componentId);
		decoded.remove(componentId);
	}

	/** The component's model attachment (base64), or null. */
	public static String base64(String componentId) {
		return data.get(componentId);
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
