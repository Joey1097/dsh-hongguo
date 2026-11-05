// com.hg2.two_zero_one（代号 HG2）的非官方 API 客户端。
//
// 请求：HMAC-SHA1 签名（x-api-key）；响应：AES-128-CBC（密钥/IV 由响应前 12 字节 + 固定种子
// 经三轮 SHA-256 派生）；登录：devID + devToken 换取 token。
//
// 仅用于个人学习与研究；内容版权归权利人所有。

import { createHash, createHmac, createDecipheriv, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 请求签名密钥（APK libapp.so 硬编码）。 */
const SIGN_KEY = 'kaFtkDJRcchRMTI9';

/** 响应解密种子（aes_util.dart）。 */
const AES_SEED = Buffer.from('65dc07d1b7915c6b2937432b091837a7', 'utf8');

/** devToken 的三段硬编码盐（device_service.dart）。 */
const DEV_TOKEN_PARTS = ['g24p5VJ4fJ', '5P#at%Yu', 'ZPRwQuKl8YlVIr'];

const DEFAULT_ORIGIN = 'https://6cc2n.com';
const DEFAULT_UA = 'okhttp/5.0.0';
const DEFAULT_IMAGE_BASE = 'https://zzzznnn.lkkwip.cn';

/** 搜索 kind：4 = 真人短剧。 */
export const SearchKind = Object.freeze({ ShortPlay: 4 });

export class Hg2Error extends Error {
  constructor(message, { code, payload } = {}) {
    super(message);
    this.name = 'Hg2Error';
    this.code = code;
    this.payload = payload;
  }
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest();
}

/** 解密响应中的 data 字段（base64）。 */
export function decryptPayload(base64) {
  const data = Buffer.from(base64, 'base64');
  const prefix = data.subarray(0, 12);
  const body = data.subarray(12);

  const seed = Buffer.concat([AES_SEED, prefix]); // 44 字节
  const h1 = sha256(seed);
  const h2 = sha256(Buffer.concat([h1.subarray(8, 24), seed.subarray(0, 22)]));
  const h3 = sha256(Buffer.concat([seed.subarray(22), h1.subarray(8, 24)]));

  const key = Buffer.concat([h2.subarray(0, 8), h3.subarray(8, 24), h2.subarray(24)]);
  const iv = Buffer.concat([h3.subarray(0, 4), h2.subarray(12, 20), h3.subarray(28)]);

  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** 由 devID 生成设备令牌：base64(sha256(q+a+k+devID+q+a+k))。 */
export function deviceToken(devID) {
  const [a, b, c] = DEV_TOKEN_PARTS;
  const raw = `${a}${b}${c}${devID}${a}${b}${c}`;
  return sha256(Buffer.from(raw, 'utf8')).toString('base64');
}

/** HMAC-SHA1 请求签名，写入 x-api-key。 */
export function signRequest({ path: requestPath, timestamp, nonce, token, userAgent }) {
  const payload = JSON.stringify({ nonce, path: requestPath, timestamp, token, userAgent });
  const sign = createHmac('sha1', SIGN_KEY).update(payload).digest('hex');
  return `timestamp=${timestamp};sign=${sign};nonce=${nonce}`;
}

export function defaultProfilePath() {
  const dir = process.env.HG2_CONFIG_DIR || path.join(os.homedir(), '.config', 'hg2');
  return path.join(dir, 'profile.json');
}

async function readProfile(profilePath) {
  try {
    const json = JSON.parse(await fs.readFile(profilePath, 'utf8'));
    if (json && typeof json.token === 'string') return json;
  } catch {
    /* 没有档案 */
  }
  return null;
}

async function writeProfile(profilePath, profile) {
  await fs.mkdir(path.dirname(profilePath), { recursive: true });
  await fs.writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
}

export class Client {
  constructor(options = {}) {
    this.origin = (options.origin || DEFAULT_ORIGIN).replace(/\/+$/, '');
    this.apiOrigin = `${this.origin}/api/app`;
    this.imageBase = (options.imageBase || DEFAULT_IMAGE_BASE).replace(/\/+$/, '');
    this.userAgent = options.userAgent || DEFAULT_UA;
    this.timeoutMs = options.timeoutMs ?? 20000;
    this.profilePath = options.profile || defaultProfilePath();
    this.authToken = '';
    this.devID = '';
    this._loginPromise = null;
    this._freeCache = new Map();
  }

  /** 有档案时复用 token，否则注册匿名设备并登录。 */
  async ensureLogin() {
    if (this.authToken) return this.authToken;
    if (!this._loginPromise) {
      this._loginPromise = this._ensureLogin().finally(() => {
        this._loginPromise = null;
      });
    }
    return this._loginPromise;
  }

  async _ensureLogin() {
    const saved = await readProfile(this.profilePath);
    if (saved && saved.token) {
      this.authToken = saved.token;
      this.devID = saved.devID || '';
      try {
        await this.request('/ping/checkMessageTip', { auth: true, noRetry: true });
        return this.authToken;
      } catch (error) {
        if (!(error instanceof Hg2Error) || ![5005, 5009].includes(error.code)) throw error;
        this.authToken = '';
      }
    }
    return this.login();
  }

  /** 强制新建匿名设备并登录。 */
  async login() {
    const devID = this.devID || randomUUID().replace(/-/g, '');
    const body = {
      devID,
      qrCnt: '',
      devType: 'android',
      sysType: 'android',
      ver: '2.0.1',
      buildID: '',
      devToken: deviceToken(devID),
      cutInfos: '',
    };
    const data = await this.request('/mine/login', { method: 'POST', body, auth: false });
    if (!data || typeof data !== 'object' || !data.token) {
      throw new Hg2Error('登录失败：响应中没有 token', { payload: data });
    }
    this.authToken = data.token;
    this.devID = devID;
    await writeProfile(this.profilePath, { devID, token: this.authToken });
    return this.authToken;
  }

  /**
   * 发送 API 请求。
   * @param {string} requestPath 例如 "/media/drama/home"
   * @param {{method?: string, params?: object, body?: object, auth?: boolean, noRetry?: boolean, _retried?: boolean}} options
   */
  async request(requestPath, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (options.auth !== false) await this.ensureLogin();

    const token = options.auth === false ? '' : this.authToken;
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = randomUUID();
    const url = new URL(`${this.apiOrigin}${requestPath}`);
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }

    const headers = {
      'x-api-key': signRequest({ path: requestPath, timestamp, nonce, token, userAgent: this.userAgent }),
      api_version: '1.0.0',
      device: 'android',
      'X-User-Agent': this.userAgent,
      Authorization: token,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json;charset=UTF-8';

    const response = await fetch(url, {
      method,
      headers,
      body: method === 'GET' ? undefined : JSON.stringify(options.body || {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Hg2Error(`HTTP ${response.status}`, { code: response.status });
    }
    const json = await response.json();
    if (json.hash && typeof json.data === 'string') {
      json.data = JSON.parse(decryptPayload(json.data));
    }
    if ((json.code === 5005 || json.code === 5009) && !options.noRetry && !options._retried) {
      // token 失效：清掉档案后重试一次
      this.authToken = '';
      await writeProfile(this.profilePath, { devID: this.devID, token: '' }).catch(() => {});
      await this.login();
      return this.request(requestPath, { ...options, _retried: true });
    }
    if (json.code !== 200) {
      throw new Hg2Error(json.msg || `接口错误 ${json.code}`, { code: json.code, payload: json });
    }
    return json.data;
  }

  /** 首页模块（moduleId 用于 discover）。 */
  async modules({ pageNumber = 1, pageSize = 50 } = {}) {
    const data = await this.request('/modules/list/v2', { params: { pageNumber, pageSize } });
    return data?.homePage || [];
  }

  /** 某个模块的内容（轮播 + 列表）。 */
  async discover({ moduleId, pageNumber = 1, pageSize = 20 } = {}) {
    const id = moduleId || (await this.modules())[0]?.id;
    if (!id) throw new Hg2Error('没有可用的 moduleId');
    const data = await this.request('/media/drama/home', {
      params: { moduleId: id, pageNumber, pageSize },
    });
    return {
      moduleId: data?.moduleId || id,
      banners: data?.banners || [],
      items: data?.grid?.list || [],
      hasMore: Boolean(data?.grid?.hasNext),
      pageNumber,
    };
  }

  /** 推荐流。 */
  async feed({ pageSize = 20 } = {}) {
    const data = await this.request('/media/drama/feed', { params: { pageSize } });
    return {
      queueVersion: data?.queueVersion,
      items: (data?.list || []).map((row) => row.media || row),
      hasMore: Boolean(data?.hasNext),
    };
  }

  /** 搜索短剧。kind 默认 4（真人短剧）。 */
  async search(keyword, { kind = SearchKind.ShortPlay, pageNumber = 1, pageSize = 20, sortType = 1 } = {}) {
    const data = await this.request('/media/search', {
      params: { keyword, kind, pageNumber, pageSize, sortType },
    });
    return { items: data?.list || [], hasMore: Boolean(data?.hasNext) };
  }

  /** 短剧详情。 */
  async getMedia(mediaId) {
    return this.request('/media/info', { params: { id: mediaId } });
  }

  /** 分集列表；每集自带 videoUrl（相对路径）。 */
  async listEpisodes(mediaId, { pageNumber = 1, pageSize = 50, sortType } = {}) {
    const data = await this.request('/media_content/list', {
      params: { mediaId, pageNumber, pageSize, sortType },
    });
    return { total: data?.total || 0, items: data?.list || [], hasMore: Boolean(data?.hasNext) };
  }

  /** 单集播放信息（videoUrl 每次带新签名）。 */
  async getEpisode(episodeId) {
    return this.request('/media_content/info', { params: { id: episodeId } });
  }

  /** 拼 HLS 播放列表地址。 */
  playbackURL(videoUrl, { cdn = '' } = {}) {
    const url = new URL(`${this.origin}/api/app/vid/h5/m3u8/${videoUrl}`);
    url.searchParams.set('token', this.authToken);
    if (cdn) url.searchParams.set('c', cdn);
    return url.toString();
  }

  /**
   * 解析一集的播放模型：播放列表 + AES-128 密钥 + 分片。
   * @param {string|{id?: string, videoUrl?: string}} episodeOrId 分集对象或 episode id
   */
  async resolvePlayback(episodeOrId) {
    await this.ensureLogin();
    let info = typeof episodeOrId === 'string' ? await this.getEpisode(episodeOrId) : episodeOrId;
    if (info && !info.videoUrl && info.id) info = await this.getEpisode(info.id);
    const videoUrl = info?.videoUrl;
    if (!videoUrl) {
      const paywalled = info && (info.canPlay === false || (info.listenPermission ?? 0) !== 2);
      throw new Hg2Error(paywalled ? '这一集需要购买或会员才能播放' : '这一集没有可播放地址', {
        code: paywalled ? 'PAY_REQUIRED' : 'NO_VIDEO',
        payload: info,
      });
    }
    const playlistURL = this.playbackURL(videoUrl);
    const response = await fetch(playlistURL, {
      headers: { 'User-Agent': this.userAgent },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new Hg2Error(`播放列表 HTTP ${response.status}`, { code: response.status });
    const playlist = await response.text();
    const keyMatch = playlist.match(/#EXT-X-KEY:.*URI="([^"]+)"/);
    const segments = playlist
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));

    const keyURL = keyMatch ? new URL(keyMatch[1], `${this.origin}/`).toString() : null;
    let key = null;
    if (keyURL) {
      const keyResponse = await fetch(keyURL, {
        headers: { 'User-Agent': this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (keyResponse.ok) key = Buffer.from(await keyResponse.arrayBuffer()).toString('hex');
    }

    return {
      episodeId: info.id,
      mediaId: info.mediaId,
      episodeNumber: info.episodeNumber,
      durationSeconds: info.playTime,
      videoUrl,
      playlistURL,
      keyURL,
      key,
      segments,
    };
  }


  /** 一部剧的分集统计（会翻完所有分页）。 */
  async episodeStats(mediaId, { pageSize = 200, maxPages = 10 } = {}) {
    const items = [];
    let pageNumber = 1;
    let hasMore = true;
    while (hasMore && pageNumber <= maxPages) {
      const page = await this.listEpisodes(mediaId, { pageNumber, pageSize });
      items.push(...page.items);
      hasMore = Boolean(page.hasMore) && page.items.length > 0;
      pageNumber += 1;
    }
    const playable = items.filter((episode) => episode.videoUrl && episode.canPlay !== false);
    return {
      mediaId,
      total: items.length,
      free: playable.length,
      paid: items.length - playable.length,
      fullyFree: items.length > 0 && playable.length === items.length,
      items,
    };
  }

  /** 是否全集免费（结果按 client 缓存）。 */
  async isFullyFree(mediaId, options) {
    if (this._freeCache.has(mediaId)) return this._freeCache.get(mediaId);
    const stats = await this.episodeStats(mediaId, options);
    this._freeCache.set(mediaId, stats.fullyFree);
    return stats.fullyFree;
  }

  /**
   * 从首页模块里筛出“全集免费”的剧。
   * @param {{moduleIds?: string[], pages?: number, pageSize?: number, limit?: number, maxScan?: number, concurrency?: number, refresh?: boolean, onScan?: Function}} options
   */
  async listFreeSeries(options = {}) {
    const {
      moduleIds,
      pages = 1,
      pageSize = 20,
      limit = 20,
      maxScan = 200,
      concurrency = 4,
      refresh = false,
      onScan,
    } = options;

    if (refresh) this._freeCache.clear();

    const modules = moduleIds?.length ? moduleIds.map((id) => ({ id })) : await this.modules();
    const candidates = new Map();
    let lastError;
    for (const module of modules) {
      for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
        let page;
        try {
          page = await this.discover({ moduleId: module.id, pageNumber, pageSize });
        } catch (error) {
          lastError = error; // 该模块没有内容，或 token/限流问题
          break;
        }
        for (const item of page.items) {
          if (item?.id && !candidates.has(item.id)) candidates.set(item.id, item);
        }
        if (!page.hasMore) break;
      }
    }

    if (!candidates.size && lastError) throw lastError;
    // 集数少的更可能是全免（预告、短片），先扫它们更省请求
    const queue = [...candidates.values()]
      .sort((a, b) => (a.totalEpisode ?? 999) - (b.totalEpisode ?? 999))
      .slice(0, maxScan);
    const found = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length && found.length < limit) {
        const item = queue[cursor];
        cursor += 1;
        try {
          const stats = await this.episodeStats(item.id);
          onScan?.(item, stats);
          if (stats.fullyFree && found.length < limit) {
            found.push({ ...item, totalEpisodes: stats.total, freeEpisodes: stats.free });
          }
        } catch (error) {
          onScan?.(item, { error });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    found.sort((a, b) => b.totalEpisodes - a.totalEpisodes);
    return { items: found.slice(0, limit), scanned: cursor, candidates: queue.length };
  }

  /** 相对封面路径转完整地址。 */
  coverURL(relativePath) {
    if (!relativePath) return '';
    if (/^https?:\/\//i.test(relativePath)) return relativePath;
    return `${this.imageBase}/${relativePath.replace(/^\/+/, '')}`;
  }
}

export async function createClient(options) {
  const client = new Client(options);
  await client.ensureLogin();
  return client;
}

export default createClient;
