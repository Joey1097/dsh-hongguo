/**
 * End-to-end check for the decrypted-media path after the transcode semaphore
 * and the play-model host validation were added.
 *
 * It drives the real routes through the real SDK and the real ffmpeg, so it
 * needs the network and the local ffmpeg binary. It removes the episode it
 * caches so the plugin data directory is left as it was.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { apply } from '../index.js'

const ORIGIN = 'http://127.0.0.1:62408'
const routes = []
const webServer = {
  getOrigin: () => ORIGIN,
  register: (route) => {
    routes.push(route)
    return () => {}
  },
}
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
  inject: (deps, callback) => callback({ webServer }),
  get: () => undefined,
}

apply(ctx, {})
await new Promise((resolve) => setTimeout(resolve, 50))

function route(url) {
  const path = new URL(url, ORIGIN).pathname
  const found = routes
    .filter((candidate) => path.startsWith(candidate.path))
    .sort((a, b) => b.path.length - a.path.length)[0]
  assert.ok(found, `no route for ${path}`)
  return found
}

async function getJson(url) {
  const res = { statusCode: 200, headers: {}, chunks: [], headersSent: false }
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = String(v)
  }
  res.write = (chunk) => {
    res.chunks.push(Buffer.from(chunk))
    res.headersSent = true
  }
  res.end = (body) => {
    if (body !== undefined) res.chunks.push(Buffer.from(String(body)))
    res.headersSent = true
  }
  await route(url).handler({ url, method: 'GET', headers: { host: '127.0.0.1:62408' } }, res)
  const text = Buffer.concat(res.chunks).toString('utf8')
  assert.equal(res.statusCode, 200, `${url} -> ${res.statusCode} ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

/** A request stub with the emitter surface the media route binds to. */
function makeRequest(url) {
  const req = new EventEmitter()
  req.url = url
  req.method = 'GET'
  req.headers = { host: '127.0.0.1:62408' }
  return req
}

async function getBytes(url) {
  const chunks = []
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  res.statusCode = 200
  res.headers = {}
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = String(v)
  }
  await route(url).handler(makeRequest(url), res)
  await finished(res)
  return { statusCode: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }
}

const feed = await getJson('/api/hongguo/feed')
assert.ok(feed.items?.length > 0, 'feed should return items')
const seriesId = feed.items[0].id

const series = await getJson(`/api/hongguo/series?id=${seriesId}`)
assert.ok(series.episodes?.length > 0, 'series should return episodes')
const episodeId = series.episodes[0].id

const play = await getJson(`/api/hongguo/play?episode=${episodeId}&series=${seriesId}`)
assert.ok(play.sources?.length > 0, 'play should return sources')
const source = play.sources[0]
console.log(`episode ${episodeId} -> ${source.kind} ${source.url}`)

// Same resolution the Host uses, so a custom data root is cleaned correctly.
const dataRoot = process.env.DSH_PLUGIN_DATA_DIR
  ? join(process.env.DSH_PLUGIN_DATA_DIR, 'dsh-hongguo')
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugin-data', 'dsh-hongguo')
const cache = join(dataRoot, 'media', `${episodeId}.mp4`)
// Never delete an episode the user already had cached before this run.
const existedBefore = existsSync(cache)

const media = await getBytes(source.url)
assert.equal(media.statusCode, 200, `media -> ${media.statusCode}`)
assert.equal(media.headers['content-type'], 'video/mp4')
assert.ok(media.bytes.length > 100_000, `expected a real episode, got ${media.bytes.length} bytes`)
// MP4 signature: a 4-byte box size then `ftyp` at offset 4.
assert.equal(media.bytes.subarray(4, 8).toString('latin1'), 'ftyp', 'decrypted file should be an MP4')
console.log(`decrypted ${(media.bytes.length / 1024 / 1024).toFixed(2)} MB, ftyp OK`)

if (!existedBefore && existsSync(cache)) {
  await rm(cache, { force: true })
  console.log('removed the cached episode written by this check')
} else if (existedBefore) {
  console.log('left the pre-existing cache entry untouched')
}
console.log('\nmedia path OK')
