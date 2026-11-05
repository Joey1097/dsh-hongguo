# 黄果短剧 APK 逆向：视频列表与播放地址

对象：`downloads/hgdj22.0.0.apk`（应用名「黄果短剧」，包名 `com.hg2.two_zero_one`，
`versionName 2.0.1` / 对外版本 22.0.0）。客户端实现见 [`../sdk/huangguo`](../sdk/huangguo)。

> 本文只记录接口与算法，用于互操作性研究。内容与商标归权利人所有。

## 1. 结论速览

| 能力 | 做法 |
|---|---|
| 视频列表 | `GET /api/app/media/drama/home?moduleId=…&pageNumber=…&pageSize=…`（首页模块 + 列表）；另有 `/media/drama/feed`、`/media/search` |
| 分集 | `GET /api/app/media_content/list?mediaId=…`，每集带相对 `videoUrl` |
| 播放地址 | `https://<host>/api/app/vid/h5/m3u8/<videoUrl>?token=<token>` → HLS，AES-128 密钥在 `/api/app/vid/sec` |
| 认证 | 匿名设备登录 `POST /api/app/mine/login`（`devID` + `devToken`）换 `token` |
| 请求签名 | HMAC-SHA1，`x-api-key: timestamp=…;sign=…;nonce=…` |
| 响应加密 | `data` 为 base64：前 12 字节随机前缀 + AES-256-CBC 密文 |

## 2. 应用结构

- 纯 Flutter 应用，业务逻辑在 `lib/arm64-v8a/libapp.so`（Dart AOT，Dart 3.10.1）；
  `classes.dex` 只是 Flutter 壳，Java 层没有接口逻辑。
