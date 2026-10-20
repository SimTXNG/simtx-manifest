// Minimal XML property-list reader/writer. XBPS stores package and repo
// metadata as Apple XML plists; this covers the value types xbps uses.

export type PlistValue =
  | string
  | number
  | boolean
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" ' +
  '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
  '<plist version="1.0">\n';

function decodeEntities(s: string): string {
  return s.replace(
    /&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g,
    (m, e: string) => {
      switch (e) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
      }
      if (e.startsWith("#x") || e.startsWith("#X")) {
        return String.fromCodePoint(parseInt(e.slice(2), 16));
      }
      if (e.startsWith("#")) {
        return String.fromCodePoint(parseInt(e.slice(1), 10));
      }
      return m;
    },
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function base64Encode(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(out);
}

function base64Decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, "");
  const raw = atob(clean);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const OPEN_TAG = /<\s*([A-Za-z0-9_:.-]+)((?:\s+[^>]*?)?)(\/?)>/y;
const CLOSE_TAG = /<\s*\/\s*([A-Za-z0-9_:.-]+)\s*>/y;

class PlistParser {
  private i = 0;

  constructor(private readonly xml: string) {}

  parse(): PlistValue {
    this.skipProlog();
    const value = this.parseValue();
    this.skipWs();
    return value;
  }

  private skipWs(): void {
    while (this.i < this.xml.length && /\s/.test(this.xml[this.i])) this.i++;
  }

  private skipProlog(): void {
    this.skipWs();
    for (;;) {
      if (this.xml.startsWith("<?", this.i)) {
        const end = this.xml.indexOf("?>", this.i + 2);
        if (end < 0) throw new Error("plist: unterminated XML declaration");
        this.i = end + 2;
      } else if (this.xml.startsWith("<!--", this.i)) {
        const end = this.xml.indexOf("-->", this.i + 4);
        if (end < 0) throw new Error("plist: unterminated comment");
        this.i = end + 3;
      } else if (this.xml.startsWith("<!DOCTYPE", this.i)) {
        const end = this.xml.indexOf(">", this.i + 9);
        if (end < 0) throw new Error("plist: unterminated DOCTYPE");
        this.i = end + 1;
      } else {
        break;
      }
      this.skipWs();
    }
  }

  private openTag(): { name: string; selfClosing: boolean } {
    this.skipWs();
    OPEN_TAG.lastIndex = this.i;
    const m = OPEN_TAG.exec(this.xml);
    if (!m) {
      throw new Error(`plist: expected an opening tag at offset ${this.i}`);
    }
    this.i = OPEN_TAG.lastIndex;
    return { name: m[1], selfClosing: m[3] === "/" };
  }

  private closeTag(name: string): void {
    this.skipWs();
    CLOSE_TAG.lastIndex = this.i;
    const m = CLOSE_TAG.exec(this.xml);
    if (!m) throw new Error(`plist: expected </${name}> at offset ${this.i}`);
    if (m[1] !== name) {
      throw new Error(`plist: expected </${name}>, got </${m[1]}>`);
    }
    this.i = CLOSE_TAG.lastIndex;
  }

  private textUntil(name: string): string {
    const close = `</${name}>`;
    const end = this.xml.indexOf(close, this.i);
    if (end < 0) throw new Error(`plist: missing </${name}>`);
    const raw = this.xml.slice(this.i, end);
    this.i = end + close.length;
    return decodeEntities(raw);
  }

  private parseValue(): PlistValue {
    this.skipWs();
    if (this.xml.startsWith("<plist", this.i)) {
      const { selfClosing } = this.openTag();
      if (selfClosing) return {};
      const value = this.parseValue();
      this.closeTag("plist");
      return value;
    }

    const { name, selfClosing } = this.openTag();
    switch (name) {
      case "dict": {
        const out: PlistDict = {};
        if (selfClosing) return out;
        for (;;) {
          this.skipWs();
          if (this.xml.startsWith("</dict>", this.i)) {
            this.i += "</dict>".length;
            return out;
          }
          const keyTag = this.openTag();
          if (keyTag.name !== "key") {
            throw new Error(`plist: expected <key>, got <${keyTag.name}>`);
          }
          const key = keyTag.selfClosing ? "" : this.textUntil("key");
          out[key] = this.parseValue();
        }
      }
      case "array": {
        const out: PlistValue[] = [];
        if (selfClosing) return out;
        for (;;) {
          this.skipWs();
          if (this.xml.startsWith("</array>", this.i)) {
            this.i += "</array>".length;
            return out;
          }
          out.push(this.parseValue());
        }
      }
      case "string":
        return selfClosing ? "" : this.textUntil("string");
      case "integer": {
        const s = selfClosing ? "" : this.textUntil("integer").trim();
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error(`plist: bad integer "${s}"`);
        return n;
      }
      case "real": {
        const s = selfClosing ? "" : this.textUntil("real").trim();
        const n = Number(s);
        if (!Number.isFinite(n)) throw new Error(`plist: bad real "${s}"`);
        return n;
      }
      case "true":
        if (!selfClosing) this.closeTag("true");
        return true;
      case "false":
        if (!selfClosing) this.closeTag("false");
        return false;
      case "data":
        return selfClosing
          ? new Uint8Array()
          : base64Decode(this.textUntil("data"));
      case "date":
        return selfClosing ? "" : this.textUntil("date");
      default:
        throw new Error(`plist: unsupported element <${name}>`);
    }
  }
}

export function parsePlist(xml: string): PlistValue {
  return new PlistParser(xml).parse();
}

function serialize(value: PlistValue, depth: number): string {
  const pad = "\t".repeat(depth);
  if (typeof value === "string") {
    return `${pad}<string>${escapeXml(value)}</string>\n`;
  }
  if (typeof value === "boolean") {
    return `${pad}<${value ? "true" : "false"}/>\n`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("plist: non-finite number");
    return Number.isInteger(value)
      ? `${pad}<integer>${value}</integer>\n`
      : `${pad}<real>${value}</real>\n`;
  }
  if (value instanceof Uint8Array) {
    return `${pad}<data>${base64Encode(value)}</data>\n`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<array/>\n`;
    let out = `${pad}<array>\n`;
    for (const item of value) out += serialize(item, depth + 1);
    return out + `${pad}</array>\n`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}<dict/>\n`;
    let out = `${pad}<dict>\n`;
    for (const [key, item] of entries) {
      out += `${pad}\t<key>${escapeXml(key)}</key>\n`;
      out += serialize(item, depth + 1);
    }
    return out + `${pad}</dict>\n`;
  }
  throw new Error("plist: unsupported value");
}

export function serializePlist(value: PlistValue): string {
  return XML_HEADER + serialize(value, 0) + "</plist>\n";
}
