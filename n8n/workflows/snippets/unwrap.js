function surface(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { error: { code: 'invalid_response', message: 'invalid_response' } };
  }
  if (typeof parsed.error === 'string') {
    const error = {
      code: parsed.error,
      message: typeof parsed.message === 'string' ? parsed.message : parsed.error,
    };
    const status = typeof parsed.status === 'string' ? parsed.status : parsed.error;
    return Object.assign({}, parsed, { error, status });
  }
  if (parsed.error && typeof parsed.error === 'object') {
    const code = parsed.error.code === undefined || parsed.error.code === null ? 'error' : parsed.error.code;
    const message = typeof parsed.error.message === 'string' ? parsed.error.message : String(code);
    return Object.assign({}, parsed, { error: { code, message } });
  }
  return parsed;
}

function unwrap(payload) {
  if (!payload || typeof payload !== 'object') {
    return { error: { code: 'invalid_response', message: 'invalid_response' } };
  }
  if (payload.error) return surface(payload);
  const result = payload.result;
  if (!result || typeof result !== 'object') return payload;
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const text = content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      return item.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .join('');
  if (!text) return result;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return surface(parsed);
  } catch {
    return { text };
  }
  return { text };
}

if (typeof $input !== 'undefined') {
  return $input.all().map((item, index) => ({
    json: unwrap(item.json),
    pairedItem: { item: index },
  }));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { unwrap, surface };
}
