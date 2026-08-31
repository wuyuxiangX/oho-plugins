var formatJson = {
  id: "json.format",
  execute({ value, indent = 2 }) {
    const formatted = JSON.stringify(JSON.parse(value), null, indent);
    return { formatted, characterCount: [...formatted].length };
  }
};
var inspectText = {
  id: "text.inspect",
  execute({ text }) {
    const trimmed = text.trim();
    return {
      lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
      words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
      characters: [...text].length,
      utf8Bytes: new TextEncoder().encode(text).byteLength
    };
  }
};
var index_default = {
  tools: [formatJson, inspectText]
};
export {
  index_default as default
};