- 因此静态分析用 [blutter](https://github.com/worawit/blutter) 还原 Dart 符号与反汇编：

  ```sh
  unzip -q hgdj22.0.0.apk -d apk
  python3 blutter.py apk/lib/arm64-v8a out
  # out/asm/hg2/**  按源文件组织；out/pp.txt 是对象池（字符串/常量）
  ```

- 网络层源文件：
  - `package:hg2/tools_base/net/http_manager.dart`：签名（`_sign`）、请求头、baseURL
  - `package:hg2/tools_base/net/net_manager.dart`：token、`X-User-Agent`
  - `package:hg2/tools_base/net/aes_util.dart`：响应解密 `aesDecryptEx`
  - `package:hg2/tools_base/net/http_resp_interceptor.dart`：`hash` 响应解密
  - `package:hg2/hj_utils/api_service/drama_service.dart`：列表/详情/分集接口
  - `package:hg2/hj_model/video_model.dart`：拼 m3u8 地址
  - `package:hg2/track_event_manager/device_service.dart`：`devToken`

## 3. 接口主机

APK 内置三条线路（`config.dart` 的 `lineList()`）：

```
https://d2d4qit8ft25hf.cloudfront.net
https://d1seec2gw5v7ek.cloudfront.net
https://6cc2n.com
```

所有业务接口在 `线路 + /api/app + 路径`。签名里的 `path` 是**不含 `/api/app` 的接口路径**。

## 4. 请求签名

`http_manager.dart` 的 `_sign(path)`：

```text
params = {
  nonce: uuid4,
  path: path,                    // 例如 /media/drama/home
  timestamp: 秒级时间戳,
  token: 当前 token（未登录为空串）,
  userAgent: UA 字符串
}
sign = hex(HMAC-SHA1(key, jsonEncode(params)))   // JSON 无空格、键序同上
x-api-key = "timestamp=<ts>;sign=<sign>;nonce=<nonce>"
```

固定 key 在 `http_manager.dart` 中（见 `sdk/huangguo/index.js` 的 `SIGN_KEY`）。

其余请求头：

```text
api_version: 1.0.0
device: android
X-User-Agent: <UA>
Authorization: <token>
Content-Type: application/json;charset=UTF-8   (POST)
```

注意：服务端对签名校验不严格，但缺少 `Authorization` 会返回 `5005 未登录`。

## 5. 匿名设备登录

`mine_service.dart::devLogin` → `POST /mine/login`：

```json
{
  "devID": "<32 位设备 id>",
  "qrCnt": "",
  "devType": "android",
  "sysType": "android",
  "ver": "2.0.1",
  "buildID": "",
  "devToken": "<base64(sha256(q+a+k+devID+q+a+k))>",
  "cutInfos": ""
}
```

`devToken` 的三段盐在 `device_service.dart::getDevToken`，SDK 里是 `DEV_TOKEN_PARTS`。
返回值 `data` 是加密的，解密后含 `token`、`webToken`、`imToken`、`uid` 等。

登录有限流：频繁调用返回 `4007 登录过于频繁`，应持久化 `devID`/`token` 复用。

## 6. 响应解密（关键）

响应形如：

```json
{ "code": 200, "data": "<base64>", "hash": true, "msg": "成功" }
```

`hash` 为 `true` 时，`data` 需要解密。`aes_util.dart::aesDecryptEx` 的算法：

```text
raw    = base64decode(data)
prefix = raw[0:12]                 // 随机前缀（同时参与密钥派生）
body   = raw[12:]                  // AES-CBC 密文

seed = AES_SEED + prefix           // AES_SEED 为 32 字节 ASCII 常量（aes_util.dart）
h1   = sha256(seed)
h2   = sha256(h1[8:24] + seed[0:22])
h3   = sha256(seed[22:] + h1[8:24])

key = h2[0:8] + h3[8:24] + h2[24:32]      // 32 字节 → AES-256
iv  = h3[0:4] + h2[12:20] + h3[28:32]     // 16 字节
plain = AES-256-CBC-decrypt(key, iv, body) // PKCS#7
```

`AES_SEED` 见 `sdk/huangguo/index.js`。

> 复盘提示：blutter 反汇编里 `sublist` 的 **start 参数是未打标签的整数，end 参数是 Smi（×2）**。
> 按统一 Smi 去读会得出 48 字节密钥而卡住；按“start 原值、end 减半”读就与上面的切片完全吻合。

## 7. 接口清单

| 路径（前缀 `/api/app`） | 参数 | 作用 |
|---|---|---|
| `/mine/login` | POST，见上 | 匿名登录换 token |
| `/modules/list/v2` | `pageNumber,pageSize` | 首页模块（`homePage[].id/moduleName`） |
| `/media/drama/home` | `moduleId,pageNumber,pageSize` | 模块内容：`banners`、`grid.list`、`grid.hasNext` |
| `/media/drama/feed` | `pageSize` | 推荐流（`list[].media`，`hasNext`） |
| `/media/search` | `keyword,kind,pageNumber,pageSize,sortType` | 搜索；`kind=4` 真人短剧 |
| `/media/drama/topics` | — | 话题/榜单入口 |
| `/media/info` | `id` | 短剧详情 |
| `/media_content/list` | `mediaId,pageNumber,pageSize[,sortType]` | 分集列表（含 `videoUrl`、`canPlay`、`listenPermission`） |
| `/media_content/info` | `id` | 单集播放信息（新的 `videoUrl`） |
| `/vid/h5/m3u8/<videoUrl>` | `token[,c]` | HLS 播放列表 |
| `/vid/sec` | `token` | HLS AES-128 密钥（16 字节） |

列表项主要字段：`id`、`title`、`verticalCover`/`horizontalCover`（相对路径，前缀是图片 CDN，
如 `https://zzzznnn.lkkwip.cn/`）、`currentEpisode`、`totalEpisode`、`updateStatus`。

封面图不是明文：CDN 返回的图片**前 100 字节**与固定串 `2019ysapp7527` 循环异或
（`image_crypto.dart::ImageCrypto.decrypt`），100 字节之后是原始图片数据；异或后即标准 JPEG。

## 8. 播放链路

1. `media_content/list` 或 `media_content/info` 拿 `videoUrl`（相对路径，带签名参数）。
2. 拼播放列表：`https://6cc2n.com/api/app/vid/h5/m3u8/<videoUrl>?token=<token>`。
3. 返回标准 HLS：

   ```text
   #EXTM3U
   #EXT-X-KEY:METHOD=AES-128,URI="/api/app/vid/sec",IV=0x00…
   #EXTINF:7.542,
   https://<cdn>/bktappupdata/….ts?md=…&c=4002&v=919
   ```

4. 密钥：`GET /api/app/vid/sec?token=<token>` → 16 字节。
5. 分片是 CDN 绝对地址，可直接播放或下载（AES-128-CBC，IV 为 0）。

付费分集 `canPlay=false`、`listenPermission!=2`，`videoUrl` 为空；免费集通常每剧 1 集。
`price=0` / `accessType=free` 的剧则全集可播（预告、短片和少数正片，抽样约 1/3）。

## 9. 全集免费筛选

“全集免费”的判定完全靠分集列表，不需要额外接口：

```text
stats = 翻完 /media_content/list 的所有分页
fullyFree = stats.total > 0 且每一集都满足 videoUrl 非空 且 canPlay != false
```

SDK 提供 `episodeStats()` / `isFullyFree()` / `listFreeSeries()`：
后者按首页模块取候选，再以并发（默认 4）逐部检查，`limit` 命中即停、`maxScan` 限制最多扫多少部，
`onScan` 可观察进度。付费集本来就没有地址，所以这个筛选只是“找出本来就全免的剧”，
不是绕过付费墙。

## 10. 注意事项

- 线路与图片 CDN 会轮换：客户端内置三条线路，图片域名可替换；失效时换线路即可。
- token 会过期，`5005/5009` 时重新登录；登录接口限流，务必复用设备档案。
- `User-Agent` 与 `x-api-key` 中的 `userAgent` 必须一致（服务端会参与签名）。
- 图片路径需要拼接图片 CDN；封面、剧照都是相对路径。

## 11. 复现

```sh
# 依赖安装与完整客户端见 sdk/huangguo
cd sdk/huangguo
node cli.js search 寡妇
node cli.js play <mediaId> 1
```

最小请求示例（签名与解密用 SDK 里的函数）：

```js
import { Client, signRequest } from './index.js';
const client = new Client();
await client.ensureLogin();
const page = await client.discover({ pageSize: 12 });
console.log(page.items);
```
