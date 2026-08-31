const formatJson = {
  id: "json.format",
  execute({ value, indent = 2 }: { value: string; indent?: 2 | 4 }) {
    const formatted = JSON.stringify(JSON.parse(value), null, indent);
    return { formatted, characterCount: [...formatted].length };
  },
};

const inspectText = {
  id: "text.inspect",
  execute({ text }: { text: string }) {
    const trimmed = text.trim();
    return {
      lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
      words: trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length,
      characters: [...text].length,
      utf8Bytes: new TextEncoder().encode(text).byteLength,
    };
  },
};

export default {
  tools: [formatJson, inspectText],
};
