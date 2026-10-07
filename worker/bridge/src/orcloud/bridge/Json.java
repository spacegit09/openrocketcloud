package orcloud.bridge;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON codec. Values map to: Map (object), List (array), String, Double (number),
 * Boolean and null. Kept dependency-free so the bridge only needs the OpenRocket jar.
 */
final class Json {
	private Json() {
	}

	static Object parse(String s) {
		Parser p = new Parser(s);
		p.ws();
		Object v = p.value();
		p.ws();
		if (p.i != s.length()) {
			throw new IllegalArgumentException("Trailing data in JSON at " + p.i);
		}
		return v;
	}

	static String stringify(Object v) {
		StringBuilder sb = new StringBuilder();
		write(sb, v);
		return sb.toString();
	}

	@SuppressWarnings("unchecked")
	static void write(StringBuilder sb, Object v) {
		if (v == null) {
			sb.append("null");
		} else if (v instanceof String) {
			quote(sb, (String) v);
		} else if (v instanceof Double || v instanceof Float) {
			double d = ((Number) v).doubleValue();
			if (Double.isNaN(d) || Double.isInfinite(d)) {
				sb.append("null");
			} else if (d == Math.rint(d) && Math.abs(d) < 1e15) {
				sb.append((long) d);
			} else {
				sb.append(d);
			}
		} else if (v instanceof Number || v instanceof Boolean) {
			sb.append(v);
		} else if (v instanceof Map) {
			sb.append('{');
			boolean first = true;
			for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
				if (!first) {
					sb.append(',');
				}
				first = false;
				quote(sb, e.getKey());
				sb.append(':');
				write(sb, e.getValue());
			}
			sb.append('}');
		} else if (v instanceof Iterable) {
			sb.append('[');
			boolean first = true;
			for (Object o : (Iterable<Object>) v) {
				if (!first) {
					sb.append(',');
				}
				first = false;
				write(sb, o);
			}
			sb.append(']');
		} else {
			quote(sb, v.toString());
		}
	}

	private static void quote(StringBuilder sb, String s) {
		sb.append('"');
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			switch (c) {
			case '"': sb.append("\\\""); break;
			case '\\': sb.append("\\\\"); break;
			case '\n': sb.append("\\n"); break;
			case '\r': sb.append("\\r"); break;
			case '\t': sb.append("\\t"); break;
			case '\b': sb.append("\\b"); break;
			case '\f': sb.append("\\f"); break;
			default:
				if (c < 0x20 || c == 0x2028 || c == 0x2029) {
					sb.append(String.format("\\u%04x", (int) c));
				} else {
					sb.append(c);
				}
			}
		}
		sb.append('"');
	}

	private static final class Parser {
		final String s;
		int i;

		Parser(String s) {
			this.s = s;
		}

		void ws() {
			while (i < s.length()) {
				char c = s.charAt(i);
				if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
					i++;
				} else {
					break;
				}
			}
		}

		Object value() {
			if (i >= s.length()) {
				throw new IllegalArgumentException("Unexpected end of JSON");
			}
			char c = s.charAt(i);
			switch (c) {
			case '{': return object();
			case '[': return array();
			case '"': return string();
			case 't': expect("true"); return Boolean.TRUE;
			case 'f': expect("false"); return Boolean.FALSE;
			case 'n': expect("null"); return null;
			default: return number();
			}
		}

		void expect(String word) {
			if (!s.startsWith(word, i)) {
				throw new IllegalArgumentException("Bad JSON token at " + i);
			}
			i += word.length();
		}

		Map<String, Object> object() {
			Map<String, Object> m = new LinkedHashMap<>();
			i++;
			ws();
			if (s.charAt(i) == '}') {
				i++;
				return m;
			}
			while (true) {
				ws();
				String k = string();
				ws();
				if (s.charAt(i++) != ':') {
					throw new IllegalArgumentException("Expected ':' at " + (i - 1));
				}
				ws();
				m.put(k, value());
				ws();
				char c = s.charAt(i++);
				if (c == '}') {
					return m;
				}
				if (c != ',') {
					throw new IllegalArgumentException("Expected ',' at " + (i - 1));
				}
			}
		}

		List<Object> array() {
			List<Object> l = new ArrayList<>();
			i++;
			ws();
			if (s.charAt(i) == ']') {
				i++;
				return l;
			}
			while (true) {
				ws();
				l.add(value());
				ws();
				char c = s.charAt(i++);
				if (c == ']') {
					return l;
				}
				if (c != ',') {
					throw new IllegalArgumentException("Expected ',' at " + (i - 1));
				}
			}
		}

		String string() {
			if (s.charAt(i) != '"') {
				throw new IllegalArgumentException("Expected string at " + i);
			}
			i++;
			StringBuilder sb = new StringBuilder();
			while (true) {
				char c = s.charAt(i++);
				if (c == '"') {
					return sb.toString();
				}
				if (c != '\\') {
					sb.append(c);
					continue;
				}
				char e = s.charAt(i++);
				switch (e) {
				case 'n': sb.append('\n'); break;
				case 'r': sb.append('\r'); break;
				case 't': sb.append('\t'); break;
				case 'b': sb.append('\b'); break;
				case 'f': sb.append('\f'); break;
				case 'u':
					sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
					i += 4;
					break;
				default: sb.append(e);
				}
			}
		}

		Double number() {
			int start = i;
			while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
				i++;
			}
			if (start == i) {
				throw new IllegalArgumentException("Bad JSON value at " + i);
			}
			return Double.valueOf(s.substring(start, i));
		}
	}
}
