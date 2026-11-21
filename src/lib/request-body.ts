export async function boundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > maxBytes) throw new Error('Body too large');
  if (!request.body) throw new Error('Empty body');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) throw new Error('Body too large');
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}
