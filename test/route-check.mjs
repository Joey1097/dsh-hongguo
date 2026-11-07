/**
 * Route-level checks for the Host half, without DSH.
 *
 * `apply` is called with a fake ctx that records the prefix routes it
 * registers, then each changed route is invoked with a fake request/response.
 * Nothing here touches the network except the fire-and-forget feed warm-up,
 * which the checks never await.
 */
import assert from 'node:assert/strict'
import { apply } from '../index.js'

const ORIGIN = 'http://127.0.0.1:62408'
const routes = []

const webServer = {
  getOrigin: () => ORIGIN,
  register: (route) => {
    routes.push(route)
    return () => {}
  },
  registerUpgrade: () => () => {},
  registerFallback: () => () => {},
  tapIndex: () => () => {},
  applyIndexTaps: (html) => html,
  collectIndexInjections: () => [],
  renderIndex: (html) => html,
}

const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
  inject: (deps, callback) => callback({ webServer }),
  get: () => undefined,
}

apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 50))

function makeRes() {
  const res = { statusCode: 200, headers: {}, chunks: [], headersSent: false }
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = String(value)
  }
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk))
    res.headersSent = true
  }
  res.end = (body) => {
    if (body !== undefined) res.chunks.push(Buffer.from(String(body)))
    res.headersSent = true
  }
  res.text = () => Buffer.concat(res.chunks).toString('utf8')
  return res
}

function makeReq({ url = '/', method = 'GET', host = '127.0.0.1:62408', body } = {}) {
  const req = { url, method, headers: { host } }
  if (body !== undefined) {
    req[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(body)
    }
  }
  return req
}

/** Mirror the web server's longest-prefix dispatch. */
async function hit(url, options = {}) {
  const path = new URL(url, ORIGIN).pathname
  const route = routes
    .filter((candidate) => path === candidate.path || path.startsWith(`${candidate.path}/`) || path.startsWith(candidate.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  assert.ok(route, `no route registered for ${path}`)
  const res = makeRes()
  await route.handler(makeReq({ url, ...options }), res)
  return res
}

const results = []
function check(name, fn) {
  results.push(
    Promise.resolve()
      .then(fn)
      .then(() => ({ name, ok: true }))
      .catch((error) => ({ name, ok: false, detail: error?.message ?? String(error) })),
  )
}

check('config answers without leaking an absolute path', async () => {
  const res = await hit('/api/hongguo/config')
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.text())
  assert.equal(body.autoPrompt, true)
  assert.equal('profilePath' in body, false, 'profilePath must not be exposed')
})

check('a foreign Host header is refused', async () => {
  const res = await hit('/api/hongguo/config', { host: 'attacker.example:62408' })
  assert.equal(res.statusCode, 403)
})

check('the loopback aliases are accepted', async () => {
  for (const host of ['127.0.0.1:62408', 'localhost:62408']) {
    const res = await hit('/api/hongguo/config', { host })
    assert.equal(res.statusCode, 200, `host ${host} should be accepted`)
  }
})

check('.mjs is served as a JavaScript module', async () => {
  const res = await hit('/api/hongguo/vendor/dash.all.min.mjs')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/javascript/)
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
})

check('classic vendor scripts stay JavaScript', async () => {
  const res = await hit('/api/hongguo/vendor/mpegts.js')
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /^text\/javascript/)
})

check('vendor traversal is refused', async () => {
  const res = await hit('/api/hongguo/vendor/..%2f..%2fpackage.json')
  assert.equal(res.statusCode, 404)
})

check('stream refuses a non-allowlisted host', async () => {
  const res = await hit('/api/hongguo/stream?u=https%3A%2F%2Fattacker.example%2Fx.mp4')
  assert.equal(res.statusCode, 403)
  assert.equal('access-control-allow-origin' in res.headers, false, 'CORS must stay off')
})

check('activity accepts a POST beacon', async () => {
  const res = await hit('/api/hongguo/activity', {
    method: 'POST',
    body: JSON.stringify({ playing: true, title: 'x', episode: 1 }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(JSON.parse(res.text()).ok, true)
})

check('activity rejects a GET', async () => {
  const res = await hit('/api/hongguo/activity')
  assert.equal(res.statusCode, 405)
})

check('playlist reports an empty cache as 404, not a crash', async () => {
  const res = await hit('/api/hongguo/playlist')
  assert.equal(res.statusCode, 404)
})

check('media rejects a bad episode id', async () => {
  const res = await hit('/api/hongguo/media?episode=..%2F..%2Fetc%2Fpasswd')
  assert.equal(res.statusCode, 400)
})

check('every prefix is behind the Host guard, including the newer routes', async () => {
  // The guard wraps the three registered prefixes, so a route added later is
  // covered by construction; assert it for the alternate-source routes too.
  for (const path of [
    '/api/hongguo/search?keyword=x',
    '/api/hongguo/hghub-manifest?episode=x',
    '/api/hongguo/cover?u=https%3A%2F%2Fexample.com%2Fx.jpg',
    '/api/hongguo/vendor/mpegts.js',
    '/api/hongguo/window',
  ]) {
    const res = await hit(path, { host: 'attacker.example:62408' })
    assert.equal(res.statusCode, 403, `${path} should be guarded`)
  }
})

const settled = await Promise.all(results)
let failed = 0
for (const row of settled) {
  if (row.ok) {
    console.log(`PASS  ${row.name}`)
  } else {
    failed += 1
    console.log(`FAIL  ${row.name}\n      ${row.detail}`)
  }
}
console.log(`\n${settled.length - failed}/${settled.length} passed`)
process.exit(failed === 0 ? 0 : 1)
