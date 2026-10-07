package orcloud.bridge;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Small, predictable XML reader plus a canonical writer.
 *
 * The canonical form (sorted attributes, no indentation whitespace, fixed escaping) is what
 * the shared document model stores, so two saves of the same design compare equal. The
 * server (server/src/xml.js) implements byte-for-byte the same rules; keep them in sync.
 */
final class Xml {
	private Xml() {
	}

	static final class El {
		final String tag;
		final TreeMap<String, String> attrs = new TreeMap<>();
		final List<Object> children = new ArrayList<>(); // El or String

		El(String tag) {
			this.tag = tag;
		}

		List<El> elements() {
			List<El> out = new ArrayList<>();
			for (Object c : children) {
				if (c instanceof El) {
					out.add((El) c);
				}
			}
			return out;
		}

		El first(String name) {
			for (Object c : children) {
				if (c instanceof El && ((El) c).tag.equals(name)) {
					return (El) c;
				}
			}
			return null;
		}

		boolean hasElementChildren() {
			for (Object c : children) {
				if (c instanceof El) {
					return true;
				}
			}
			return false;
		}

		String text() {
			StringBuilder sb = new StringBuilder();
			for (Object c : children) {
				if (c instanceof String) {
					sb.append((String) c);
				}
			}
			return sb.toString();
		}

		void addText(String t) {
			if (t.isEmpty()) {
				return;
			}
			int last = children.size() - 1;
			if (last >= 0 && children.get(last) instanceof String) {
				children.set(last, children.get(last) + t);
			} else {
				children.add(t);
			}
		}
	}

	// ------------------------------------------------------------------ parsing

	static El parse(String s) {
		int i = 0;
		int n = s.length();
		if (n > 0 && s.charAt(0) == '﻿') {
			i = 1;
		}
		List<El> stack = new ArrayList<>();
		El root = null;
		while (i < n) {
			char c = s.charAt(i);
			if (c != '<') {
				int end = s.indexOf('<', i);
				if (end < 0) {
					end = n;
				}
				if (!stack.isEmpty()) {
					stack.get(stack.size() - 1).addText(decode(normalizeNewlines(s.substring(i, end))));
				}
				i = end;
				continue;
			}
			if (s.startsWith("<?", i)) {
				i = skipPast(s, i, "?>");
			} else if (s.startsWith("<!--", i)) {
				i = skipPast(s, i, "-->");
			} else if (s.startsWith("<![CDATA[", i)) {
				int end = s.indexOf("]]>", i);
				if (end < 0) {
					throw new IllegalArgumentException("Unterminated CDATA");
				}
				if (!stack.isEmpty()) {
					stack.get(stack.size() - 1).addText(normalizeNewlines(s.substring(i + 9, end)));
				}
				i = end + 3;
			} else if (s.startsWith("<!", i)) {
				int depth = 0;
				i += 2;
				while (i < n) {
					char d = s.charAt(i++);
					if (d == '[') {
						depth++;
					} else if (d == ']') {
						depth--;
					} else if (d == '>' && depth <= 0) {
						break;
					}
				}
			} else if (s.startsWith("</", i)) {
				int end = s.indexOf('>', i);
				if (end < 0) {
					throw new IllegalArgumentException("Unterminated end tag");
				}
				String name = s.substring(i + 2, end).trim();
				if (stack.isEmpty() || !stack.get(stack.size() - 1).tag.equals(name)) {
					throw new IllegalArgumentException("Mismatched end tag </" + name + ">");
				}
				stack.remove(stack.size() - 1);
				i = end + 1;
			} else {
				i++;
				int start = i;
				while (i < n && !isSpace(s.charAt(i)) && s.charAt(i) != '/' && s.charAt(i) != '>') {
					i++;
				}
				El el = new El(s.substring(start, i));
				boolean selfClosing = false;
				while (true) {
					while (i < n && isSpace(s.charAt(i))) {
						i++;
					}
					if (i >= n) {
						throw new IllegalArgumentException("Unterminated start tag <" + el.tag);
					}
					char d = s.charAt(i);
					if (d == '/') {
						selfClosing = true;
						i = s.indexOf('>', i) + 1;
						break;
					}
					if (d == '>') {
						i++;
						break;
					}
					int ns = i;
					while (i < n && s.charAt(i) != '=' && !isSpace(s.charAt(i)) && s.charAt(i) != '>') {
						i++;
					}
					String an = s.substring(ns, i);
					while (i < n && isSpace(s.charAt(i))) {
						i++;
					}
					if (i >= n || s.charAt(i) != '=') {
						throw new IllegalArgumentException("Malformed attribute '" + an + "' in <" + el.tag + ">");
					}
					i++;
					while (i < n && isSpace(s.charAt(i))) {
						i++;
					}
					char q = s.charAt(i);
					if (q != '"' && q != '\'') {
						throw new IllegalArgumentException("Unquoted attribute '" + an + "' in <" + el.tag + ">");
					}
					int ve = s.indexOf(q, i + 1);
					if (ve < 0) {
						throw new IllegalArgumentException("Unterminated attribute value");
					}
					String raw = s.substring(i + 1, ve).replace("\r\n", " ").replace('\n', ' ').replace('\r', ' ').replace('\t', ' ');
					el.attrs.put(an, decode(raw));
					i = ve + 1;
				}
				if (stack.isEmpty()) {
					if (root != null) {
						throw new IllegalArgumentException("Multiple root elements");
					}
					root = el;
				} else {
					stack.get(stack.size() - 1).children.add(el);
				}
				if (!selfClosing) {
					stack.add(el);
				}
			}
		}
		if (root == null) {
			throw new IllegalArgumentException("No root element");
		}
		if (!stack.isEmpty()) {
			throw new IllegalArgumentException("Unclosed element <" + stack.get(stack.size() - 1).tag + ">");
		}
		return root;
	}

