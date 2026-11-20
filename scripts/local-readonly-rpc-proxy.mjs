import { createServer } from 'node:http';

// Local fork transport bridge. It forwards only read methods to the public GIWA
// endpoint; local EVM writes must go to Hardhat's separate localhost port.
const upstream = 'https://sepolia-rpc.giwa.io';
const allowed = /^(eth_(chainId|blockNumber|get[A-Z][A-Za-z0-9]*|feeHistory|maxPriorityFeePerGas|gasPrice)|net_version|web3_clientVersion)$/;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/') { res.writeHead(405).end(); return; }
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((n, c) => n + c.length, 0) > 2_000_000) throw new Error('Request too large');
    }
    const body = Buffer.concat(chunks).toString('utf8');
    const data = JSON.parse(body);
    const calls = Array.isArray(data) ? data : [data];
    for (const call of calls) if (typeof call.method !== 'string' || !allowed.test(call.method)) throw new Error(`Upstream RPC method blocked: ${call.method}`);
    const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(30_000) });
    const text = await response.text();
    process.stdout.write(`${new Date().toISOString()} ${calls.map(c => c.method).join(',')} HTTP ${response.status}\n`);
    res.writeHead(response.status, { 'content-type': 'application/json' }).end(text);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} ${String(error)}\n`);
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: String(error) } }));
  }
});
server.listen(8546, '127.0.0.1', () => process.stdout.write('Read-only GIWA RPC bridge on 127.0.0.1:8546\n'));
