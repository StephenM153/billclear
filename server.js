const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const PORT    = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY environment variable is not set.');
  process.exit(1);
}

// ── Claude prompt ──
const SYSTEM_PROMPT = `You are a friendly, patient helper who explains UK energy bills to everyday people — especially older people who may find bills confusing. You speak simply and warmly, as if explaining to a grandparent.

Rules you must always follow:
- Use short sentences. Never use jargon without immediately explaining it.
- Never use bullet points or numbered lists. Use short paragraphs with bold headings instead.
- Be reassuring and friendly — never alarming or preachy.
- You are not a financial advisor. Do not give regulated financial advice.
- Keep the explanation clear and structured.

Always structure your response using these exact bold headings, each on its own line, followed by a short paragraph:

**What You Are Paying For**
A simple overview of what this bill covers.

**Breaking Down the Charges**
Explain each charge or line item on the bill in plain terms. What does it mean? Why does it exist?

**Is Your Usage Typical?**
Compare their usage to what is typical for a UK household. Is it high, low, or about right? Be gentle and non-judgmental.

**Anything Worth Querying?**
Point out any charges, fees, or figures that look unusual, unexplained, or worth asking the supplier about. If everything looks normal, say so reassuringly.

**Our Tip for You**
One single friendly, practical tip to help them going forward. Keep it positive and simple.

Do not include any other sections. Do not add any preamble or sign-off. Start directly with the first heading.`;

// ── Multipart parser (minimal, for file uploads) ──
function parseMultipart(body, boundary) {
  const parts = [];
  const sep   = Buffer.from('--' + boundary);
  let   start = 0;

  while (true) {
    const idx = body.indexOf(sep, start);
    if (idx === -1) break;
    const after = idx + sep.length;
    if (body[after] === 45 && body[after + 1] === 45) break; // --boundary--

    const headerEnd = body.indexOf('\r\n\r\n', after);
    if (headerEnd === -1) break;

    const headers  = body.slice(after + 2, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextSep  = body.indexOf('\r\n' + sep.toString(), dataStart);
    const dataEnd  = nextSep === -1 ? body.length : nextSep;

    const nameMatch = headers.match(/name="([^"]+)"/);
    const fileMatch = headers.match(/filename="([^"]+)"/);
    const typeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/);

    parts.push({
      name:        nameMatch ? nameMatch[1] : null,
      filename:    fileMatch ? fileMatch[1] : null,
      contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
      data:        body.slice(dataStart, dataEnd),
    });

    start = dataEnd;
  }
  return parts;
}

// ── Claude API call ──
async function callClaude(messages) {
  const body = JSON.stringify({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system:     SYSTEM_PROMPT,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https().request(
      {
        hostname: 'api.anthropic.com',
        path:     '/v1/messages',
        method:   'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Length':    Buffer.byteLength(body),
        },
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            if (json.error) return reject(new Error(json.error.message || 'Claude API error'));
            const text = json.content?.[0]?.text;
            if (!text) return reject(new Error('Empty response from Claude'));
            resolve(text);
          } catch (e) {
            reject(new Error('Failed to parse Claude response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function https() { return require('https'); }

// ── Route handlers ──
async function handleExplainText(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const { text } = JSON.parse(Buffer.concat(chunks).toString());
      if (!text || text.trim().length < 20) {
        return jsonError(res, 400, 'Please paste more bill text — at least a few lines.');
      }
      const explanation = await callClaude([
        { role: 'user', content: `Here is my UK energy bill text. Please explain it to me:\n\n${text}` },
      ]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ explanation }));
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  });
}

async function handleExplainFile(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      const body     = Buffer.concat(chunks);
      const ct       = req.headers['content-type'] || '';
      const bMatch   = ct.match(/boundary=([^\s;]+)/);
      if (!bMatch) return jsonError(res, 400, 'Invalid upload.');

      const parts = parseMultipart(body, bMatch[1]);
      const file  = parts.find(p => p.name === 'file');
      if (!file) return jsonError(res, 400, 'No file found in upload.');

      const mime = file.contentType.toLowerCase();
      let messages;

      if (mime.startsWith('image/')) {
        // Send as vision message
        const mediaType = mime.includes('png') ? 'image/png'
                        : mime.includes('gif') ? 'image/gif'
                        : mime.includes('webp') ? 'image/webp'
                        : 'image/jpeg';
        messages = [{
          role: 'user',
          content: [
            {
              type:   'image',
              source: {
                type:       'base64',
                media_type: mediaType,
                data:       file.data.toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'This is a photo of my UK energy bill. Please read it carefully and explain it to me in plain English.',
            },
          ],
        }];
      } else if (mime === 'application/pdf') {
        // Send PDF via the files API (base64 document block)
        messages = [{
          role: 'user',
          content: [
            {
              type:   'document',
              source: {
                type:       'base64',
                media_type: 'application/pdf',
                data:       file.data.toString('base64'),
              },
            },
            {
              type: 'text',
              text: 'This is my UK energy bill as a PDF. Please read it carefully and explain it to me in plain English.',
            },
          ],
        }];
      } else {
        return jsonError(res, 400, 'Please upload a photo (JPG or PNG) or a PDF file.');
      }

      const explanation = await callClaude(messages);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ explanation }));
    } catch (e) {
      jsonError(res, 500, e.message);
    }
  });
}

function jsonError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

// ── Static file server ──
function serveStatic(req, res) {
  const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext      = path.extname(filePath);
  const types    = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  const ct       = types[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
}

// ── Server ──
const server = http.createServer((req, res) => {
  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && req.url === '/api/explain') {
    return handleExplainText(req, res);
  }
  if (req.method === 'POST' && req.url === '/api/explain-file') {
    return handleExplainFile(req, res);
  }
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }
  res.writeHead(405);
  res.end('Method not allowed');
});

server.listen(PORT, () => {
  console.log(`\n✅  BillClear is running at http://localhost:${PORT}\n`);
});