	private static int skipPast(String s, int i, String token) {
		int end = s.indexOf(token, i);
		if (end < 0) {
			throw new IllegalArgumentException("Unterminated " + token);
		}
		return end + token.length();
	}

	private static boolean isSpace(char c) {
		return c == ' ' || c == '\n' || c == '\r' || c == '\t';
	}

	private static String normalizeNewlines(String s) {
		return s.indexOf('\r') < 0 ? s : s.replace("\r\n", "\n").replace('\r', '\n');
	}

	static String decode(String s) {
		int amp = s.indexOf('&');
		if (amp < 0) {
			return s;
		}
		StringBuilder sb = new StringBuilder(s.length());
		int i = 0;
		while (amp >= 0) {
			sb.append(s, i, amp);
			int semi = s.indexOf(';', amp);
			if (semi < 0 || semi - amp > 12) {
				sb.append('&');
				i = amp + 1;
			} else {
				String ent = s.substring(amp + 1, semi);
				String rep = null;
				switch (ent) {
				case "lt": rep = "<"; break;
				case "gt": rep = ">"; break;
				case "amp": rep = "&"; break;
				case "quot": rep = "\""; break;
				case "apos": rep = "'"; break;
				default:
					try {
						if (ent.matches("#[xX][0-9a-fA-F]+")) {
							rep = new String(Character.toChars(Integer.parseInt(ent.substring(2), 16)));
						} else if (ent.matches("#[0-9]+")) {
							rep = new String(Character.toChars(Integer.parseInt(ent.substring(1))));
						}
					} catch (IllegalArgumentException e) {
						rep = null; // out of range: keep the reference as written
					}
				}
				if (rep == null) {
					sb.append(s, amp, semi + 1);
				} else {
					sb.append(rep);
				}
				i = semi + 1;
			}
			amp = s.indexOf('&', i);
		}
		sb.append(s, i, s.length());
		return sb.toString();
	}

	// ------------------------------------------------------------------ writing

	static String canonical(El el) {
		StringBuilder sb = new StringBuilder();
		writeCanonical(sb, el);
		return sb.toString();
	}

	static String attrsCanonical(Map<String, String> attrs) {
		StringBuilder sb = new StringBuilder();
		for (Map.Entry<String, String> a : new TreeMap<>(attrs).entrySet()) {
			sb.append(' ').append(a.getKey()).append("=\"");
			escAttr(sb, a.getValue());
			sb.append('"');
		}
		return sb.toString();
	}

	private static void writeCanonical(StringBuilder sb, El el) {
		sb.append('<').append(el.tag).append(attrsCanonical(el.attrs)).append('>');
		boolean mixed = el.hasElementChildren();
		for (Object c : el.children) {
			if (c instanceof El) {
				writeCanonical(sb, (El) c);
			} else {
				String t = (String) c;
				if (mixed && isBlank(t)) {
					continue;
				}
				escText(sb, t);
			}
		}
		sb.append("</").append(el.tag).append('>');
	}

	static boolean isBlank(String t) {
		for (int i = 0; i < t.length(); i++) {
			if (!isSpace(t.charAt(i))) {
				return false;
			}
		}
		return true;
	}

	static void escText(StringBuilder sb, String t) {
		for (int i = 0; i < t.length(); i++) {
			char c = t.charAt(i);
			switch (c) {
			case '&': sb.append("&amp;"); break;
			case '<': sb.append("&lt;"); break;
			case '>': sb.append("&gt;"); break;
			case '\r': sb.append("&#13;"); break;
			default: sb.append(c);
			}
		}
	}

	static void escAttr(StringBuilder sb, String t) {
		for (int i = 0; i < t.length(); i++) {
			char c = t.charAt(i);
			switch (c) {
			case '&': sb.append("&amp;"); break;
			case '<': sb.append("&lt;"); break;
			case '>': sb.append("&gt;"); break;
			case '"': sb.append("&quot;"); break;
			case '\n': sb.append("&#10;"); break;
			case '\r': sb.append("&#13;"); break;
			case '\t': sb.append("&#9;"); break;
			default: sb.append(c);
			}
		}
	}
}
