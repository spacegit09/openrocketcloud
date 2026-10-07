// Small XML reader + canonical writer. Must produce byte-for-byte the same canonical form as
// worker/bridge/src/orcloud/bridge/Xml.java (sorted attributes, no indentation whitespace,
// identical escaping), because both sides store and compare these strings.

export class El {
  constructor(tag) {
    this.tag = tag;
    this.attrs = new Map();
    this.children = []; // El | string
  }

  elements() {
    return this.children.filter((c) => c instanceof El);
  }

  first(name) {
    return this.children.find((c) => c instanceof El && c.tag === name) ?? null;
  }

  hasElementChildren() {
    return this.children.some((c) => c instanceof El);
  }

  text() {
    return this.children.filter((c) => typeof c === 'string').join('');
  }

  addText(t) {
    if (!t) return;
    const last = this.children.length - 1;
    if (last >= 0 && typeof this.children[last] === 'string') this.children[last] += t;
    else this.children.push(t);
  }
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
const normalizeNewlines = (s) => (s.includes('\r') ? s.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : s);

export function decode(s) {
  if (!s.includes('&')) return s;
  let out = '';
  let i = 0;
  let amp = s.indexOf('&');
  while (amp >= 0) {
    out += s.slice(i, amp);
    const semi = s.indexOf(';', amp);
    if (semi < 0 || semi - amp > 12) {
      out += '&';
      i = amp + 1;
    } else {
      const ent = s.slice(amp + 1, semi);
      let rep = null;
      switch (ent) {
        case 'lt': rep = '<'; break;
        case 'gt': rep = '>'; break;
        case 'amp': rep = '&'; break;
        case 'quot': rep = '"'; break;
        case 'apos': rep = "'"; break;
        default: {
          let code = NaN;
          if (/^#[xX][0-9a-fA-F]+$/.test(ent)) code = parseInt(ent.slice(2), 16);
          else if (/^#[0-9]+$/.test(ent)) code = parseInt(ent.slice(1), 10);
          if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) rep = String.fromCodePoint(code);
        }
      }
      out += rep === null ? s.slice(amp, semi + 1) : rep;
      i = semi + 1;
    }
    amp = s.indexOf('&', i);
  }
  return out + s.slice(i);
}

function skipPast(s, i, token) {
  const end = s.indexOf(token, i);
  if (end < 0) throw new Error(`Unterminated ${token}`);
  return end + token.length;
}

export function parse(s) {
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = s.length;
  const stack = [];
  let root = null;
  while (i < n) {
    if (s[i] !== '<') {
      let end = s.indexOf('<', i);
      if (end < 0) end = n;
      if (stack.length) stack[stack.length - 1].addText(decode(normalizeNewlines(s.slice(i, end))));
      i = end;
      continue;
    }
    if (s.startsWith('<?', i)) {
      i = skipPast(s, i, '?>');
    } else if (s.startsWith('<!--', i)) {
      i = skipPast(s, i, '-->');
    } else if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i);
      if (end < 0) throw new Error('Unterminated CDATA');
      if (stack.length) stack[stack.length - 1].addText(normalizeNewlines(s.slice(i + 9, end)));
      i = end + 3;
    } else if (s.startsWith('<!', i)) {
      let depth = 0;
      i += 2;
      while (i < n) {
        const d = s[i++];
        if (d === '[') depth++;
        else if (d === ']') depth--;
        else if (d === '>' && depth <= 0) break;
      }
    } else if (s.startsWith('</', i)) {
      const end = s.indexOf('>', i);
      if (end < 0) throw new Error('Unterminated end tag');
      const name = s.slice(i + 2, end).trim();
      if (!stack.length || stack[stack.length - 1].tag !== name) throw new Error(`Mismatched end tag </${name}>`);
      stack.pop();
      i = end + 1;
    } else {
      i++;
      const start = i;
      while (i < n && !isSpace(s[i]) && s[i] !== '/' && s[i] !== '>') i++;
      const el = new El(s.slice(start, i));
      let selfClosing = false;
      for (;;) {
        while (i < n && isSpace(s[i])) i++;
        if (i >= n) throw new Error(`Unterminated start tag <${el.tag}`);
        const d = s[i];
        if (d === '/') {
          selfClosing = true;
          i = s.indexOf('>', i) + 1;
          break;
        }
        if (d === '>') {
          i++;
          break;
        }
        const ns = i;
        while (i < n && s[i] !== '=' && !isSpace(s[i]) && s[i] !== '>') i++;
        const an = s.slice(ns, i);
        while (i < n && isSpace(s[i])) i++;
        if (s[i] !== '=') throw new Error(`Malformed attribute '${an}' in <${el.tag}>`);
        i++;
        while (i < n && isSpace(s[i])) i++;
        const q = s[i];
        if (q !== '"' && q !== "'") throw new Error(`Unquoted attribute '${an}' in <${el.tag}>`);
        const ve = s.indexOf(q, i + 1);
        if (ve < 0) throw new Error('Unterminated attribute value');
        const raw = s.slice(i + 1, ve).replace(/\r\n/g, ' ').replace(/[\n\r\t]/g, ' ');
        el.attrs.set(an, decode(raw));
        i = ve + 1;
      }
      if (!stack.length) {
        if (root) throw new Error('Multiple root elements');
        root = el;
      } else {
        stack[stack.length - 1].children.push(el);
      }
      if (!selfClosing) stack.push(el);
    }
  }
  if (!root) throw new Error('No root element');
  if (stack.length) throw new Error(`Unclosed element <${stack[stack.length - 1].tag}>`);
  return root;
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const TEXT_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\r': '&#13;' };
const ATTR_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };
const escText = (t) => t.replace(/[&<>\r]/g, (c) => TEXT_ESC[c]);
const escAttr = (t) => t.replace(/[&<>"\n\r\t]/g, (c) => ATTR_ESC[c]);

export const isBlank = (t) => /^[ \t\n\r]*$/.test(t);

export function attrsCanonical(attrs) {
  const entries = attrs instanceof Map ? [...attrs.entries()] : Object.entries(attrs);
  entries.sort((a, b) => cmp(a[0], b[0]));
  return entries.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
}

export function canonical(el) {
  const mixed = el.hasElementChildren();
  let out = `<${el.tag}${attrsCanonical(el.attrs)}>`;
  for (const c of el.children) {
    if (c instanceof El) out += canonical(c);
    else if (!(mixed && isBlank(c))) out += escText(c);
  }
  return `${out}</${el.tag}>`;
}

export const escapeText = escText;
