package orcloud.stl;

import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Consumer;

import info.openrocket.core.document.OpenRocketDocument;

/**
 * Keeps the shapes of imported 3D models in step with OpenRocket's undo and redo. OpenRocket keeps
 * its undo history as copies of the rocket, and the shapes are not part of the rocket: so each copy
 * is given the shapes as they were when it was made, and when undo or redo returns to a copy, the
 * shapes this user changed are set back to that copy's.
 *
 * A copy is made just before an edit; the shapes are recorded at the latest just before this user
 * changes one (see {@link PartMeshes#beforeLocalChange}), or when OpenRocket reports a change of its
 * undo state. Undo of an edited state appends that state as a new copy (for redo) and goes back to
 * the copy before it; redo and undo of an unedited state move between copies; a reload of the
 * rocket by the live-share bridge does neither, and leaves the shapes alone.
 */
public final class PartMeshUndo {
	private final OpenRocketDocument doc;
	private final Consumer<Set<String>> restored;
	private final Map<Object, Map<String, String>> states = new IdentityHashMap<>();
	private Object lastEntry;
	private int lastSize;

	private PartMeshUndo(OpenRocketDocument doc, Consumer<Set<String>> restored) {
		this.doc = doc;
		this.restored = restored;
	}

	/** Follows `doc`'s undo history; `restored` is told which components' shapes an undo or redo changed. */
	public static PartMeshUndo install(OpenRocketDocument doc, Consumer<Set<String>> restored) {
		PartMeshUndo u = new PartMeshUndo(doc, restored);
		u.record();
		PartMeshes.beforeLocalChange(u::record);
		doc.addUndoRedoListener(u::changed);
		return u;
	}

	/** Gives undo states not seen yet the shapes as they are now. */
	private synchronized void record() {
		List<Object> list = history();
		int pos = position();
		if (list == null || pos < 0 || pos >= list.size()) {
			return;
		}
		remember(list);
		lastEntry = list.get(pos);
		lastSize = list.size();
	}

	private synchronized void changed() {
		List<Object> list = history();
		int pos = position();
		if (list == null || pos < 0 || pos >= list.size()) {
			return;
		}
		Object entry = list.get(pos);
		boolean known = states.containsKey(entry);
		// Redo, or undo of an unedited state: another copy. Undo of an edited state: the same copy,
		// with the edited state appended after it.
		boolean load = known && (entry != lastEntry || (list.size() == lastSize + 1 && pos == list.size() - 2
				&& !states.containsKey(list.get(list.size() - 1))));
		remember(list); // before restoring: an appended copy is the state undo just left
		lastEntry = entry;
		lastSize = list.size();
		if (load) {
			Set<String> changed = PartMeshes.restore(states.get(entry));
			if (!changed.isEmpty()) {
				restored.accept(changed);
			}
		}
	}

	private void remember(List<Object> list) {
		Map<String, String> now = PartMeshes.snapshot();
		Set<Object> present = Collections.newSetFromMap(new IdentityHashMap<>());
		for (Object x : list) {
			present.add(x);
			states.putIfAbsent(x, now);
		}
		states.keySet().retainAll(present);
	}

	@SuppressWarnings("unchecked")
	private List<Object> history() {
		try {
			Field f = OpenRocketDocument.class.getDeclaredField("undoHistory");
			f.setAccessible(true);
			return new ArrayList<>((List<Object>) f.get(doc));
		} catch (ReflectiveOperationException | RuntimeException e) {
			return null;
		}
	}

	private int position() {
		try {
			Field f = OpenRocketDocument.class.getDeclaredField("undoPosition");
			f.setAccessible(true);
			return f.getInt(doc);
		} catch (ReflectiveOperationException | RuntimeException e) {
			return -1;
		}
	}
}
